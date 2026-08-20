import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { looksCallerControlled, isFunctionLike, findAncestor } from "../../core/ast.ts";
import { collectDescendants, findDescendant } from "../../core/walk.ts";

/**
 * Prototype pollution — a write that reaches `Object.prototype`.
 *
 * THE PREMISE THIS RULE USED TO GET WRONG. A single-level computed write cannot
 * pollute anything. Run it:
 *
 *   const o = {}; o["__proto__"] = { polluted: 1 };
 *   ({}).polluted   // undefined — `o` was merely re-parented
 *
 *   const b = {}; b["__proto__"]["p2"] = 42;
 *   ({}).p2         // 42 — THIS is the vulnerability
 *
 * `obj[key] = value` with an attacker-chosen `key` sets an own property on `obj`.
 * If the key happens to be `__proto__` the assignment goes through the setter and
 * changes `obj`'s prototype — it does not add anything to `Object.prototype`, and
 * every other object in the process is unaffected.
 *
 * Flagging that shape was the rule's entire output. A hand-audit of all 76
 * findings in one backend found **1 true positive and 75 false**, and the rule
 * was more than half of every Security finding in that project. The three
 * dominant false classes were a group-by accumulator keyed on a database row
 * field (45), an array element written at a `findIndex` result (7), and a key
 * normalised to one of a few string literals (6) — none of which can pollute
 * anything even if the key were `__proto__`.
 *
 * So the rule now fires only where the write can actually reach the prototype.
 *
 * CLAUSE 1 — THE RECURSIVE MERGE GADGET. A function taking two objects, walking
 * the source's keys, writing `target[k]`, and recursing into `(target[k],
 * source[k])`. This is the shape behind essentially every prototype-pollution
 * CVE (lodash.merge, deep-extend, merge-deep), because the recursion supplies the
 * second level the single write lacks. Verified by running the corpus's own
 * `_deepMergeInto` against `{"__proto__":{"pp_polluted":"yes"}}`: `({}).pp_polluted`
 * became `"yes"`. Not gated on taint — a merge helper is a gadget wherever its
 * input eventually comes from.
 *
 * CLAUSE 2 — AN ESCALATING WRITE. A computed, caller-controlled key with AT LEAST
 * ONE FURTHER member link after it: `obj[key].sub = v`, `obj[key][k2] = v`. The
 * "at least one further link" is exact rather than "two or more links total",
 * which readmits `a.b[k] = v` — still a single-level write, still inert.
 *
 * CLAUSE 2b — THE WALKED POINTER. `base[k] = v` IS dangerous when `base` is
 * itself reassigned from `base = base[...]` somewhere — the `lodash.set` /
 * `dot-prop` / `set-value` CVE shape, where the loop supplies the depth:
 *
 *   let node = obj;
 *   for (const seg of path.slice(0, -1)) node = node[seg];   // walks into __proto__
 *   node[path[path.length - 1]] = value;                     // pollutes
 *
 * This clause exists because an adversarial review found that narrowing to
 * escalating writes alone would silence that entire CVE class.
 *
 * CLAUSE 3 — A DELIBERATE LITERAL SINK. Only a COMPUTED `obj["__proto__"] = v`,
 * or a chain through `constructor.prototype`. Non-computed `obj.__proto__ = x` is
 * the ordinary way to set a prototype and is not reported; `prototype` alone is
 * dropped from the dangerous set, because `Foo.prototype = {...}` is how
 * pre-class JavaScript defines methods.
 */

/** Keys that reach the prototype chain when written through. */
const PROTO_KEYS = new Set(["__proto__", "constructor"]);

/** Iteration forms a merge helper uses to walk the source object. */
const KEY_ITERATORS = new Set(["keys", "values", "entries"]);

/** The static string key of a member expression, if any. */
const literalKey = (member: AstNode): string | null => {
  const property = member.property as AstNode | undefined;
  if (!member.computed && property?.type === "Identifier") return String(property.name);
  if (property?.type === "Literal" && typeof property.value === "string") return property.value;
  return null;
};

/** The name a function is known by — `id`, or the property/variable it is bound to. */
const functionName = (fn: AstNode): string | null => {
  const id = fn.id as AstNode | undefined;
  if (id?.type === "Identifier") return String(id.name);
  const parent = fn.parent as AstNode | undefined;
  if (!parent) return null;
  // `const merge = (t, s) => …`, `{ merge(t, s) {} }`, `class X { merge(t, s) {} }`
  const key = (parent.id ?? parent.key) as AstNode | undefined;
  if (key?.type === "Identifier") return String(key.name);
  return null;
};

/**
 * Does this function look like a recursive deep-merge gadget?
 *
 * The name is resolved through `MethodDefinition`/`Property`/`VariableDeclarator`
 * as well as `fn.id`, because the corpus's only real instance is a class method
 * and a naive `fn.id` check finds nothing.
 */
