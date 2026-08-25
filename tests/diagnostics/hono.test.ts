/**
 * `no-unreturned-hono-response`.
 *
 * `res.json(x)` SENDS; `c.json(x)` CONSTRUCTS a `Response` and hands it back.
 * Hono replies with whatever the handler returns, so a discarded one leaves
 * nothing to reply with. MEASURED against Hono 4.13.4, running each form through
 * `app.request()` before encoding it here:
 *
 *   (c) => { c.json({ ok: true }); }     → 404  "404 Not Found"
 *   (c) => { c.text("hi"); }             → 404  "404 Not Found"
 *   (c) => { c.html("<p>hi</p>"); }      → 404  "404 Not Found"
 *   (c) => { c.redirect("/other"); }     → 404  "404 Not Found"
 *   (c) => { c.body("raw"); }            → 404  "404 Not Found"
 *   async (c) => { await …; c.json(…); } → 404  "404 Not Found"
 *   (c) => c.json({ ok: true })          → 200  {"ok":true}
 *
 * And the exclusions, measured the same way — these are correct code:
 *
 *   (c) => { c.header("x","1"); c.status(201); return c.json({}); }  → 201, right body
 *   (c) => { c.set("user", u); return c.text(c.get("user").id) }     → 200, right body
 *   () => { throw new HTTPException(401) }                            → 401
 *
 * One measured non-defect worth pinning: middleware calling `next()` WITHOUT
 * `await` still reaches the handler and answers 200, so the obvious
 * "missing await on next()" rule would be wrong and is not shipped.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noUnreturnedHonoResponse } from "../../src/diagnostics/frameworks/no-unreturned-hono-response.ts";

const CAPS = new Set(["node", "esm", "typescript", "hono"]);
const findings = (source: string) =>
  lintSource({ filePath: "/repo/src/routes.ts", sourceText: source, diagnostics: [noUnreturnedHonoResponse], capabilities: CAPS })
    .findings.filter((f) => f.diagnostic === "no-unreturned-hono-response");

const app = (body: string) => `import { Hono } from "hono";\nconst app = new Hono();\n${body}\nexport default app;`;
const fires = (body: string) => {
  const found = findings(app(body));
  assert.ok(found.length > 0, `expected a FIRE on:\n${body}`);
  return found;
};
const silent = (body: string): void => {
  const found = findings(app(body));
  assert.equal(found.length, 0, `expected SILENCE, got ${found.length}:\n${body}`);
};

describe("no-unreturned-hono-response", () => {
  describe("the defect — every Response producer", () => {
    test("c.json()", () => {
      fires(`app.get("/u", (c) => { c.json({ ok: true }); });`);
    });

    test("c.text(), c.html(), c.body(), c.redirect()", () => {
      fires(`app.get("/a", (c) => { c.text("hi"); });`);
      fires(`app.get("/b", (c) => { c.html("<p>hi</p>"); });`);
      fires(`app.get("/c", (c) => { c.body("raw"); });`);
      fires(`app.get("/d", (c) => { c.redirect("/other"); });`);
    });

    test("the async form — the work already happened", () => {
      fires(`
        app.post("/u", async (c) => {
          const body = await c.req.json();
          await save(body);
          c.json({ id: body.id });
        });
      `);
    });

    test("discarded in a branch, with a real return after", () => {
      // Verified: the error response is silently dropped and the caller gets
      // the fall-through body instead.
      fires(`
        app.get("/u", (c) => {
          if (!c.req.query("id")) { c.json({ error: "missing id" }); }
          return c.text("ok");
        });
      `);
    });

    test("a context parameter named something else", () => {
      fires(`app.get("/u", (context) => { context.json({ ok: true }); });`);
    });

    test("the message names the mechanism and the observed status", () => {
      const [found] = fires(`app.get("/u", (c) => { c.json({ ok: true }); });`);
      assert.match(found!.message, /CONSTRUCTS a Response/);
      assert.match(found!.message, /404/);
      assert.match(found!.recommendation ?? "", /return c\.json/);
    });
  });

  describe("silence — the response is used", () => {
    test("returned explicitly", () => {
      silent(`app.get("/u", (c) => { return c.json({ ok: true }); });`);
    });

    test("a concise arrow body returns it", () => {
      silent(`app.get("/u", (c) => c.json({ ok: true }));`);
    });

    test("assigned, or handed onward", () => {
      silent(`app.get("/u", (c) => { const res = c.json({ ok: true }); return res; });`);
      silent(`app.get("/u", (c) => { return wrap(c.json({ ok: true })); });`);
    });
  });

  describe("silence — side-effecting context methods", () => {
    test("c.header() and c.status() are meant to be discarded", () => {
      // Verified: 201 with the right body.
      silent(`app.get("/u", (c) => { c.header("x-trace", "1"); c.status(201); return c.json({ ok: true }); });`);
    });

    test("c.set() stores a context variable", () => {
      silent(`app.use("*", (c, next) => { c.set("user", { id: 1 }); return next(); });`);
    });
  });

  describe("precision guards — the first-parameter anchor", () => {
    test("an Express handler in the same project is untouched", () => {
      // Express puts its response SECOND, so `res.json(…)` can never match.
      silent(`app.get("/u", (req, res) => { res.json({ ok: true }); });`);
    });

    test("a Fastify handler is untouched for the same reason", () => {
      silent(`app.get("/u", (request, reply) => { reply.send({ ok: true }); });`);
    });

    test("a json() call on something that is not the context", () => {
      silent(`app.get("/u", (c) => { logger.json({ ok: true }); return c.text("ok"); });`);
    });

    test("a shadowing inner binding is not the context", () => {
      silent(`
        app.get("/u", (c) => {
          {
            const c = makeSerializer();
            c.json({ ok: true });
          }
          return Response.json({ ok: true });
        });
      `);
    });

    test("a call outside any recognized handler", () => {
      silent(`function helper(c) { c.json({ ok: true }); }`);
    });

    test("a computed member call is not claimed", () => {
      silent(`app.get("/u", (c) => { c["json"]({ ok: true }); return c.text("ok"); });`);
    });
  });
});
