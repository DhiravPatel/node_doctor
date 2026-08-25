import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { declaresName, findAncestor, isFunctionLike } from "../../core/ast.ts";
import { looksLikeKoaMiddleware } from "../../core/request-path.ts";

/**
 * Koa middleware that calls `next()` without awaiting or returning it. The
 * response is sent before the rest of the chain has finished, and a downstream
 * error becomes an unhandled rejection.
 *
 *   ❌ app.use(async (ctx, next) => { next(); });
 *   ✅ app.use(async (ctx, next) => { await next(); });
 *   ✅ app.use((ctx, next) => next());
 *
 * `next()` returns a promise for the whole downstream chain. Koa builds its
 * response from `ctx` only after that promise settles, so a middleware that does
 * not wait hands control back immediately and Koa answers with whatever `ctx`
 * held at that moment — nothing.
 *
 * MEASURED against Koa 3.2.1, each case served over a real socket:
 *
 *   await next(),  downstream sets ctx.body synchronously  → 200 "downstream"
 *   next(),        downstream sets ctx.body synchronously  → 200 "downstream"
 *   await next(),  downstream awaits, then sets ctx.body   → 200 "downstream after await"
 *   return next(), downstream awaits, then sets ctx.body   → 200 "downstream after await"
 *   next(),        downstream awaits, then sets ctx.body   → 404 "Not Found"
 *
 * The second row is why this survives. With a synchronous downstream the
 * un-awaited form works, so it passes the smoke test and the one middleware
 * someone wrote it in looks fine — until any handler below it awaits a database,
 * which every real handler does, and the route starts 404-ing.
 *
 * The error path is worse, and was measured the same way. With `await next()`
 * inside a `try`, a downstream `throw` is caught and the middleware answers 503.
 * Without the `await` the `try` catches nothing, because the rejection happens
 * after the middleware has already returned: it becomes an unhandled rejection,
 * which **terminated the probe process**. So the un-awaited form does not merely
 * mis-order the response — it converts every downstream error from a caught 500
 * into a process exit.
 *
 * PRECISION MODEL. The claim is structural and needs no inference:
 *
 *   - The call's direct parent is an `ExpressionStatement` — a bare `next();`.
 *     Everything that consumes the promise is therefore silent by construction:
 *     `await next()`, `return next()`, a concise arrow body `(ctx, next) => next()`,
 *     `next().then(…)`, `next().catch(…)`, `const p = next()`, and
 *     `Promise.all([next(), …])`.
 *   - The enclosing function has Koa's exact middleware signature — **exactly
 *     two** parameters, `(ctx | context, next)`. Arity two is load-bearing:
 *     Express middleware is `(req, res, next)` and its error form is
 *     `(err, req, res, next)`, where a bare `next()` is the CORRECT call. This
 *     keeps the rule off both, so a project running Koa and Express side by side
 *     is not misreported.
 *   - **That function is in the engine's request-handler set.** The signature and
 *     the `koa` capability are not enough on their own, and shipping without this
 *     would have been the rule's one real defect: the capability is derived from
 *     package.json and so is PROJECT-wide, meaning every two-parameter
 *     `(ctx, next)` function anywhere in a Koa repo was reported at severity
 *     `error`. An adversarial review reproduced nine of them, all correct code —
 *     wizard steps, validator chains, in-memory reducers, a canvas layer
 *     pipeline, an `async.eachSeries` iteratee, a class method implementing an
 *     in-house `Middleware` interface, a test stub. For a `next` that returns
 *     void there is no promise in existence, so the advice was not merely noisy
 *     but wrong — and `function step(ctx: JobContext, next: () => void): void`
 *     fired despite annotations that positively disprove Koa. The handler set
 *     already encodes per-function Koa evidence, so this defers to it, the same
 *     anchor `no-unreturned-hono-response` uses.
 *   - The callee resolves to that function's **second parameter**, and the
 *     middleware does not redeclare the name. Binding identity alone is not
 *     enough: `ScopeResolver` models module, function and `catch` scopes but not
 *     nested BLOCKS, so a `{ const next = …; next(); }` — the only legal way to
 *     shadow a parameter — resolved to the parameter's binding and was reported.
 *     `declaresName` closes it, failing toward silence.
 *
 * Known recall gaps, each measured and each in the acceptable direction:
 * `void next()` and `next?.()` (the parent is not an `ExpressionStatement`),
 * `(ctx, next = noop)` (an `AssignmentPattern` parameter resolves to no binding),
 * `next()` inside a nested callback such as `setTimeout(() => next(), 0)` (the
 * enclosing-function anchor stops at the inner arrow), a destructured context
 * `({ request, response }, next)`, `@koa/router`'s three-parameter
 * `router.param("id", (id, ctx, next) => …)`, and a first parameter named `c`.
 *
 * Note the contrast with Hono, whose middleware was probed the same way: there an
 * un-awaited `next()` still reaches the handler and answers 200, so the
 * equivalent rule would report correct code and was deliberately not shipped.
 * Two frameworks, the same spelling, opposite verdicts — which is why each was
 * run rather than reasoned about.
 */

