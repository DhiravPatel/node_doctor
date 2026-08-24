import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { findAncestor, isFunctionLike, isResultDiscarded, unwrapChain } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";

/**
 * A Hono handler that BUILDS a response and never returns it. The client gets a
 * 404, after the handler has already done its work.
 *
 *   ❌ app.get("/user", (c) => { c.json({ ok: true }); });
 *   ❌ app.post("/user", async (c) => {
 *        const body = await c.req.json();
 *        await save(body);
 *        c.json({ id: body.id });        // saved, then answered 404
 *      });
 *   ✅ app.get("/user", (c) => c.json({ ok: true }));
 *   ✅ app.get("/user", (c) => { return c.json({ ok: true }); });
 *
 * This is the one API difference that catches every developer arriving from
 * Express. `res.json(x)` SENDS; `c.json(x)` **constructs a `Response` and hands
 * it back**, and Hono only replies with what the handler returns. Discard it and
 * Hono finds no response, so it falls through to its not-found handler.
 *
 * MEASURED against Hono 4.13.4, running each form through `app.request()`:
 *
 *   (c) => { c.json({ ok: true }); }        → 404  "404 Not Found"
 *   (c) => { c.text("hi"); }                → 404  "404 Not Found"
 *   (c) => { c.html("<p>hi</p>"); }         → 404  "404 Not Found"
 *   (c) => { c.redirect("/other"); }        → 404  "404 Not Found"
 *   (c) => { c.body("raw"); }               → 404  "404 Not Found"
 *   async (c) => { await …; c.json(…); }    → 404  "404 Not Found"
 *   (c) => c.json({ ok: true })             → 200  {"ok":true}
 *
 * The async row is the expensive one: the `await` already ran, so the row was
 * written, the payment taken or the mail sent, and the caller is told the route
 * does not exist. A client that retries on 404 does all of it again.
 *
 * It survives review because the handler reads like Express and the 404 reads
 * like a routing problem, so the search starts in the router rather than in the
 * handler that already ran.
 *
 * PRECISION MODEL. Three conditions, all structural:
 *
 *   - The method is one that **produces** a `Response`: `json`, `text`, `html`,
 *     `body`, `redirect`, `notFound`, `newResponse`, `jsonT`. The
 *     context's side-effecting methods are excluded and verified to be correct
 *     when discarded — `c.header("x-trace", "1")` and `c.status(201)` before a
 *     returned `c.json(…)` produce a 201 with the right body, and `c.set(…)`
 *     stores a context variable read back by `c.get(…)`. Discarding those is the
 *     intended usage.
 *   - The result is **discarded** — an expression statement, not returned,
 *     assigned, awaited-into or passed on.
 *   - The receiver is the **first parameter** of an enclosing function that the
 *     engine already recognizes as a request handler. That anchor is what keeps
 *     the rule off every other framework in the same repo: Express's response is
 *     its *second* parameter (`(req, res)`), so is Fastify's (`(request, reply)`),
 *     and Koa sets `ctx.body` as a property rather than calling it.
 *
 * Gated on the `hono` capability, so a project that does not depend on Hono
 * never runs it.
 *
 * Deliberately NOT claimed:
 *
 *   - **`throw new HTTPException(401, …)`** instead of returning. Verified to
 *     produce a real 401, and it involves no discarded response call, so it is
 *     silent by construction.
 *   - **A discarded call followed by `return c.res`.** Verified to answer 200
 *     with an EMPTY body, because `c.json(…)` does not mutate `c.res` — so this
 *     rule firing there is correct, not a false positive, and no exclusion is
 *     warranted.
 *   - **Middleware that forgets `next()`**, which is a different defect with a
 *     different signature (Hono answers 500 "Context is not finalized"). Note
 *     that a bare, un-awaited `next()` is NOT a defect — verified to reach the
 *     handler and answer 200 — so the obvious "missing await" rule would be
 *     wrong here and is not shipped.
 */

/** Context methods that CONSTRUCT a Response — useless unless returned. */
const RESPONSE_PRODUCERS = new Set([
  "json",
  "text",
  "html",
  "body",
  "redirect",
  "notFound",
  "newResponse",
  "jsonT",
]);

