/**
 * §3 — `no-body-on-bodiless-status`.
 *
 * HTTP defines 204, 205 and 304 as carrying no body, and Node enforces it by
 * discarding the payload. Measured against a real server: the client receives
 * `""`, length 0. Nothing fails on the server, so the failure lands in the
 * CALLER's codebase — which is why it survives.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noBodyOnBodilessStatus } from "../../src/diagnostics/http/no-body-on-bodiless-status.ts";

const findings = (source: string) =>
  lintSource({
    filePath: "/repo/src/routes.ts",
    sourceText: source,
    diagnostics: [noBodyOnBodilessStatus],
    capabilities: new Set(["node", "esm", "typescript", "express"]),
  }).findings.filter((f) => f.diagnostic === "no-body-on-bodiless-status");

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
