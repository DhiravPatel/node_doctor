import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";

/**
 * A single function spanning many lines. Long functions are hard to test and
 * review and usually hide several responsibilities. OPT-IN (a project sets its
 * own tolerance) — off by default so it never adds noise to a default scan.
 *
 * Threshold: 60 source lines (inclusive of signature and braces).
 */

const MAX_LINES = 60;

const lineSpan = (source: string, node: AstNode): number => {
  const start = typeof node.start === "number" ? node.start : 0;
  const end = typeof node.end === "number" ? node.end : start;
  const text = source.slice(start, end);
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  return lines;
};

const report = (node: AstNode, ctx: { report: (n: AstNode, m: string) => void; sourceText: string }): void => {
  const lines = lineSpan(ctx.sourceText, node);
  if (lines > MAX_LINES) {
    ctx.report(node, `This function is ${lines} lines (> ${MAX_LINES}) — split it into smaller, single-purpose functions.`);
  }
};

export const maxFunctionLength = defineDiagnostic({
  id: "max-function-length",
  title: "Function is too long",
  severity: "warn",
  category: "Maintainability",
  tags: ["complexity"],
  defaultEnabled: false,
  recommendation:
    "Extract cohesive blocks into named helper functions so each function does one thing. Aim for functions that fit on a screen.",
  create: (ctx) => ({
    FunctionDeclaration: (node) => report(node, ctx),
    FunctionExpression: (node) => report(node, ctx),
    ArrowFunctionExpression: (node) => report(node, ctx),
  }),
});
