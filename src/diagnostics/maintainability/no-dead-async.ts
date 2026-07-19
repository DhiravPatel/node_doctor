import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { containsOwnAwait, isFunctionLike } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";

/**
 * An `async` function whose own body never `await`s. The `async` keyword then
 * only wraps the return value in an extra promise and misleads readers into
 * thinking the function does asynchronous work. To stay precise the diagnostic fires
 * ONLY when the body has statements, contains no `await`/`for await`, and every
 * `return` yields a plainly-synchronous value (literal/object/array/template) —
 * so a function that returns a call or an identifier (which may itself be a
 * promise it forwards) is never touched.
 *
 * ❌ async function currentUser(req) { const id = req.user.id; return { id }; }
 * ✅ function currentUser(req) { const id = req.user.id; return { id }; }
 * ✅ async function save(o) { await db.write(o); }             // awaits
 * ✅ async function fetchUser(id) { return db.user.find(id); }  // returns a call (may be a promise)
 */

/** Return arguments that are plainly not a promise — safe to demand the async keyword go. */
const SYNC_RETURN_TYPES = new Set([
  "Literal",
  "ObjectExpression",
  "ArrayExpression",
  "TemplateLiteral",
]);

export const noDeadAsync = defineDiagnostic({
  id: "no-dead-async",
  title: "async function with no await",
  severity: "warn",
  category: "Maintainability",
  tags: ["async", "hygiene"],
  recommendation:
    "Drop the `async` keyword if the function never awaits. Keep it only when the body uses `await`/`for await` or genuinely returns a promise.",
  create: (ctx) => {
    const check = (node: AstNode): void => {
      if (!node.async) return;
      const body = node.body as AstNode | null;
      // Only block-bodied functions "have statements"; expression-bodied arrows return directly.
      if (!body || body.type !== "BlockStatement") return;
      const stmts = body.body as AstNode[];
      if (stmts.length === 0) return; // empty body — nothing to advise
      if (containsOwnAwait(node)) return;

      // If any own-body return could forward a promise, stay silent.
      const returns = collectDescendants(body, (n) => n.type === "ReturnStatement", isFunctionLike);
      for (const ret of returns) {
        const arg = ret.argument as AstNode | null;
        if (arg && !SYNC_RETURN_TYPES.has(arg.type)) return;
      }

      ctx.report(node, "`async` function never awaits — the keyword only wraps the result in an extra promise and misleads readers.");
    };

    return {
      FunctionDeclaration: check,
      FunctionExpression: check,
      ArrowFunctionExpression: check,
    };
  },
});
