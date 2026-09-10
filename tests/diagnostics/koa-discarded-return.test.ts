/**
 * `no-discarded-koa-return`.
 *
 * Koa discards the return value of every middleware, so a handler that RETURNS
 * its payload leaves `ctx.body` unset and the request falls through the stack.
 * MEASURED against Koa 3.2.1 with @koa/router, each case a real server fetched
 * over HTTP:
 *
 *   app.use    return { ok: true }                  → 404 "Not Found"
 *   app.use    return "hello"                       → 404 "Not Found"
 *   app.use    ctx.set(…) then return { ok: 1 }     → 404 "Not Found"
 *   app.use    const rows = await db(); return rows → 404 "Not Found"
 *   router.get return { ok: 1 }                     → 404 "Not Found"
 *   router.get ctx.body = { ok: 1 }                 → 200 {"ok":1}          OK
 *   router.get return (ctx.body = { ok: 1 })        → 200 {"ok":1}          OK
 *   app.use    delegate to helper(ctx)              → 200 {"via":"helper"}  OK
 *
 * The last two are the silencers that matter, and both are measured rather than
 * assumed: an assignment expression is a legitimate return, and handing `ctx` to
 * a helper lets the helper answer.
 *
 * The anchor is the REGISTRATION SITE, because the engine's Koa recognition
 * needs the body to touch a distinctive context member — which is exactly what
 * this defect's body does not do.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noDiscardedKoaReturn } from "../../src/diagnostics/frameworks/no-discarded-koa-return.ts";

const CAPS = new Set(["node", "esm", "typescript", "koa"]);
const SETUP = `import Koa from "koa";\nimport Router from "@koa/router";\nconst app = new Koa();\nconst router = new Router();\n`;

const findings = (body: string, prelude = SETUP) =>
  lintSource({
    filePath: "/repo/src/server.ts",
    sourceText: prelude + body,
    diagnostics: [noDiscardedKoaReturn],
    capabilities: CAPS,
  }).findings.filter((f) => f.diagnostic === "no-discarded-koa-return");

const fires = (body: string, prelude?: string) => {
  const found = findings(body, prelude);
  assert.ok(found.length > 0, `expected a FIRE on:\n${body}`);
  return found;
};
const silent = (body: string, prelude?: string): void => {
  const found = findings(body, prelude);
  assert.equal(found.length, 0, `expected SILENCE on:\n${body}\ngot: ${found.map((f) => f.message).join("\n")}`);
};

describe("no-discarded-koa-return", () => {
  describe("the defect — measured 404 Not Found", () => {
    test("a concise arrow returning an object literal", () => {
      fires(`router.get("/users", async () => ({ ok: true }));`);
    });

    test("a block body with an explicit return", () => {
      fires(`app.use(async (ctx) => { return { ok: true }; });`);
    });

    test("a returned string, and a template literal", () => {
      fires(`app.use(async () => "hello");`);
      fires(`app.use(async (ctx) => { return \`hi \${name}\`; });`);
    });

    test("a returned local whose initializer never mentions ctx", () => {
      fires(`app.use(async (ctx) => { const rows = await db.all(); return rows; });`);
    });

    test("a read off ctx is not an escape — the commonest real instance", () => {
      // `db.find(ctx.params.id)` hands over a string, which cannot answer the
      // request, so the returned row is still discarded and the route 404s.
      fires(`router.get("/u/:id", async (ctx) => { const user = await db.find(ctx.params.id); return user; });`);
    });

    test("a header write is not a response", () => {
      // Measured: ctx.set(…) then return { ok: 1 } still answered 404.
      fires(`app.use(async (ctx) => { ctx.set("X-Trace", "1"); return { ok: 1 }; });`);
    });

    test("every router method, and the named-route form", () => {
      for (const method of ["get", "post", "put", "patch", "delete", "all", "use"]) {
        fires(`router.${method}("/x", async () => ({ ok: 1 }));`);
      }
      fires(`router.get("user", "/u/:id", async () => ({ ok: 1 }));`);
    });

    test("a handler referenced by name", () => {
      fires(`async function list() { return { ok: 1 }; }\nrouter.get("/users", list);`);
      fires(`const list = async () => ({ ok: 1 });\nrouter.get("/users", list);`);
    });

    test("the require spelling of both modules", () => {
      const cjs = `const Koa = require("koa");\nconst Router = require("koa-router");\nconst app = new Koa();\nconst router = new Router();\n`;
      fires(`router.get("/users", async () => ({ ok: 1 }));`, cjs);
    });

    test("the message names the measured status and the fix", () => {
      const [found] = fires(`router.get("/users", async (ctx) => { return { ok: 1 }; });`);
      assert.match(found!.message, /404 Not Found/);
      assert.match(found!.message, /Koa 3\.2\.1/);
      assert.match(found!.message, /ctx\.body = …/);
      assert.match(found!.recommendation ?? "", /return \(ctx\.body = result\)/);
    });
  });

  describe("silence — the handler does answer", () => {
    test("assigning ctx.body, including as the returned expression", () => {
      // Measured: `return (ctx.body = { ok: 1 })` answered 200.
      silent(`router.get("/users", async (ctx) => { ctx.body = { ok: 1 }; });`);
      silent(`router.get("/users", async (ctx) => (ctx.body = { ok: 1 }));`);
      silent(`router.get("/users", async (ctx) => { ctx.body = { ok: 1 }; return { ok: 1 }; });`);
    });

    test("ctx.response.body, ctx.res and ctx.respond = false", () => {
      silent(`app.use(async (ctx) => { ctx.response.body = { ok: 1 }; return { ok: 1 }; });`);
      silent(`app.use(async (ctx) => { ctx.respond = false; ctx.res.end("x"); return { ok: 1 }; });`);
    });

    test("the calls that answer by themselves", () => {
      for (const call of ["throw(404)", 'redirect("/login")', 'render("page")', 'attachment("f.csv")', "back()"]) {
        silent(`app.use(async (ctx) => { ctx.${call}; return { ok: 1 }; });`);
      }
    });

    test("handing ctx to a helper, which is measured to answer 200", () => {
      silent(`app.use(async (ctx) => helper(ctx));`);
      silent(`app.use(async (ctx) => { const out = await load(ctx); return out; });`);
      silent(`app.use(async (ctx) => { setBody(...[ctx]); return { ok: 1 }; });`);
    });

    test("a middleware that touches `next` is upstream of whatever answers", () => {
      silent(`app.use(async (ctx, next) => next());`);
      silent(`app.use(async (ctx, next) => { await next(); return { ok: 1 }; });`);
      silent(`app.use(async (ctx, next) => { return next(); });`);
    });

    test("returning something the rule cannot see through", () => {
      silent(`app.use(async (ctx) => { return build(); });`);
      silent(`app.use(async (ctx) => { return cache.value; });`);
      silent(`app.use(async (ctx) => { return; });`);
      silent(`app.use(async (ctx) => { return null; });`);
    });
  });

  describe("the registration anchor", () => {
    test("no Koa construction in the file, no finding", () => {
      silent(`router.get("/users", async () => ({ ok: 1 }));`, `const router = makeRouter();\n`);
      silent(`app.use(async () => ({ ok: 1 }));`, `const app = express();\n`);
    });

    test("a same-named constructor from somewhere else is not Koa", () => {
      const other = `import Router from "express";\nconst router = new Router();\n`;
      silent(`router.get("/users", async () => ({ ok: 1 }));`, other);
    });

    test("a method the receiver does not route with", () => {
      silent(`app.listen(async () => ({ ok: 1 }));`);
      silent(`router.param("id", async () => ({ ok: 1 }));`);
    });

    test("an ordinary call that merely takes a function", () => {
      silent(`items.map(async () => ({ ok: 1 }));`);
    });

    test("a destructured context is a pattern the rule cannot follow", () => {
      silent(`app.use(async ({ request }) => ({ ok: 1 }));`);
    });
  });
});
