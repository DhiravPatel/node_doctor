/**
 * `no-unawaited-hono-body`.
 *
 * MEASURED against Hono 4.13.5 by calling every `c.req` member inside a running
 * handler and asking whether the result is a Promise:
 *
 *   json  → ASYNC     valid  → sync      routePath → string (not a function)
 *   text  → ASYNC     param  → sync      url       → string
 *   parseBody   → ASYNC     query   → sync      method    → string
 *   formData    → ASYNC     queries → sync
 *   arrayBuffer → ASYNC     header  → sync
 *   blob        → ASYNC
 *
 * That split is the whole rule: the six body readers need `await`, the accessors
 * do not, and reporting `c.req.param("id")` would be reporting correct code.
 *
 * Measured end to end: `const b = c.req.json(); return c.json({ got: b.x })`
 * answers **200 with `{"got":null}`** — the request succeeds and the field is
 * simply missing.
 *
 * Also measured and deliberately NOT a rule: reading the body twice
 * (`await c.req.json()` then `await c.req.json()`) WORKS in Hono 4.13.5, which
 * caches the parsed body — so the obvious "body already consumed" rule would
 * report correct code.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noUnawaitedHonoBody } from "../../src/diagnostics/frameworks/no-unawaited-hono-body.ts";

const CAPS = new Set(["node", "esm", "typescript", "hono"]);
const findings = (source: string) =>
  lintSource({
    filePath: "/repo/src/routes.ts",
    sourceText: `import { Hono } from "hono";\nconst app = new Hono();\n${source}`,
    diagnostics: [noUnawaitedHonoBody],
    capabilities: CAPS,
  }).findings.filter((f) => f.diagnostic === "no-unawaited-hono-body");

const fires = (source: string) => {
  const found = findings(source);
  assert.ok(found.length > 0, `expected a FIRE on:\n${source}`);
  return found;
};
const silent = (source: string): void =>
  assert.equal(findings(source).length, 0, `expected SILENCE on:\n${source}`);

describe("no-unawaited-hono-body", () => {
  describe("the defect", () => {
    test("through a binding — the common spelling", () => {
      fires(`app.post("/o", (c) => { const body = c.req.json(); return c.json(body.items); });`);
    });

    test("a member access directly on the call", () => {
      fires(`app.post("/o", (c) => c.json({ token: c.req.json().token }));`);
    });

    test("destructuring the Promise", () => {
      fires(`app.post("/o", (c) => { const { items } = c.req.json(); return c.json(items); });`);
    });

    test("every one of the six async readers", () => {
      for (const reader of ["json", "text", "parseBody", "formData", "arrayBuffer", "blob"]) {
        fires(`app.post("/o", (c) => { const b = c.req.${reader}(); return c.json(b.size); });`);
      }
    });

    test("the context parameter can be named anything", () => {
      fires(`app.post("/o", (ctx) => { const b = ctx.req.json(); return ctx.json(b.items); });`);
    });

    test("the message names the mechanism and the measured result", () => {
      const [found] = fires(`app.post("/o", (c) => { const b = c.req.json(); return c.json(b.items); });`);
      assert.match(found!.message, /returns a \*\*Promise\*\*/);
      assert.match(found!.message, /\{"got":null\}/);
      assert.match(found!.recommendation ?? "", /await c\.req\.json/);
    });
  });

  describe("silence — the Promise is treated as one", () => {
    test("awaited, in both spellings", () => {
      silent(`app.post("/o", async (c) => { const b = await c.req.json(); return c.json(b.items); });`);
      silent(`app.post("/o", async (c) => { const { items } = await c.req.json(); return c.json(items); });`);
    });

    test("chained or returned", () => {
      silent(`app.post("/o", (c) => c.req.json().then((b) => c.json(b.items)));`);
      silent(`app.post("/o", (c) => c.req.json());`);
      silent(`app.post("/o", (c) => c.req.json().catch(fallback));`);
    });

    test("collected into Promise.all", () => {
      silent(`app.post("/o", async (c) => { const [b] = await Promise.all([c.req.json()]); return c.json(b.items); });`);
    });

    test("the Promise passed onward, never read", () => {
      silent(`app.post("/o", (c) => { const p = c.req.json(); return handle(p); });`);
    });

    test("a discarded call is pointless but not this defect", () => {
      silent(`app.post("/o", (c) => { c.req.parseBody(); return c.text("ok"); });`);
    });
  });

  describe("precision guards — the sync accessors must never fire", () => {
    test("param, query, queries, header and valid are synchronous", () => {
      // Measured on Hono 4.13.5. Reporting these would be reporting correct code.
      silent(`app.get("/o", (c) => c.json({ id: c.req.param("id").length }));`);
      silent(`app.get("/o", (c) => c.json({ q: c.req.query("x").trim() }));`);
      silent(`app.get("/o", (c) => c.json({ q: c.req.queries("x").length }));`);
      silent(`app.get("/o", (c) => c.json({ h: c.req.header("x-a").length }));`);
      silent(`app.post("/o", (c) => c.json({ v: c.req.valid("json").items }));`);
    });

    test("a reader on something that is not `.req`", () => {
      silent(`app.post("/o", (c) => { const b = service.json(); return c.json(b.items); });`);
      silent(`app.post("/o", (c) => { const b = response.text(); return c.json(b.length); });`);
    });

    test("a computed member call is not claimed", () => {
      silent(`app.post("/o", (c) => { const b = c.req["json"](); return c.json(b.items); });`);
    });
  });
});