/** The Identifier a simple parameter introduces, or null. */
const simpleParamName = (param: AstNode | null | undefined): string | null => {
  if (!param) return null;
  if (param.type === "Identifier") return String(param.name);
  if (param.type === "AssignmentPattern") return simpleParamName(param.left as AstNode);
  return null;
};

/**
 * Does anything inside `fn` declare `name`, shadowing the parameter?
 *
 * Deliberately over-broad — it looks through nested functions too — because its
 * only job is to make the rule bail when the name might not be the context.
 */
const declaresName = (fn: AstNode, name: string): boolean =>
  collectDescendants(fn, (n) => {
    if (n.type === "VariableDeclarator") {
      const id = n.id as AstNode | undefined;
      return id?.type === "Identifier" && String(id.name) === name;
    }
    if (n.type === "FunctionDeclaration" || n.type === "ClassDeclaration") {
      const id = n.id as AstNode | undefined;
      return id?.type === "Identifier" && String(id.name) === name;
    }
    return false;
  }).length > 0;

export const noUnreturnedHonoResponse = defineDiagnostic({
  id: "no-unreturned-hono-response",
  title: "Hono handler builds a response and never returns it, so the caller gets a 404",
  severity: "error",
  category: "Bugs",
  confidence: "high",
  requires: ["hono"],
  tags: ["hono", "correctness", "http"],
  recommendation:
    "Return the response: `return c.json(…)`, or drop the braces so the arrow returns it (`(c) => c.json(…)`). Unlike Express's `res.json(…)`, which sends, Hono's `c.json(…)` only CONSTRUCTS a `Response` — Hono replies with whatever the handler returns, so a discarded one leaves nothing to reply with and the caller gets a 404 even though the handler ran.",
  create: (ctx) => ({
    CallExpression: (node) => {
      const callee = unwrapChain(node.callee as AstNode);
      if (!callee || callee.type !== "MemberExpression" || callee.computed) return;
      const property = callee.property as AstNode | undefined;
      if (property?.type !== "Identifier" || !RESPONSE_PRODUCERS.has(String(property.name))) return;

      const receiver = callee.object as AstNode | undefined;
      if (receiver?.type !== "Identifier") return;

      // Useless only if nothing consumes it.
      if (!isResultDiscarded(node)) return;

      // The receiver must be the FIRST parameter of a recognized handler — the
      // Hono context. Express/Fastify put their response object second, so
      // their handlers can never match this.
      const fn = findAncestor(node, isFunctionLike);
      if (!fn || !ctx.requestHandlers.has(fn)) return;
      const first = ((fn.params as AstNode[] | undefined) ?? [])[0];
      if (simpleParamName(first) !== String(receiver.name)) return;

      // And it must still resolve to that parameter at this use site, so an
      // inner binding that shadows the context is not mistaken for it.
      const binding = ctx.scope.resolveIdentifier(receiver);
      const declared = ctx.scope.resolveIdentifier(first!);
      if (binding === null || binding !== declared) return;

      // Binding identity alone is not enough here. The scope resolver models
      // module, function and `catch` scopes but not nested BLOCKS, so a
      // `{ const c = makeSerializer(); c.json(…) }` inside the handler — the only
      // legal way to shadow a parameter, since a top-level `const c` beside a
      // parameter `c` is a SyntaxError — hoists to the function scope and
      // resolves to the same binding as the parameter. That would be a FALSE
      // POSITIVE, so any redeclaration of the name anywhere inside the handler
      // makes this bail. It costs almost nothing in recall (shadowing the
      // context parameter is vanishingly rare) and it fails toward silence.
      if (declaresName(fn, String(receiver.name))) return;

      ctx.report(
        node,
        `\`c.${String(property.name)}(…)\` CONSTRUCTS a Response — unlike Express's \`res.${String(property.name)}(…)\`, it does not send one. Hono replies with whatever the handler returns, so discarding this leaves nothing to reply with and the caller gets a **404** even though the handler already ran (verified against Hono 4.13.4). Return it.`,
      );
    },
  }),
});
