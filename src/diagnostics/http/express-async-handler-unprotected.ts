import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, isFunctionLike, containsOwnAwait, containsTryStatement } from "../../core/ast.ts";

/**
 * An `async` Express route handler with no `try/catch` and no async wrapper.
 *
 * Express 4 wraps handler invocation in a *synchronous* try/catch. An `async`
 * handler returns a promise immediately, so any rejection *after the first
 * `await`* escapes that catch: the error middleware never fires, the response is
 * never sent, and the client hangs. Express 5 awaits handler return values, so
 * the diagnostic retires itself on `express:5`.
 *
 * ❌ app.get("/u/:id", async (req, res) => { const u = await db.find(req.params.id); res.json(u); });
 * ✅ app.get("/u/:id", asyncHandler(async (req, res) => { ... }));
 * ✅ app.get("/u/:id", async (req, res, next) => { try { ... } catch (e) { next(e); } });
 */

const REGISTER_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "del",
  "options",
  "head",
  "all",
  "use",
]);

export const expressAsyncHandlerUnprotected = defineDiagnostic({
  id: "express-async-handler-unprotected",
  title: "Async route handler with no error path",
  severity: "error",
  category: "Reliability",
  requires: ["express"],
  disabledWhen: ["express:5"],
  tags: ["async", "express", "lifecycle"],
  recommendation:
    "Wrap the handler (`asyncHandler(fn)` / express-async-errors), or add a `try/catch` that calls `next(error)`, or upgrade to Express 5. A rejection after the first `await` otherwise escapes Express 4 error handling and the request hangs.",
  create: (ctx) => ({
    CallExpression: (node) => {
      const method = getMethodName(node);
      if (!method || !REGISTER_METHODS.has(method)) return;

      for (const arg of (node.arguments as AstNode[]) ?? []) {
        // Only a *direct* async function is unprotected — a wrapper call
        // (asyncHandler(fn)) makes `arg` a CallExpression, not a function.
        if (!isFunctionLike(arg) || !arg.async) continue;
        if (!containsOwnAwait(arg)) continue; // no post-await window
        if (containsTryStatement(arg)) continue; // handled inline
        ctx.report(
          arg,
          "This async handler has no try/catch and is not wrapped — a rejection after the first `await` escapes Express 4 error handling and the request hangs.",
        );
      }
    },
  }),
});