const KOA_NEXT = "next";

export const noUnawaitedKoaNext = defineDiagnostic({
  id: "no-unawaited-koa-next",
  title: "Koa middleware calls next() without awaiting it, so the response is sent before the chain finishes",
  severity: "error",
  category: "Bugs",
  confidence: "high",
  requires: ["koa"],
  tags: ["koa", "async", "http"],
  recommendation:
    "Await it — `await next()` — or return it (`return next()`, or a concise arrow body `(ctx, next) => next()`). `next()` is a promise for the entire downstream chain, and Koa only builds the response after it settles: without the await, Koa answers before any downstream handler that awaits has set `ctx.body` (measured: 404), and a downstream throw escapes your `try` to become an unhandled rejection that exits the process.",
  create: (ctx) => ({
    CallExpression: (node) => {
      const callee = node.callee as AstNode | undefined;
      if (callee?.type !== "Identifier" || String(callee.name) !== KOA_NEXT) return;

      // Only a bare `next();` statement drops the promise. Anything that
      // consumes it — await, return, a chain, an assignment, an argument
      // position — is correct and never reaches here.
      if ((node.parent as AstNode | undefined)?.type !== "ExpressionStatement") return;

      const fn = findAncestor(node, isFunctionLike);
      if (!fn || !looksLikeKoaMiddleware(fn)) return;

      // The signature alone proves nothing — `(ctx, next)` is a generic
      // middleware shape, and the `koa` capability is project-wide, so without
      // this the rule reported every synchronous `(ctx, next)` callback in a Koa
      // repo: wizard steps, validator chains, in-memory reducers, canvas layer
      // functions, `async.eachSeries` iteratees. For a `next` that returns void
      // there is nothing to await, so the advice was not merely noisy but wrong.
      // The engine's handler set already encodes the per-function Koa evidence,
      // so defer to it — the same anchor the sibling Hono rule uses.
      if (!ctx.requestHandlers.has(fn)) return;

      // The `next` being called must BE this middleware's parameter.
      const parameter = ((fn.params as AstNode[] | undefined) ?? [])[1];
      if (!parameter) return;
      const used = ctx.scope.resolveIdentifier(callee);
      const declared = ctx.scope.resolveIdentifier(parameter);
      if (used === null || used !== declared) return;

      // Binding identity is not enough on its own: the scope resolver models
      // module, function and `catch` scopes but not nested BLOCKS, so a
      // `{ const next = () => log(ctx); next(); }` inside the middleware — the
      // only legal way to shadow a parameter — resolves to the parameter's
      // binding and was reported. Any redeclaration of the name inside the
      // middleware makes this bail; it fails toward silence.
      if (declaresName(fn, String(callee.name))) return;

      ctx.report(
        node,
        "`next()` returns a promise for the whole downstream chain, and Koa builds the response only after it settles. Dropping it hands control back immediately, so Koa answers with whatever `ctx` held at that moment — measured against Koa 3.2.1, a downstream handler that awaits anything before setting `ctx.body` yields **404 Not Found**. A downstream throw also escapes any `try` here and becomes an unhandled rejection that exits the process. Write `await next()` or `return next()`.",
      );
    },
  }),
});
