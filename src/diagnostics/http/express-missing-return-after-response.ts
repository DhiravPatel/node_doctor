import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, rootObjectName } from "../../core/ast.ts";

/**
 * A guard clause sends a response but does not `return`, so execution falls
 * through into the code the guard was meant to prevent — running the protected
 * logic anyway and then responding a second time (`ERR_HTTP_HEADERS_SENT`).
 *
 * ❌ if (!req.body.email) { res.status(400).json({ error: "email required" }); }
 *    const user = await db.user.findUnique(...); // runs even when email is missing
 * ✅ if (!req.body.email) { return res.status(400).json({ error: "email required" }); }
 *
 * FASTIFY IS THE SAME BUG, and the rule's logic always covered it — `reply` is in
 * `RESPONSE_ROOTS` and `send` is in `TERMINAL` — but `requires: ["express"]` meant
 * it never ran on a Fastify project. Verified against Fastify 5.12.1 through
 * `app.inject()`: a handler that calls `reply.send(a)` and then returns `b`
 * answers with **`a`**, silently discarding the return. So the guard's 400 is
 * what the caller sees while the protected code below it has already run — the
 * order was created, the mail was sent — and the value the author meant to
 * return is dropped without a warning. Fastify 5 does not throw here, which is
 * precisely why it survives: nothing in the logs says anything happened.
 *
 * The gate is now `requiresAny: ["express", "fastify"]` — the family form added
 * for exactly this, since `requires` is ALL and dropping the gate entirely would
 * let the rule run on projects with no HTTP framework at all.
 */

const TERMINAL = new Set(["json", "send", "end", "redirect", "render", "sendFile", "sendStatus", "jsonp", "download"]);
const RESPONSE_ROOTS = new Set(["res", "response", "reply"]);

const isResponseTerminalCall = (expr: AstNode): boolean => {
  if (expr.type !== "CallExpression") return false;
  const method = getMethodName(expr);
  if (!method || !TERMINAL.has(method)) return false;
  const root = rootObjectName(expr.callee);
  return !!root && RESPONSE_ROOTS.has(root);
};

const containingBody = (node: AstNode): AstNode[] | null => {
  const parent = node.parent;
  if (!parent) return null;
  if (parent.type === "BlockStatement" || parent.type === "Program") return parent.body as AstNode[];
  return null;
};

export const expressMissingReturnAfterResponse = defineDiagnostic({
  id: "express-missing-return-after-response",
  title: "Response sent in a guard without a return",
  severity: "error",
  category: "Bugs",
  requiresAny: ["express", "fastify"],
  tags: ["express", "fastify"],
  recommendation:
    "Prefix the guard's response with `return` (`return res.status(400).json(...)`, `return reply.code(400).send(...)`). A response call does not stop the handler — without `return`, the 'rejected' request runs the protected logic anyway. Express then responds twice (`ERR_HTTP_HEADERS_SENT`); Fastify 5 silently keeps the first response and discards whatever the handler returns, so nothing in the logs marks it.",
  create: (ctx) => ({
    IfStatement: (node) => {
      if (node.alternate) return; // has else → not a fall-through guard

      const consequent = node.consequent;
      const stmts = consequent.type === "BlockStatement" ? (consequent.body as AstNode[]) : [consequent];
      const last = stmts[stmts.length - 1];
      if (!last || last.type !== "ExpressionStatement") return;
      if (!isResponseTerminalCall(last.expression)) return;

      // There must be code after the guard for the fall-through to bite.
      const body = containingBody(node);
      if (!body) return;
      const idx = body.indexOf(node);
      if (idx === -1 || idx === body.length - 1) return;

      ctx.report(
        last.expression,
        "This guard sends a response but does not `return` — execution falls through into the protected code and responds twice.",
      );
    },
  }),
});
