/**
 * A small intra-file taint pass.
 *
 * It propagates "this value came from the caller" from request-shaped roots
 * (`req`, `request`, `ctx`, `context`, `event`) through a few assignment hops to
 * a fixpoint. `const { name } = req.query` marks `name` tainted; `const id =
 * lookup(req.params.id)` marks `id` tainted.
 *
 * The result **sharpens messages** (an injection sink built from a tainted value
 * says "caller-controlled — this is injection"). It must never *gate* a finding:
 * an unsound analysis silencing a real sink would ship a false negative people
 * trust. See §3.4 / guardrail 3.
 */

import type { AstNode } from "./types.ts";
import { walk, findDescendant } from "./walk.ts";
import { REQUEST_ROOTS, isFunctionLike } from "./ast.ts";

const MAX_ROUNDS = 6;

const patternNames = (pattern: AstNode | null | undefined, out: string[]): void => {
  if (!pattern) return;
  switch (pattern.type) {
    case "Identifier":
      out.push(pattern.name);
      break;
    case "AssignmentPattern":
      patternNames(pattern.left, out);
      break;
    case "RestElement":
      patternNames(pattern.argument, out);
      break;
    case "ArrayPattern":
      for (const el of (pattern.elements as (AstNode | null)[]) ?? []) patternNames(el, out);
      break;
    case "ObjectPattern":
      for (const prop of (pattern.properties as AstNode[]) ?? []) {
        if (prop.type === "RestElement") patternNames(prop.argument, out);
        else patternNames(prop.value, out);
      }
      break;
    default:
      break;
  }
};

/** Compute the set of caller-controlled binding names in a file. */
export const computeTaint = (program: AstNode): Set<string> => {
  const tainted = new Set<string>();

  /**
   * A request-root *name* that the file declares as its own variable is not the
   * request object — `const context = 3` in a diff utility means "lines of
   * context". Seeding taint from it floods the whole function and produces
   * false positives, so such names are never treated as a source. If the local
   * really is caller-derived (`const ctx = req.context`), the propagation rule
   * below still taints it, so nothing is lost.
   */
  const locallyDeclared = new Set<string>();
  walk(program, {
    enter: (node) => {
      if (node.type !== "VariableDeclarator") return;
      const names: string[] = [];
      patternNames(node.id, names);
      for (const name of names) if (REQUEST_ROOTS.has(name)) locallyDeclared.add(name);
    },
  });

  const isCallerRoot = (name: string): boolean => REQUEST_ROOTS.has(name) && !locallyDeclared.has(name);

  /**
   * Seed the set with the request roots this file GENUINELY has, so the answer
   * lives in one place.
   *
   * `looksCallerControlled` used to re-derive "is this a request root?" from the
   * name alone, which quietly defeated the exclusion above for all sixteen files
   * that call it — a local `const context = lines.slice(0, 3).join("\n")` in a
   * diff utility was reported as caller-controlled by thirteen security rules.
   * Seeding here means the exclusion is applied once, by the code that knows
   * about it, and every consumer inherits it.
   */
  walk(program, {
    enter: (node) => {
      if (node.type === "Identifier" && isCallerRoot(node.name)) tainted.add(node.name);
    },
  });

  const referencesCaller = (expr: AstNode | null | undefined): boolean => {
    if (!expr) return false;
    const isTaintedIdent = (n: AstNode): boolean => {
      if (n.type !== "Identifier" || !(isCallerRoot(n.name) || tainted.has(n.name))) return false;
      // An Identifier is only a VARIABLE READ in some positions. `row.user_id`
      // and `{ token: … }` are a property name and a key — not references — and
      // treating them as such let taint spread by NAME COLLISION alone, which in
      // a file-global set means one binding contaminates everything sharing a
      // common word. `looksCallerControlled` applies the same rule; both must,
      // or taint re-enters here on the next round and the fix there is undone.
      const parent = n.parent as AstNode | undefined;
      if (parent?.type === "MemberExpression" && parent.property === n && parent.computed !== true) return false;
      if (parent?.type === "Property" && parent.key === n && parent.computed !== true) return false;
      return true;
    };
    if (isTaintedIdent(expr)) return true;
    return findDescendant(expr, isTaintedIdent, isFunctionLike) !== null;
  };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const before = tainted.size;
    walk(program, {
      enter: (node) => {
        if (node.type === "VariableDeclarator" && node.init && referencesCaller(node.init)) {
          const names: string[] = [];
          patternNames(node.id, names);
          for (const name of names) tainted.add(name);
        } else if (
          node.type === "AssignmentExpression" &&
          node.operator === "=" &&
          node.left?.type === "Identifier" &&
          referencesCaller(node.right)
        ) {
          tainted.add(node.left.name);
        }
      },
    });
    if (tainted.size === before) break;
  }

  return tainted;
};
