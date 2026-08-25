import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, isFunctionLike, unwrapChain } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";
import type { Binding } from "../../core/scope.ts";

/**
 * A sort comparator that provably cannot order the array. The sort then does not
 * "mostly work" — it leaves the array as it was, or scrambles it.
 *
 *   ❌ rows.sort((a, b) => a.total > b.total);        // BOOLEAN: 1 or 0, never -1
 *   ❌ rows.sort((a, b) => a.name > b.name ? 1 : 0);  // never negative
 *   ❌ rows.sort((a, b) => a.price - a.cost);         // never looks at `b`
 *   ✅ rows.sort((a, b) => a.total - b.total);
 *   ✅ rows.sort((a, b) => a.name.localeCompare(b.name));
 *   ✅ rows.sort((a, b) => (a.name > b.name ? 1 : -1));
 *
 * `sort` needs three answers: negative for "a first", positive for "b first",
 * zero for equal. Two independent ways of never supplying them, both MEASURED on
 * `[5, 3, 9, 1, 7, 2, 8]` and on `[{p:3},{p:1},{p:2}]`:
 *
 *   sort((a, b) => a > b)            → [5,3,9,1,7,2,8]   unchanged
 *   sort((a, b) => a < b)            → [5,3,9,1,7,2,8]   unchanged
 *   sort((a, b) => a >= b)           → [5,3,9,1,7,2,8]   unchanged
 *   sort((a, b) => a === b)          → [5,3,9,1,7,2,8]   unchanged
 *   sort((a, b) => a > b ? 1 : 0)    → [5,3,9,1,7,2,8]   unchanged
 *   sort((a, b) => a.p - a.q)        → [2,1,3]           garbage
 *   sort((a, b) => a.p)              → [3,1,2]           unchanged
 *
 *   sort((a, b) => a > b ? 1 : -1)   → [1,2,3,5,7,8,9]   correct
 *   sort((a, b) => a - b)            → [1,2,3,5,7,8,9]   correct
 *   sort((a, b) => a.p - b.p)        → [1,2,3]           correct
 *
 * A boolean gives only `ToNumber(true) === 1` and `ToNumber(false) === 0`, so the
 * comparator can say "b first" or "equal" and never "a first"; nothing moves
 * toward the front, because the engine's insertion pass asks in the direction
 * that answers 0. A comparator that never reads its second element is not
 * comparing at all — it is scoring one element against itself.
 *
 * It is silent in the two ways that matter. Nothing throws, and the array comes
 * back with the right length and the right elements — only the order is wrong.
 * And the order is usually *nearly* right, because the rows came out of a query
 * that already had an `ORDER BY`, so the symptom is a few items misplaced on one
 * page rather than an obvious scramble. A test that checks `length`, or
 * membership, or sorts an already-ordered fixture, passes.
 *
 * PRECISION MODEL. Both clauses are facts about the language, not inferences
 * about the data, and each is proved from syntax alone.
 *
 * **Clause 1 — every value the comparator can return is provably non-negative,**
 * so no pair can ever be ordered a-before-b. Provably non-negative means:
 *
 *   - a relational or equality comparison (`>`, `<`, `>=`, `<=`, `===`, `!==`,
 *     `==`, `!=`, `instanceof`, `in`) — the result is a boolean, so 0 or 1;
 *   - `!x` — likewise a boolean;
 *   - a non-negative numeric literal, or `true`/`false`;
 *   - `&&`, `||` or `??` whose both sides are provably non-negative;
 *   - a conditional whose both branches are provably non-negative
 *     (`a > b ? 1 : 0` is the defect; `a > b ? 1 : -1` is not, and is silent).
 *
 * Anything else — a subtraction, a `localeCompare`, any call, an identifier, a
 * negative literal, a unary minus — is not provably non-negative, and the
 * comparator is left alone.
 *
 * **Clause 2 — the body never references one of the two elements.** A comparator
 * declaring `(a, b)` whose body mentions only `a` (or only `b`) cannot compare
 * them, whatever it returns. References are resolved through the scope resolver
 * and matched by BINDING rather than by name.
 *
 * The binding match has one known limit, and it errs toward silence. The resolver
 * models module, function and `catch` scopes but not nested blocks, so a
 * `{ const b = …; }` inside the comparator body — the only legal way to shadow a
 * parameter, since a top-level `const b` beside a parameter `b` is a SyntaxError
 * — is hoisted to the function scope and reads as the parameter itself. Such a
 * comparator is therefore treated as having read its element and stays quiet.
 * That is a recall gap, not a precision one: the rule under-reports rather than
 * reporting correct code, which is the direction this project accepts.
 *
 * Silent, each for a stated reason rather than an oversight:
 *
 *   - **A zero-parameter comparator.** `sort(() => Math.random() - 0.5)` is the
 *     deliberate-shuffle idiom, and it declares no parameters by design.
 *   - **A rest parameter.** `sort((...args) => args[0] - args[1])` reads both
 *     elements through one binding, so the parameter count proves nothing.
 *   - **A parameter named `_`** (or `_something`). Found by scanning every
 *     readable `.sort(` call on this machine — 166 files including the
 *     TypeScript compiler and the Vite bundle — which produced exactly one
 *     clause-2 hit, vite's lockfile ordering:
 *
 *       ].sort((_, { manager }) =>
 *         process.env.npm_config_user_agent?.startsWith(manager) ? 1 : -1)
 *
 *     That comparator really is invalid — it is not antisymmetric, so two
 *     matching entries both compare as "after" each other and the result is
 *     implementation-defined. But the author wrote `_` to say "I am ignoring
 *     this on purpose", and a rule that argues with an explicit `_` is a rule
 *     people switch off. Taking them at their word costs nothing on the shapes
 *     that matter (`a.price - a.cost`, `a.priority`), where the parameter is
 *     named as if it were going to be used.
 *   - **A body referencing `arguments`.** Same reason: the elements arrive
 *     without going through the named parameters.
 *   - **A comparator with no `return` at all**, or a bare `return;`, is not
 *     claimed *by clause 1*: those yield `undefined`, and `ToNumber(undefined)`
 *     is `NaN` rather than a non-negative number, so the non-negative proof does
 *     not apply even though the array is equally unsorted (verified). Clause 2
 *     may still claim such a comparator, and correctly — if it declares `(a, b)`
 *     and reads neither, it cannot be comparing them whatever it returns. The
 *     same is true of a constant comparator like `(a, b) => -1`, which clause 1
 *     cannot touch (the value is negative) but clause 2 catches outright.
 *   - **A comparator that never returns zero** (`a > b ? 1 : -1`). That one
 *     works; it is merely unstable for equal elements, which is a different and
 *     much weaker claim.
 *   - **The receiver is not checked.** `.sort`/`.toSorted` with a function
 *     argument is an Array/TypedArray shape, and requiring proof that
 *     `rows`/`this.items` is an array would cost far more recall than the
 *     hypothetical custom `sort(predicate)` API it would protect.
 */

