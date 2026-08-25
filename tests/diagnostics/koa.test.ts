/**
 * Koa support: request-path recognition for `(ctx, next)` middleware, and
 * `no-unawaited-koa-next`.
 *
 * MEASURED against Koa 3.2.1, each case served over a real socket:
 *
 *   await next(),  downstream sets ctx.body synchronously  → 200 "downstream"
 *   next(),        downstream sets ctx.body synchronously  → 200 "downstream"
 *   await next(),  downstream awaits, then sets ctx.body   → 200 "downstream after await"
 *   return next(), downstream awaits, then sets ctx.body   → 200 "downstream after await"
 *   next(),        downstream awaits, then sets ctx.body   → 404 "Not Found"
 *
 * The second row is why it survives review: with a synchronous downstream the
 * un-awaited form works. It only breaks once a handler below awaits anything,
 * which every real handler does.
 *
 * The error path was measured too: with `await next()` inside a `try`, a
 * downstream throw is caught and answers 503. WITHOUT the await the `try` catches
 * nothing — the rejection lands after the middleware returned, and it terminated
 * the probe process.
 *
 * Contrast with Hono, probed the same way: there an un-awaited `next()` still
 * reaches the handler and answers 200, so the equivalent rule would report
 * correct code and was deliberately not shipped. Same spelling, opposite verdict.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noUnawaitedKoaNext } from "../../src/diagnostics/frameworks/no-unawaited-koa-next.ts";
import { noSyncIoInRequestPath } from "../../src/diagnostics/event-loop/no-sync-io-in-request-path.ts";

const CAPS = new Set(["node", "esm", "typescript", "koa"]);
const findings = (source: string, rules: unknown[] = [noUnawaitedKoaNext], filePath = "/repo/src/app.ts") =>
  lintSource({ filePath, sourceText: source, diagnostics: rules as never, capabilities: CAPS }).findings;

const fires = (source: string) => {
  const found = findings(source);
  assert.ok(found.length > 0, `expected a FIRE on:\n${source}`);
  return found;
};
const silent = (source: string): void =>
  assert.equal(findings(source).length, 0, `expected SILENCE on:\n${source}`);

describe("no-unawaited-koa-next", () => {
  describe("the defect", () => {
    test("a bare next() drops the downstream promise", () => {
      fires(`app.use(async (ctx, next) => { next(); });`);
    });

    test("in a standalone middleware file", () => {
      fires(`
        import type { Context, Next } from "koa";
        export async function auth(ctx: Context, next: Next) {
          ctx.state.user = await lookup(ctx);
          next();
        }
      `);
    });

    test("inside a try, where it also defeats the catch", () => {
      // Measured: the rejection lands after the middleware returned, so the
      // `try` catches nothing and the process exits.
      fires(`
        app.use(async (ctx, next) => {
          try { next(); } catch (e) { ctx.status = 503; }
        });
      `);
    });

    test("the message names the mechanism and the measured status", () => {
      const [found] = fires(`app.use(async (ctx, next) => { next(); });`);
      assert.match(found!.message, /404 Not Found/);
      assert.match(found!.message, /unhandled rejection/);
      assert.match(found!.recommendation ?? "", /await next\(\)|return next\(\)/);
    });
  });

  describe("silence — the promise is consumed", () => {
    test("awaited", () => {
      silent(`app.use(async (ctx, next) => { await next(); });`);
    });

    test("returned, explicitly and as a concise arrow body", () => {
      silent(`app.use((ctx, next) => { return next(); });`);
      silent(`app.use((ctx, next) => next());`);
    });

    test("chained", () => {
      silent(`app.use((ctx, next) => { next().then(done); });`);
      silent(`app.use((ctx, next) => { next().catch(report); });`);
    });

    test("captured or passed on", () => {
      silent(`app.use(async (ctx, next) => { const p = next(); await p; });`);
      silent(`app.use(async (ctx, next) => { await Promise.all([next(), warm()]); });`);
    });
  });

  describe("precision guards — arity is what keeps this off Express", () => {
    test("Express middleware is (req, res, next) and a bare next() is CORRECT", () => {
      silent(`app.use((req, res, next) => { next(); });`);
    });

    test("Express error middleware is (err, req, res, next)", () => {
      silent(`app.use((err, req, res, next) => { next(err); });`);
    });

    test("a parameter that shadows an outer `next` IS the parameter", () => {
      // The earlier version of this test used `(ctx, other)`, which bails on the
      // SIGNATURE before the binding check is ever reached — it asserted nothing.
      // Here the signature matches and the parameter shadows the import, so the
      // binding check must resolve to the parameter and the rule must fire.
      const found = findings(`
        import Koa from "koa";
        import next from "next";
        const app = new Koa();
        app.use(async (ctx, next) => { ctx.body = "x"; next(); });
      `);
      assert.equal(found.length, 1);
    });

    test("a block-scoped inner `next` is not the parameter", () => {
      // Reproduced as a false positive before the guard: the scope resolver does
      // not model blocks, so the inner reference resolved to the parameter's
      // binding. A nested block is the only legal way to shadow a parameter.
      silent(`
        import Koa from "koa";
        const app = new Koa();
        app.use(async (ctx, next) => {
          ctx.body = "x";
          await next();
          { const next = () => log(ctx); next(); }
        });
      `);
    });

    test("a synchronous (ctx, next) callback in a Koa repo is not middleware", () => {
      // Reproduced as a false positive: the `koa` capability is project-wide, so
      // before the handler-set gate every one of these fired at severity error —
      // and for a `next` that returns void there is nothing to await, so the
      // advice was wrong, not merely noisy.
      silent(`export function advance(ctx, next) { ctx.step += 1; next(); }`);
      silent(`export const stamp = (ctx, next) => { ctx.ts = Date.now(); next(); };`);
      silent(`export function drawGrid(ctx, next) { ctx.stroke(); next(); }`);
      silent(`export function step(ctx: JobContext, next: () => void): void { ctx.done = true; next(); }`);
      silent(`const chain = [(context, next) => { record(context); next(); }];`);
    });

    test("a first parameter that is not the context", () => {
      silent(`run(async (job, next) => { next(); });`);
    });

    test("a three-parameter Koa-shaped function is not Koa middleware", () => {
      silent(`app.use(async (ctx, next, extra) => { next(); });`);
    });
  });
});

describe("Koa request-path recognition", () => {
  const syncIo = `const raw = readFileSync("/srv/c.json", "utf8"); ctx.body = raw;`;
  const reachable = (source: string) =>
    findings(source, [noSyncIoInRequestPath], "/repo/src/middleware/auth.ts").length;

  test("middleware registered inline was already covered", () => {
    // `use` is one of the registration methods, so this never needed a signature.
    assert.ok(
      reachable(`
        import Koa from "koa";
        import { readFileSync } from "node:fs";
        const app = new Koa();
        app.use(async (ctx, next) => { ${syncIo} await next(); });
      `) > 0,
    );
  });

  test("standalone middleware is now reached, with a value import", () => {
    // The gap this closes: measured at ZERO findings before, while the identical
    // Express spelling produced two.
    assert.ok(
      reachable(`
        import Koa from "koa";
        import { readFileSync } from "node:fs";
        export async function auth(ctx, next) { ${syncIo} await next(); }
      `) > 0,
    );
  });

  test("a type-only koa import is evidence too", () => {
    assert.ok(
      reachable(`
        import type { Context, Next } from "koa";
        import { readFileSync } from "node:fs";
        export async function auth(ctx: Context, next: Next) { ${syncIo} await next(); }
      `) > 0,
    );
  });

  test("a namespaced Koa type resolves through its own import", () => {
    assert.ok(
      reachable(`
        import Koa from "koa";
        import { readFileSync } from "node:fs";
        export const auth = async (ctx: Koa.Context, next: Koa.Next) => { ${syncIo} await next(); };
      `) > 0,
    );
  });

  test("no Koa evidence — a generic (ctx, next) pipeline stays out", () => {
    // `(ctx, next)` is a generic middleware shape. Widening the global signature
    // fallback without proof would make every request-path rule noisier on every
    // project, so the evidence gate is the whole point.
    assert.equal(
      reachable(`
        import { readFileSync } from "node:fs";
        export async function step(ctx, next) { ${syncIo} await next(); }
      `),
      0,
    );
  });

  /**
   * The first version of this gate accepted a bare type NAME with no import
   * check at all, and accepted file-level evidence that leaked across the whole
   * file. An adversarial review reproduced both, on correct non-HTTP code and in
   * projects with NO koa dependency. Each case below is one of those, pinned.
   */
  describe("the evidence gate — every case here was a reproduced false positive", () => {
    test("a locally-declared type named Context proves nothing", () => {
      assert.equal(
        reachable(`
          import { readFileSync } from "node:fs";
          export type Context = { files: string[] };
          export type Next = () => void;
          export const loadIgnores = (ctx: Context, next: Next) => {
            ctx.files = readFileSync(".buildignore", "utf8").split("\\n");
            next();
          };
        `),
        0,
      );
    });

    test("a type named Context imported from somewhere that is not Koa", () => {
      // Telegraf, grammY and @opentelemetry/api all export a `Context`, and all
      // three collided. This needs no contrivance at all.
      for (const source of ["telegraf", "grammy", "@opentelemetry/api"]) {
        assert.equal(
          reachable(`
            import { Context } from "${source}";
            import { readFileSync } from "node:fs";
            export const mw = async (ctx: Context, next: () => Promise<void>) => {
              ctx.log = readFileSync("./b.txt", "utf8");
              await next();
            };
          `),
          0,
          `expected SILENCE for a Context imported from ${source}`,
        );
      }
    });

    test("a koa import does not promote unrelated functions in the same file", () => {
      // One `@koa/router` import used to promote every `(ctx, next)` in the file.
      // Evidence is per-function now: this reducer touches `ctx.snapshot`, which
      // is not a Koa context member.
      assert.equal(
        reachable(`
          import Router from "@koa/router";
          import { readFileSync } from "node:fs";
          export const router = new Router();
          export const applyPatch = (ctx, next) => {
            ctx.snapshot = JSON.parse(readFileSync("./snapshot.json", "utf8"));
            next();
          };
        `),
        0,
      );
    });

    test("but a koa import PLUS a real context member is proof", () => {
      // The recall this keeps: plain-JS middleware that touches `ctx.body`.
      assert.ok(
        reachable(`
          import Koa from "koa";
          import { readFileSync } from "node:fs";
          export async function auth(ctx, next) {
            ctx.body = readFileSync("/srv/c.json", "utf8");
            await next();
          }
        `) > 0,
      );
    });
  });

  test("Express recognition is untouched by the addition", () => {
    assert.ok(
      reachable(`
        import { readFileSync } from "node:fs";
        export async function m(req, res, next) {
          const raw = readFileSync("/x", "utf8");
          res.send(raw);
        }
      `) > 0,
    );
  });
});
