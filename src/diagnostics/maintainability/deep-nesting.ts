import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { isFunctionLike } from "../../core/ast.ts";

/**
 * Control-flow nested beyond a sane depth (if/for/while/switch/try inside each
 * other). Deep nesting is where bugs hide and where "arrow code" becomes
 * unreadable. OPT-IN — off by default.
 *
 * Threshold: depth > 4. Reported once per branch that first crosses the limit.
 */

const MAX_DEPTH = 4;

/**
 * Does `child` sit in a *body* position of control statement `parent`? An
 * `else if` (the `alternate` of an `if`) deliberately does NOT nest, so a long
 * else-if chain stays at one level.
 */
const bodyNests = (child: AstNode, parent: AstNode): boolean => {
  switch (parent.type) {
    case "IfStatement":
      return child === parent.consequent;
    case "ForStatement":
    case "ForInStatement":
    case "ForOfStatement":
    case "WhileStatement":
    case "DoWhileStatement":
    case "CatchClause":
      return child === parent.body;
    case "TryStatement":
      return child === parent.block || child === parent.finalizer;
    case "SwitchStatement":
      return Array.isArray(parent.cases) && (parent.cases as AstNode[]).includes(child);
    default:
      return false;
  }
};

/** Body-nesting depth of `node`, up to the enclosing function. */
const nestingDepth = (node: AstNode): number => {
  let depth = 1; // this control statement is one level
  let child = node;
  let cur = node.parent;
  while (cur && !isFunctionLike(cur)) {
    if (bodyNests(child, cur)) depth++;
    child = cur;
    cur = cur.parent;
  }
  return depth;
};

export const deepNesting = defineDiagnostic({
  id: "deep-nesting",
  title: "Control flow nested too deeply",
  severity: "warn",
  category: "Maintainability",
  tags: ["complexity"],
  defaultEnabled: false,
  recommendation:
    "Flatten the nesting: return early / use guard clauses, extract inner blocks into helper functions, or invert conditions. Deeply nested branches are hard to follow and test.",
  create: (ctx) => {
    const check = (node: AstNode): void => {
      // Report only the first node that crosses the limit in a branch (depth === MAX+1);
      // deeper descendants have a higher depth and are not re-reported.
      if (nestingDepth(node) === MAX_DEPTH + 1) {
        ctx.report(node, `Control flow is nested ${MAX_DEPTH + 1} levels deep (> ${MAX_DEPTH}) — flatten with guard clauses or extracted helpers.`);
      }
    };
    return {
      IfStatement: check,
      ForStatement: check,
      ForInStatement: check,
      ForOfStatement: check,
      WhileStatement: check,
      DoWhileStatement: check,
      SwitchStatement: check,
      TryStatement: check,
    };
  },
});