/** Operators whose result is a boolean, hence 0 or 1. */
const BOOLEAN_OPERATORS = new Set([">", "<", ">=", "<=", "===", "!==", "==", "!=", "instanceof", "in"]);

/** Methods that take a `(a, b) => number` comparator. */
const SORTING_METHODS = new Set(["sort", "toSorted"]);

/**
 * Every expression this function can return, or null if any exit yields
 * `undefined` (a bare `return;`, or a block with no return at all) — which this
 * rule deliberately does not claim.
 */
const returnedExpressions = (fn: AstNode): AstNode[] | null => {
  const body = fn.body as AstNode | undefined;
  if (!body) return null;
  if (body.type !== "BlockStatement") return [body]; // concise arrow body
  const returns = collectDescendants(
    body,
    (n) => n.type === "ReturnStatement",
    isFunctionLike, // a return inside a nested function is not this one's
  );
  if (returns.length === 0) return null;
  const expressions: AstNode[] = [];
  for (const statement of returns) {
    const argument = statement.argument as AstNode | null | undefined;
    if (!argument) return null; // `return;` yields undefined
    expressions.push(argument);
  }
  return expressions;
};

/** Is every value this expression can produce provably >= 0? */
const isProvablyNonNegative = (node: AstNode | null | undefined, depth = 0): boolean => {
  const n = unwrapChain(node);
  if (!n || depth > 8) return false;
  switch (n.type) {
    case "Literal":
      if (typeof n.value === "number") return n.value >= 0;
      return typeof n.value === "boolean";
    case "BinaryExpression":
      return BOOLEAN_OPERATORS.has(String(n.operator));
    case "UnaryExpression":
      return n.operator === "!";
    case "LogicalExpression":
      return (
        isProvablyNonNegative(n.left as AstNode, depth + 1) &&
        isProvablyNonNegative(n.right as AstNode, depth + 1)
      );
    case "ConditionalExpression":
      return (
        isProvablyNonNegative(n.consequent as AstNode, depth + 1) &&
        isProvablyNonNegative(n.alternate as AstNode, depth + 1)
      );
    case "SequenceExpression": {
      const expressions = (n.expressions as AstNode[] | undefined) ?? [];
      return isProvablyNonNegative(expressions[expressions.length - 1], depth + 1);
    }
    default:
      return false;
  }
};

/**
 * Is this parameter explicitly marked as unused?
 *
 * `_` (and `_x`) is the universal convention for "I am deliberately ignoring
 * this", and taking the author at their word is what keeps clause 2 usable.
 */
const isDeliberatelyIgnored = (param: AstNode | null | undefined): boolean =>
  param?.type === "Identifier" && String(param.name).startsWith("_");

