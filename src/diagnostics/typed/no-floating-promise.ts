import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";

/**
 * A promise whose result is discarded (`--typed`).
 *
 * This is the rule that made type-awareness worth building. Syntactically all we
 * can see is the `async` keyword, so an untyped version catches
 * `async function save()` and misses `function save(): Promise<void>` — which,
 * in a TypeScript codebase, is most of them, and misses every call through an
 * interface or a repository type entirely.
 *
 * A dropped promise is not a style problem. The work is still scheduled, so the
 * request returns before the write lands; a rejection becomes an
 * `unhandledRejection` that (since Node 15) terminates the process; and the
 * stack trace points at the event loop rather than at the call site, so the
 * outage is hard to trace back to this line.
 *
 * Silent unless the checker is certain: `promiseKindAt` returns `"unknown"` for
 * `any`, for an unresolved node, and for a mixed union, and an unknown answer is
 * never reported.
 *
 * ❌ save(user);                    // returns Promise<void>, result dropped
 * ✅ await save(user);
 * ✅ void save(user);               // explicitly, deliberately fire-and-forget
 * ✅ save(user).catch(report);
 */

/** Parents that consume the value, so the promise is not floating. */
const CONSUMES_VALUE = new Set([
  "AwaitExpression",
  "ReturnStatement",
  "ArrowFunctionExpression",
  "VariableDeclarator",
  "AssignmentExpression",
  "Property",
  "ArrayExpression",
  "CallExpression",
  "NewExpression",
  "TemplateLiteral",
  "BinaryExpression",
  "ConditionalExpression",
  "LogicalExpression",
  "SpreadElement",
  "YieldExpression",
  "TSAsExpression",
  "TSNonNullExpression",
  "ReturnStatement",
]);

/** `void save()` is the documented way to say "deliberately not awaited". */
const isVoidOperator = (node: AstNode | undefined): boolean =>
  node?.type === "UnaryExpression" && node.operator === "void";

/**
 * Is this call the tail of a settled chain — `save().catch(f)`?
 *
 * The statement expression IS the `.catch` call, so the answer lives on the
 * callee, not the parent: checking the parent asks whether the whole chain is
 * itself being chained, which it is not, and reported the documented fix.
 */
const isHandled = (node: AstNode): boolean => {
  const callee = node.callee as AstNode | undefined;
  if (callee?.type !== "MemberExpression" || callee.computed) return false;
  const name = callee.property?.type === "Identifier" ? (callee.property.name as string) : "";
  return name === "then" || name === "catch" || name === "finally";
};

export const noFloatingPromise = defineDiagnostic({
  id: "no-floating-promise",
  title: "Promise result discarded",
  severity: "error",
  category: "Reliability",
  confidence: "high",
  requiresTypes: true,
  tags: ["async", "typed"],
  recommendation:
    "Await the call, or make the fire-and-forget explicit. `await save(user)` when the caller depends on it; `void save(user)` plus a `.catch()` when it genuinely runs in the background. An unhandled rejection terminates the process on modern Node.",
  create: (ctx) => ({
    ExpressionStatement: (node) => {
      const source = ctx.typeSource;
      if (!source) return;

      let expr = node.expression as AstNode | undefined;
      if (!expr) return;
      // `void save()` is an explicit opt-out, and so is a handled chain.
      if (isVoidOperator(expr)) return;
      if (expr.type === "TSAsExpression" || expr.type === "TSNonNullExpression") {
        expr = expr.expression as AstNode | undefined;
        if (!expr) return;
      }
      if (expr.type !== "CallExpression") return;
      if (isHandled(expr)) return;

      // Only a bare expression statement floats — anything that consumes the
      // value is fine, and the parent chain tells us which this is.
      const parent = expr.parent as AstNode | undefined;
      if (parent && parent.type !== "ExpressionStatement" && CONSUMES_VALUE.has(parent.type)) return;

      if (source.promiseKindAt(ctx.filePath, expr.start as number) !== "promise") return;

      ctx.report(
        expr,
        "This call returns a promise and the result is discarded — the work is not awaited, and a rejection becomes an unhandled rejection that terminates the process.",
      );
    },
  }),
});
