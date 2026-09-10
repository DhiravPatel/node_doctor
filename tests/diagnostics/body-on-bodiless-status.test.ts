/**
 * §3 — `no-body-on-bodiless-status`.
 *
 * HTTP defines 204, 205 and 304 as carrying no body, and Node enforces it by
 * discarding the payload. Measured against a real server: the client receives
 * `""`, length 0. Nothing fails on the server, so the failure lands in the
 * CALLER's codebase — which is why it survives.
 *
 * Koa writes the same defect as two ASSIGNMENTS rather than a chain. MEASURED
 * against Koa 3.2.1, each case a real server fetched over HTTP:
 *
 *   ctx.status = 204;  ctx.body = { ok: true };   → 204, empty, no content-length
 *   ctx.body = { ok: true };  ctx.status = 204;   → 204, empty, no content-length
 *   ctx.status = 304;  ctx.body = { ok: true };   → 304, empty
 *   ctx.status = 201;  ctx.body = { ok: true };   → 201 {"ok":true}
 *
 * Both orders lose it and 201 keeps it, so the STATUS decides, not the sequence.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noBodyOnBodilessStatus } from "../../src/diagnostics/http/no-body-on-bodiless-status.ts";

const findings = (source: string, capabilities = new Set(["node", "esm", "typescript", "express"])) =>
  lintSource({
    filePath: "/repo/src/routes.ts",
    sourceText: source,
    diagnostics: [noBodyOnBodilessStatus],
    capabilities,
  }).findings.filter((f) => f.diagnostic === "no-body-on-bodiless-status");

const KOA = new Set(["node", "esm", "typescript", "koa"]);
/** Wrap statements in a Koa-shaped handler, so `ctx` is a parameter. */
const koa = (body: string) => `router.get("/x", async (ctx) => {\n${body}\n});`;
const koaFires = (body: string) => {
  const found = findings(koa(body), KOA);
  assert.ok(found.length > 0, `expected a FIRE on:\n${body}`);
  return found;
};
const koaSilent = (body: string): void => {
  const found = findings(koa(body), KOA);
  assert.equal(found.length, 0, `expected SILENCE on:\n${body}\ngot: ${found.map((f) => f.message).join("\n")}`);
};

const fires = (source: string) => {
  const found = findings(source);
  assert.ok(found.length > 0, `expected a FIRE on:\n${source}`);
  return found;
};
const silent = (source: string): void =>
  assert.equal(findings(source).length, 0, `expected SILENCE on:\n${source}`);

describe("no-body-on-bodiless-status — fires", () => {
  test("the classic `204` with a JSON payload", () => {
    const [f] = fires(`res.status(204).json({ ok: true, deleted: 3 });`);
    assert.match(f!.message, /204 No Content/);
    assert.match(f!.message, /Unexpected end of JSON input/);
    assert.match(f!.message, /\.end\(\)/);
  });

  test("every bodiless status, and every body method", () => {
    fires(`res.status(204).send("done");`);
    fires(`res.status(205).json(payload);`);
    fires(`res.status(304).send(cached);`);
    fires(`res.status(204).jsonp(data);`);
    fires(`res.status(204).end("bye");`);
  });
});

describe("no-body-on-bodiless-status — silent", () => {
  test("the two correct spellings", () => {
    silent(`res.status(204).end();`);
    silent(`res.status(204).send();`);
    silent(`res.sendStatus(204);`);
  });

  test("a status that CAN carry a body", () => {
    silent(`res.status(200).json({ ok: true });`);
    silent(`res.status(201).json(created);`);
    silent(`res.status(404).json({ error: "nope" });`);
    silent(`res.status(500).send("boom");`);
  });

  test("a status that is not a literal is not folded", () => {
    // `res.status(code)` could be anything; guessing would be inventing a fact.
    silent(`res.status(code).json(body);`);
    silent(`res.status(codes.NO_CONTENT).json(body);`);
  });

  test("`.end(callback)` takes a callback, not a body", () => {
    silent(`res.status(204).end(() => done());`);
    silent(`res.status(204).end(function () { done(); });`);
  });

  test("a body method with no status chain", () => {
    silent(`res.json({ ok: true });`);
    silent(`res.end();`);
  });
});

