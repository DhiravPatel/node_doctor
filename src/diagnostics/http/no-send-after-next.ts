import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, rootObjectName } from "../../core/ast.ts";

/**
 * A middleware calls `next(...)` — delegating the request to the next handler in
 * the chain — and then, in the same block, sends a response anyway. `next()` does
 * not stop the current function: the downstream handler responds, and then this
 * function's `res.json()`/`send()`/`end()` fires a second write on an
 * already-finished response, throwing `ERR_HTTP_HEADERS_SENT`. The fix is to
 * `return next(...)` (or return after responding), so exactly one of the two paths
 * runs.
 *
 * Detection is deliberately narrow: a bare `next(...)` statement followed *later
 * in the same block* by a terminal `res.*` statement, with no `return` in
 * between. A returned `next(...)` is a `ReturnStatement`, not a bare call, so it
 * is never matched.
 *
 * ❌ function mw(req, res, next) { next(err); res.status(500).json({ error }); }
 * ✅ function mw(req, res, next) { return next(err); }
 * ✅ function mw(req, res, next) { if (bad) return next(err); res.json(ok); }
 */

const TERMINAL = new Set(["json", "send", "end", "redirect", "render", "sendFile", "sendStatus", "jsonp", "download"]);
const RESPONSE_ROOTS = new Set(["res", "response", "reply"]);

/** A statement that is a bare `next(...)` call (not `return next(...)`). */
const isBareNextCall = (stmt: AstNode): boolean => {
  if (stmt.type !== "ExpressionStatement") return false;
  const expr = stmt.expression;
  return (
    expr?.type === "CallExpression" &&
    expr.callee?.type === "Identifier" &&
    expr.callee.name === "next"
  );
};

/** A statement that is a terminal `res.json()/send()/end()/...` call. */
const isTerminalResponseStatement = (stmt: AstNode): boolean => {
  if (stmt.type !== "ExpressionStatement") return false;
  const expr = stmt.expression;
  if (expr?.type !== "CallExpression") return false;
  const method = getMethodName(expr);
  if (!method || !TERMINAL.has(method)) return false;
  const root = rootObjectName(expr.callee);
  return !!root && RESPONSE_ROOTS.has(root);
};

export const noSendAfterNext = defineDiagnostic({
  id: "no-send-after-next",
  title: "Response sent after calling next()",
  severity: "error",
  category: "Bugs",
  requires: ["express"],
  tags: ["express"],
  recommendation:
    "Return when you delegate: `return next(err)` (or return after responding). A bare `next()` does not stop the handler, so the later `res.*` writes to an already-finished response and throws ERR_HTTP_HEADERS_SENT.",
  create: (ctx) => ({
    BlockStatement: (node) => {
      const body = (node.body as AstNode[]) ?? [];
      for (let i = 0; i < body.length; i++) {
        if (!isBareNextCall(body[i]!)) continue;

        // Scan the rest of the block for a terminal response, bailing out at the
        // first `return` (which would make the response unreachable).
        for (let j = i + 1; j < body.length; j++) {
          const later = body[j]!;
          if (later.type === "ReturnStatement") break;
          if (isTerminalResponseStatement(later)) {
            ctx.report(
              later.expression,
              "A response is sent after `next(...)` was already called — `next()` does not stop the handler, so this writes to a finished response and throws ERR_HTTP_HEADERS_SENT.",
            );
            return; // one finding per handler is enough
          }
        }
      }
    },
  }),
});