const isRecursiveMergeGadget = (fn: AstNode): boolean => {
  const params = (fn.params as AstNode[] | undefined) ?? [];
  if (params.length < 2) return false;
  const body = fn.body as AstNode | undefined;
  if (!body) return false;

  const name = functionName(fn);
  if (name === null) return false;

  // It must walk a source object's keys …
  const walksKeys =
    findDescendant(
      body,
      (n) => {
        if (n.type === "ForInStatement") return true;
        if (n.type !== "CallExpression") return false;
        const callee = n.callee as AstNode | undefined;
        if (callee?.type !== "MemberExpression") return false;
        const object = callee.object as AstNode | undefined;
        const property = callee.property as AstNode | undefined;
        return (
          object?.type === "Identifier" &&
          String(object.name) === "Object" &&
          property?.type === "Identifier" &&
          KEY_ITERATORS.has(String(property.name))
        );
      },
      () => false,
    ) !== null;
  if (!walksKeys) return false;

  // … write a computed key into the target …
  const writesComputed =
    findDescendant(
      body,
      (n) =>
        n.type === "AssignmentExpression" &&
        (n.left as AstNode | undefined)?.type === "MemberExpression" &&
        (n.left as AstNode).computed === true,
      () => false,
    ) !== null;
  if (!writesComputed) return false;

  // … and recurse into COMPUTED READS OF BOTH PARAMETERS. That last requirement
  // is the whole discriminator, and without it the clause is unusable.
  //
  //   this._deepMergeInto(tv, sv)   // tv = target[key], sv = source[key]  → MERGE
  //   walk(value, k)                // value = holder[key], k is a KEY      → not
  //
  // The second is `json2.js`'s JSON reviver, which is recursive, walks keys, and
  // writes computed keys — every surface trait of a merge. Requiring the recursion
  // to descend into two different parameters at once separates them, and it is
  // exactly what supplies the depth an attacker needs. Measured: this removed 72
  // library-internal findings (json2's `walk`, TinyMCE, a search helper) while
  // keeping the corpus's one real gadget.
  const parameterNames = new Set(
    params.map((p) => (p.type === "Identifier" ? String(p.name) : null)).filter((n): n is string => n !== null),
  );

  /** Which parameter does this argument read a computed member of, if any? */
  const descendsFrom = (arg: AstNode | undefined, depth = 0): string | null => {
    if (!arg || depth > 2) return null;
    if (arg.type === "MemberExpression" && arg.computed === true) {
      const object = arg.object as AstNode | undefined;
      if (object?.type === "Identifier" && parameterNames.has(String(object.name))) return String(object.name);
      return null;
    }
    // `const tv = target[key]` — one hop through a local binding.
    if (arg.type === "Identifier") {
      const declarator = findDescendant(
        body,
        (n) =>
          n.type === "VariableDeclarator" &&
          (n.id as AstNode | undefined)?.type === "Identifier" &&
          String(((n.id as AstNode).name)) === String(arg.name),
        () => false,
      );
      return declarator ? descendsFrom(declarator.init as AstNode | undefined, depth + 1) : null;
    }
    return null;
  };

  return (
    findDescendant(
      body,
      (n) => {
        if (n.type !== "CallExpression") return false;
        const callee = n.callee as AstNode | undefined;
        const selfCall =
          (callee?.type === "Identifier" && String(callee.name) === name) ||
          (callee?.type === "MemberExpression" &&
            (callee.property as AstNode | undefined)?.type === "Identifier" &&
            String((callee.property as AstNode).name) === name);
        if (!selfCall) return false;
        const sources = new Set(
          ((n.arguments as AstNode[] | undefined) ?? [])
            .map((a) => descendsFrom(a))
            .filter((v): v is string => v !== null),
        );
        // Two DIFFERENT parameters, both descended into — a merge, not a walk.
        return sources.size >= 2;
      },
      () => false,
    ) !== null
  );
};

/**
 * Is `name` ever reassigned from a computed read of itself — `node = node[seg]`?
 * That loop is what turns a single-level write into an arbitrarily deep one.
 */
const isWalkedPointer = (name: string, fn: AstNode): boolean =>
  collectDescendants(fn, (n) => n.type === "AssignmentExpression").some((assignment) => {
    const left = assignment.left as AstNode | undefined;
    if (left?.type !== "Identifier" || String(left.name) !== name) return false;
    const right = assignment.right as AstNode | undefined;
    return (
      right?.type === "MemberExpression" &&
      right.computed === true &&
      (right.object as AstNode | undefined)?.type === "Identifier" &&
      String((right.object as AstNode).name) === name
    );
  });


/** Calls whose result is a number, so the key can never be the string `__proto__`. */
const NUMERIC_CALLS = new Set([
  "findIndex", "indexOf", "findLastIndex", "lastIndexOf", "parseInt", "parseFloat", "Number",
  "min", "max", "floor", "ceil", "round", "abs", "length",
]);

