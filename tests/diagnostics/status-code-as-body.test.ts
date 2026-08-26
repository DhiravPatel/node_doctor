/**
 * `no-status-code-as-response-body`.
 *
 * Express 5 removed `res.send(status)` and the two-argument
 * `res.send(status, body)` / `res.json(status, body)`. It does not throw — the
 * first argument is simply the body now. MEASURED against Express 5.2.1, each
 * case served over a real socket:
 *
 *   res.send(404)              → 200  body "404"   content-type application/json
 *   res.send(204)              → 200  body "204"
 *   res.send(200, { ok: 1 })   → 200  body "200"   ← the payload is discarded
 *   res.json(201, created)     → 200  body "201"   ← the payload is discarded
 *   res.send("404")            → 200  body "404"   text/html            (correct)
 *   res.status(404).send()     → 404  body ""                           (correct)
 *   res.sendStatus(404)        → 404  body "Not Found"                  (correct)
 *
 * An error path that used to answer 404 now answers 200 with the string "404",
 * so every client checking `response.ok` reads the failure as a success. The
 * deprecation warning that used to appear on Express 4 is gone with the feature.
 *
 * Gated on `express:5`: on Express 4 these signatures WORK, and reporting them
 * there would be reporting working code.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noStatusCodeAsResponseBody } from "../../src/diagnostics/http/no-status-code-as-response-body.ts";
import { capabilitiesSatisfied } from "../../src/core/project.ts";

const EXPRESS5 = new Set(["node", "esm", "express", "express:5"]);
const findings = (body: string, capabilities: Set<string> = EXPRESS5) =>
  lintSource({
    filePath: "/repo/src/routes.js",
    sourceText: `app.get("/x", (req, res) => { ${body} });`,
    diagnostics: [noStatusCodeAsResponseBody],
    capabilities,
  }).findings.filter((f) => f.diagnostic === "no-status-code-as-response-body");

const fires = (body: string) => {
  const found = findings(body);
  assert.ok(found.length > 0, `expected a FIRE on:\n${body}`);
  return found;
};
const silent = (body: string): void =>
  assert.equal(findings(body).length, 0, `expected SILENCE on:\n${body}`);

describe("no-status-code-as-response-body", () => {
  describe("one argument — a status in the HTTP range", () => {
    test("the canonical error path", () => {
      fires(`res.send(404);`);
    });

    test("any status, including ones with no body of their own", () => {
      // Measured: res.send(204) answers 200 with the body "204", not a 204.
      for (const status of [200, 204, 400, 401, 403, 404, 409, 422, 500, 503]) {
        fires(`res.send(${status});`);
      }
    });

    test("`response` roots it too", () => {
      fires(`response.send(403);`);
    });

    test("the message names the measured behaviour and the fix", () => {
      const [found] = fires(`res.send(404);`);
      assert.match(found!.message, /200 with the body "404"/);
      assert.match(found!.message, /response\.ok/);
      assert.match(found!.recommendation ?? "", /sendStatus|status\(404\)/);
    });
  });

  describe("two arguments — the removed signature, payload discarded", () => {
    test("res.send(status, body)", () => {
      fires(`res.send(500, { error: "boom" });`);
    });

    test("res.json(status, body)", () => {
      fires(`res.json(201, created);`);
    });

    test("res.jsonp(status, body)", () => {
      fires(`res.jsonp(400, payload);`);
    });

    test("arity is the proof, so the range test does not apply", () => {
      // Two arguments to send/json can only be the removed form.
      fires(`res.send(42, payload);`);
    });

    test("the message says the payload is discarded", () => {
      const [found] = fires(`res.json(201, created);`);
      assert.match(found!.message, /payload is discarded/);
    });
  });

  describe("silence — the correct spellings", () => {
    test("status set separately", () => {
      silent(`res.status(404).send();`);
      silent(`res.status(201).json(created);`);
      silent(`res.sendStatus(404);`);
    });

    test("a string body that happens to look like a status", () => {
      // Measured: text/html with the body "404" — correct, if unusual.
      silent(`res.send("404");`);
    });

    test("an ordinary payload", () => {
      silent(`res.json({ ok: 1 });`);
      silent(`res.send(Buffer.from("x"));`);
      silent(`res.send();`);
    });
  });

  describe("precision guards", () => {
    test("a number outside the HTTP range is a plausible numeric body", () => {
      silent(`res.send(42);`);
      silent(`res.send(1000);`);
      silent(`res.send(0);`);
    });

    test("a non-literal cannot be proved to be a status", () => {
      silent(`res.send(count);`);
      silent(`res.send(statusCode);`);
    });

    test("a non-integer literal", () => {
      silent(`res.send(4.04);`);
    });

    test("a `send` on something that is not a response", () => {
      silent(`socket.send(1000, "bye");`);
      silent(`queue.send(404);`);
    });

    test("gated to Express 5 — on Express 4 these signatures work", () => {
      const express4 = new Set(["node", "esm", "express"]);
      // The rule's logic still matches, which is why the GATE is what protects
      // Express 4 users; assert the gate directly rather than the visitor.
      assert.equal(
        capabilitiesSatisfied(noStatusCodeAsResponseBody, express4),
        false,
        "an Express 4 project must never see this",
      );
      assert.ok(capabilitiesSatisfied(noStatusCodeAsResponseBody, EXPRESS5));
      assert.equal(capabilitiesSatisfied(noStatusCodeAsResponseBody, new Set(["node", "esm"])), false);
    });
  });
});