describe("no-body-on-bodiless-status — hardened by the corpus", () => {
  test("a provably EMPTY argument is 'no body' written out loud", () => {
    // `@adonisjs/cors` ends a preflight with exactly this, under a comment
    // saying so — and it sends nothing, so there is nothing to discard. The
    // unit cases missed it; a 133,000-file sweep did not.
    silent(`response.status(204).send(null);`);
    silent(`res.status(204).send(undefined);`);
    silent(`res.status(204).send("");`);
    silent(`res.status(304).end(null);`);
  });

  test("but a real body is still a real body", () => {
    fires(`res.status(204).send("0");`);
    fires(`res.status(204).json(null ?? fallback);`);
  });
});

describe("no-body-on-bodiless-status — determinism", () => {
  test("identical source yields identical findings", () => {
    const source = `res.status(204).json(a);\nres.status(304).send(b);`;
    assert.equal(JSON.stringify(findings(source)), JSON.stringify(findings(source)));
    assert.equal(findings(source).length, 2);
  });
});

describe("no-body-on-bodiless-status — the Koa assignment form", () => {
  test("both measured orders lose the body", () => {
    const [f] = koaFires(`ctx.status = 204;\nctx.body = { ok: true };`);
    assert.match(f!.message, /204 No Content/);
    assert.match(f!.message, /Koa 3\.2\.1/);
    // The default recommendation is Express's chained spelling, which Koa lacks.
    assert.match(f!.recommendation ?? "", /ctx\.status = 200/);
    assert.doesNotMatch(f!.recommendation ?? "", /sendStatus/);
    koaFires(`ctx.body = { ok: true };\nctx.status = 204;`);
  });

  test("every bodiless status, and the ctx.response spelling", () => {
    koaFires(`ctx.status = 205;\nctx.body = payload;`);
    koaFires(`ctx.status = 304;\nctx.body = cached;`);
    koaFires(`ctx.response.status = 204;\nctx.response.body = { ok: 1 };`);
    koaFires(`ctx.status = 204;\nctx.response.body = { ok: 1 };`);
  });

  test("a status that CAN carry a body is silent — measured 201 keeps it", () => {
    koaSilent(`ctx.status = 201;\nctx.body = { ok: true };`);
    koaSilent(`ctx.status = 200;\nctx.body = { ok: true };`);
  });

  test("a status the rule cannot read is silent", () => {
    koaSilent(`ctx.status = code;\nctx.body = { ok: true };`);
    koaSilent(`ctx.status = NO_CONTENT;\nctx.body = { ok: true };`);
  });

  test("an empty body is the author writing `no body` out loud", () => {
    koaSilent(`ctx.status = 204;\nctx.body = null;`);
    koaSilent(`ctx.status = 204;\nctx.body = "";`);
    koaSilent(`ctx.status = 204;`);
  });

  test("a later non-bodiless status replaces the pending one", () => {
    koaSilent(`ctx.status = 204;\nctx.status = 200;\nctx.body = { ok: 1 };`);
  });

  test("the branch proof — an early exit between them breaks the pair", () => {
    koaSilent(`ctx.status = 204;\nreturn;\nctx.body = { ok: 1 };`);
    koaSilent(`ctx.status = 204;\nthrow new Error("x");\nctx.body = { ok: 1 };`);
  });

  test("the branch proof — a status set in a nested block is never paired", () => {
    // The commonest correct shape, and the one a naive rule reports.
    koaSilent(`if (rows.length === 0) { ctx.status = 204; return; }\nctx.body = rows;`);
    koaSilent(`if (fresh) { ctx.status = 304; }\nctx.body = rows;`);
  });

  test("a locally built object is not a context", () => {
    // The receiver must be a function PARAMETER.
    const source = `const reply = {};\nreply.status = 204;\nreply.body = { ok: 1 };`;
    assert.equal(findings(source, KOA).length, 0);
  });

  test("the clause is gated on the koa capability", () => {
    const source = koa(`ctx.status = 204;\nctx.body = { ok: true };`);
    assert.ok(findings(source, KOA).length > 0);
    assert.equal(findings(source, new Set(["node", "esm", "typescript", "express"])).length, 0);
  });

  test("two independent handlers each report once", () => {
    const source = `router.get("/a", async (ctx) => { ctx.status = 204; ctx.body = a; });\nrouter.get("/b", async (ctx) => { ctx.status = 304; ctx.body = b; });`;
    assert.equal(findings(source, KOA).length, 2);
    assert.equal(JSON.stringify(findings(source, KOA)), JSON.stringify(findings(source, KOA)));
  });
});