/** Is this expression provably a NUMBER rather than a string? */
const isNumericExpression = (node: AstNode | null | undefined, depth = 0): boolean => {
  if (!node || depth > 3) return false;
  if (node.type === "Literal") return typeof node.value === "number";
  if (node.type === "UpdateExpression") return true; // i++ / --i
  if (node.type === "BinaryExpression") {
    // `a - 1`, `a * 2`, `a / n`, `a % n` all coerce to a number. `+` does NOT —
    // string concatenation is exactly how a `__proto__` key gets built.
    return ["-", "*", "/", "%", "**"].includes(String(node.operator));
  }
  if (node.type === "CallExpression") {
    const callee = node.callee as AstNode | undefined;
    const name =
      callee?.type === "Identifier"
        ? String(callee.name)
        : callee?.type === "MemberExpression" && (callee.property as AstNode | undefined)?.type === "Identifier"
          ? String((callee.property as AstNode).name)
          : null;
    return name !== null && NUMERIC_CALLS.has(name);
  }
  return false;
};

export const noPrototypePollution = defineDiagnostic({
  id: "no-prototype-pollution",
  title: "Prototype pollution via caller-controlled object key",
  severity: "error",
  category: "Security",
  confidence: "high",
  tags: ["injection", "prototype-pollution"],
  recommendation:
    "Reject the dangerous keys before the write (`if (key === '__proto__' || key === 'constructor') continue;`), use a `Map`, or build on `Object.create(null)`. A single `obj[key] = value` is harmless on its own — what reaches `Object.prototype` is writing THROUGH such a key, which is why deep-merge and path-setter helpers are the classic sinks.",
  create: (ctx) => {
    /** Report a merge gadget wherever the function is spelled. */
    const checkGadget = (node: AstNode): void => {
      if (isRecursiveMergeGadget(node)) {
        ctx.report(
          node,
          "This is the recursive deep-merge shape behind most prototype-pollution CVEs: it walks a source object's keys and recurses into `target[key]`, so a `__proto__` key in the input reaches `Object.prototype` — the recursion supplies the second level a single write lacks. Skip `__proto__` and `constructor` while iterating, or merge onto `Object.create(null)`.",
        );
      }
    };

    return {
      // A merge helper is as often a class method or an arrow as a declaration,
      // and the corpus's only real instance is a class method — a `fn.id`-only
      // check finds nothing.
      FunctionDeclaration: checkGadget,
      FunctionExpression: checkGadget,
      ArrowFunctionExpression: checkGadget,

      AssignmentExpression: (node) => {
        const left = node.left as AstNode | undefined;
        if (!left || left.type !== "MemberExpression") return;

        // The assignment's `left` is the OUTERMOST member, so the computed link
        // has to be found by walking down the chain — `target[k].sub` presents as
        // a non-computed `.sub` whose object is the computed link that matters.
        const chain: AstNode[] = [];
        let link: AstNode | undefined = left;
        while (link?.type === "MemberExpression") {
          chain.push(link);
          link = link.object as AstNode | undefined;
        }

        for (let index = 0; index < chain.length; index++) {
          const member = chain[index]!;
          if (member.computed !== true) continue;
          const property = member.property as AstNode | undefined;
          if (!property) continue;

          // CLAUSE 3 — a deliberate, computed write to a prototype-chain key.
          const key = literalKey(member);
          if (key !== null && PROTO_KEYS.has(key)) {
            ctx.report(member, `Writing \`${key}\` through a computed key is a deliberate prototype-chain write.`);
            return;
          }
          if (property.type === "Literal") continue;
          if (!looksCallerControlled(property, ctx.taintedBindings)) continue;

          // A NUMBER CAN NEVER BE THE STRING `__proto__`. Array element writes
          // and loop-counter indexing are the largest remaining class —
          // `return_data.kot_items[counter]["it_id"] = x` and
          // `slabs[findIndex(...)] = …` are escalating writes by shape but cannot
          // reach the prototype under any input. Note `+` is deliberately absent
          // from the numeric operators: string concatenation is exactly how a
          // `__proto__` key gets assembled.
          if (isNumericExpression(property)) continue;
          if (property.type === "Identifier") {
            const binding = ctx.scope.getBinding(String(property.name), property);
            if (binding && isNumericExpression(binding.initNode as AstNode | undefined)) continue;
          }

          // CLAUSE 2 — a further member link follows this computed one, so the
          // write lands BELOW the prototype rather than on the object itself.
          // `index > 0` is exactly that: something in the chain wraps it.
          if (index > 0) {
            ctx.report(
              member,
              "A caller-controlled key is written THROUGH, not just to — so a key of `__proto__` or `constructor` reaches `Object.prototype` and every object in the process. Reject those keys, use a `Map`, or build on `Object.create(null)`.",
            );
            return;
          }

          // CLAUSE 2b — or the base is a pointer the surrounding loop walks
          // deeper, which is the lodash.set / dot-prop CVE shape.
          const base = member.object as AstNode | undefined;
          if (base?.type === "Identifier") {
            const fn = findAncestor(node, isFunctionLike);
            if (fn && isWalkedPointer(String(base.name), fn)) {
              ctx.report(
                member,
                "This writes through a pointer the surrounding code walks with `node = node[…]`, so a `__proto__` segment in the path reaches `Object.prototype` — the `lodash.set`/`dot-prop` vulnerability shape. Reject `__proto__` and `constructor` segments before walking.",
              );
              return;
            }
          }
        }
      },
    };
  },
});