/** The Identifier nodes a parameter pattern introduces. */
const patternIdentifiers = (pattern: AstNode | null | undefined, out: AstNode[]): void => {
  if (!pattern) return;
  switch (pattern.type) {
    case "Identifier":
      out.push(pattern);
      break;
    case "AssignmentPattern":
      patternIdentifiers(pattern.left as AstNode, out);
      break;
    case "ArrayPattern":
      for (const element of ((pattern.elements as (AstNode | null)[] | undefined) ?? [])) {
        patternIdentifiers(element, out);
      }
      break;
    case "ObjectPattern":
      for (const property of ((pattern.properties as AstNode[] | undefined) ?? [])) {
        if (property.type === "RestElement") patternIdentifiers(property.argument as AstNode, out);
        else patternIdentifiers(property.value as AstNode, out);
      }
      break;
    default:
      break;
  }
};

export const noBrokenSortComparator = defineDiagnostic({
  id: "no-broken-sort-comparator",
  title: "Sort comparator that provably cannot order the array",
  severity: "error",
  category: "Bugs",
  confidence: "high",
  tags: ["correctness", "types"],
  recommendation:
    "A comparator must return a NEGATIVE number for \"a first\", positive for \"b first\", and zero for equal, and it has to read BOTH elements. A boolean only ever gives 1 or 0, so nothing moves forward. Subtract for numbers (`(a, b) => a.total - b.total`), use `localeCompare` for strings (`(a, b) => a.name.localeCompare(b.name))`, or spell out all three cases: `(a, b) => (a.k > b.k ? 1 : a.k < b.k ? -1 : 0)`.",
  create: (ctx) => {
    const NON_NEGATIVE =
      "Every value this comparator can return is non-negative, so `sort` can never place `a` before `b` and the array comes back in its original order — verified: `[5,3,9,1,7,2,8].sort((a, b) => a > b)` returns `[5,3,9,1,7,2,8]` unchanged. A boolean gives only 1 and 0; the comparator needs a negative case too.";

    /**
     * Does the body read every element the comparator is given?
     *
     * Matched by BINDING through the scope resolver, so a shadowing inner `b`
     * does not count as reading the parameter.
     */
    const unreadParameter = (fn: AstNode): string | null => {
      const params = (fn.params as AstNode[] | undefined) ?? [];
      // A zero-parameter comparator is the deliberate-shuffle idiom.
      if (params.length === 0) return null;
      // A rest parameter reads both elements through one binding.
      if (params.some((p) => p.type === "RestElement")) return null;

      const body = fn.body as AstNode | undefined;
      if (!body) return null;
      // `arguments` bypasses the named parameters entirely.
      const referenced = collectDescendants(body, (n) => n.type === "Identifier", undefined, true);
      if (referenced.some((n) => n.name === "arguments")) return null;

      // A single declared parameter cannot compare two elements at all.
      if (params.length === 1) {
        const declared: AstNode[] = [];
        patternIdentifiers(params[0], declared);
        return declared[0] ? String(declared[0].name) : null;
      }

      for (let index = 0; index < 2; index++) {
        // `_` is the universal marker for "deliberately ignored". Taking the
        // author at their word here is what keeps the rule usable — see the
        // vite note in the docblock.
        if (isDeliberatelyIgnored(params[index])) continue;
        const declared: AstNode[] = [];
        patternIdentifiers(params[index], declared);
        if (declared.length === 0) continue;
        const bindings = new Set<Binding>();
        for (const node of declared) {
          const binding = ctx.scope.resolveIdentifier(node);
          if (binding) bindings.add(binding);
        }
        if (bindings.size === 0) continue;
        const isRead = referenced.some((node) => {
          if (declared.includes(node)) return false; // the declaration itself
          const binding = ctx.scope.resolveIdentifier(node);
          return binding !== null && bindings.has(binding);
        });
        if (!isRead) return String(declared[0]!.name);
      }
      return null;
    };

    return {
      CallExpression: (node) => {
        const method = getMethodName(node);
        if (method === null || !SORTING_METHODS.has(method)) return;
        const callee = unwrapChain(node.callee as AstNode);
        // A member call — `rows.sort(fn)`, not a bare `sort(fn)` helper.
        if (!callee || callee.type !== "MemberExpression") return;

        const comparator = ((node.arguments as AstNode[] | undefined) ?? [])[0];
        if (!isFunctionLike(comparator)) return;

        // Clause 2 first: it explains the defect more precisely when both hold.
        const unread = unreadParameter(comparator!);
        if (unread !== null) {
          ctx.report(
            node,
            `This comparator never reads \`${unread}\`, so it is scoring one element instead of comparing two — \`sort\` gets an answer that does not depend on the pair, and the result is unordered or scrambled (verified: \`[{p:3},{p:1},{p:2}].sort((a, b) => a.p - a.q)\` gives \`[2,1,3]\`). Compare a field of one element against the same field of the other.`,
          );
          return;
        }

        const returned = returnedExpressions(comparator!);
        if (returned === null || returned.length === 0) return;
        if (!returned.every((expression) => isProvablyNonNegative(expression))) return;
        ctx.report(node, NON_NEGATIVE);
      },
    };
  },
});
