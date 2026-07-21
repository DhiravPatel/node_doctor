import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { isFunctionLike } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";

/**
 * A function with high cyclomatic complexity — too many independent paths
 * through it (branches, loops, `&&`/`||`/`??`, ternaries, `case`s, `catch`).
 * High complexity correlates with defect rate and untestability. OPT-IN.
 *
 * Threshold: complexity > 15 (1 + decision points), counting only this
 * function's own body, not nested functions.
 */

const MAX_COMPLEXITY = 15;

const DECISION_TYPES = new Set([
  "IfStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "SwitchCase", // each non-default case
  "ConditionalExpression",
  "CatchClause",
]);

const isLogicalDecision = (node: AstNode): boolean =>
  node.type === "LogicalExpression" && (node.operator === "&&" || node.operator === "||" || node.operator === "??");

const complexityOf = (fn: AstNode): number => {
  const body = (fn.body as AstNode | undefined) ?? fn;
  // Count decision points in the function's own body, not descending into nested functions.
  const nodes = collectDescendants(
    body,
    (n) => DECISION_TYPES.has(n.type) || isLogicalDecision(n),
    isFunctionLike,
  );
  let count = 1; // one base path
  for (const n of nodes) {
    // A `default:` switch case is not a decision.
    if (n.type === "SwitchCase" && n.test === null) continue;
    count++;
  }
  return count;
};

export const highCyclomaticComplexity = defineDiagnostic({
  id: "high-cyclomatic-complexity",
  title: "Function is too complex",
  severity: "warn",
  category: "Maintainability",
  tags: ["complexity"],
  defaultEnabled: false,
  recommendation:
    "Reduce branching: extract sub-decisions into well-named helper functions, replace flag chains with a lookup table or polymorphism, and use guard clauses. Aim for a cyclomatic complexity at or below 15.",
  create: (ctx) => {
    const check = (node: AstNode): void => {
      const complexity = complexityOf(node);
      if (complexity > MAX_COMPLEXITY) {
        ctx.report(node, `This function's cyclomatic complexity is ${complexity} (> ${MAX_COMPLEXITY}) — too many independent paths to test and reason about.`);
      }
    };
    return {
      FunctionDeclaration: check,
      FunctionExpression: check,
      ArrowFunctionExpression: check,
    };
  },
});
