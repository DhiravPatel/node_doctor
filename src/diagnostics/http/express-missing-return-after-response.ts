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
 * ADONISJS IS THE SAME BUG AGAIN, and its precedence rule is written down in the
 * framework itself. `src/router/factories/use_return_value.ts` reads:
 *
 *     if (value !== undefined && !ctx.response.hasLazyBody && value !== ctx.response) {
 *       ctx.response.send(value);
 *     }
 *
 * So once a guard has called `response.unauthorized({ … })`, the response HAS a
 * lazy body and whatever the handler returns afterwards is **discarded**. The
 * caller does get the 401 — and the protected code below the guard has already
 * run, with every write and charge it performs. Adonis spells the terminals as
 * status helpers (`response.unauthorized()`, `response.notFound()`,
 * `response.created()`), so `TERMINAL` alone never matched them.
 *
 * Those helpers are gated on the `adonis` capability, because `ok`, `created`,
 * `conflict` and `gone` are ordinary words elsewhere. `response.abort()` is
 * deliberately excluded: it THROWS, so it really does stop the handler and needs
 * no `return`.
 *
 * The gate is now `requiresAny: ["express", "fastify", "adonis"]` — the family
 * form added for exactly this, since `requires` is ALL and dropping the gate
 * entirely would let the rule run on projects with no HTTP framework at all.
 */

const TERMINAL = new Set(["json", "send", "end", "redirect", "render", "sendFile", "sendStatus", "jsonp", "download"]);
const RESPONSE_ROOTS = new Set(["res", "response", "reply"]);

/**
 * AdonisJS's status helpers, which set the body and return — they do not stop the
 * handler. Gated on the `adonis` capability because `ok`, `created`, `conflict`
 * and `gone` are ordinary words that would otherwise fire on other stacks.
 *
 * `abort` is deliberately absent: it THROWS, so it does stop execution and needs
 * no `return`. `status`, `header` and `type` are absent because they set no body.
 */
const ADONIS_TERMINAL = new Set([
  "ok", "created", "accepted", "noContent", "badRequest", "unauthorized", "paymentRequired",
  "forbidden", "notFound", "methodNotAllowed", "notAcceptable", "requestTimeout", "conflict",
  "gone", "unprocessableEntity", "tooManyRequests", "internalServerError", "notImplemented",
  "badGateway", "serviceUnavailable", "gatewayTimeout", "stream",
]);

const isResponseTerminalCall = (expr: AstNode, adonis: boolean): boolean => {
  if (expr.type !== "CallExpression") return false;
  const method = getMethodName(expr);
  if (!method) return false;
  if (!TERMINAL.has(method) && !(adonis && ADONIS_TERMINAL.has(method))) return false;
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
  requiresAny: ["express", "fastify", "adonis"],
  tags: ["express", "fastify", "adonis"],
  recommendation:
    "Prefix the guard's response with `return` (`return res.status(400).json(...)`, `return reply.code(400).send(...)`, `return response.unauthorized(...)`). A response call does not stop the handler — without `return`, the 'rejected' request runs the protected logic anyway. Express then responds twice (`ERR_HTTP_HEADERS_SENT`); Fastify 5 silently keeps the first response; AdonisJS discards the handler's return value once the response has a lazy body, so the caller sees the 401 while everything below the guard has already run. In none of the three does anything appear in the logs.",
  create: (ctx) => ({
    IfStatement: (node) => {
      const adonis = ctx.hasCapability("adonis");
      if (node.alternate) return; // has else → not a fall-through guard

      const consequent = node.consequent;
      const stmts = consequent.type === "BlockStatement" ? (consequent.body as AstNode[]) : [consequent];
      const last = stmts[stmts.length - 1];
      if (!last || last.type !== "ExpressionStatement") return;
      if (!isResponseTerminalCall(last.expression, adonis)) return;

      // There must be code after the guard for the fall-through to bite.
      const body = containingBody(node);
      if (!body) return;
      const idx = body.indexOf(node);
      if (idx === -1 || idx === body.length - 1) return;

      // The consequence differs by framework, and the message says the one that
      // actually happens rather than Express's for all three.
      ctx.report(
        last.expression,
        adonis
          ? "This guard sends a response but does not `return` — execution falls through into the protected code, which runs with every write it performs. AdonisJS then DISCARDS whatever the handler returns, because the response already has a lazy body (`use_return_value.ts` sends the returned value only `if (!ctx.response.hasLazyBody)`), so the caller sees the guard's status and never learns the rest of the handler ran."
          : "This guard sends a response but does not `return` — execution falls through into the protected code and responds twice.",
      );
    },
  }),
});
