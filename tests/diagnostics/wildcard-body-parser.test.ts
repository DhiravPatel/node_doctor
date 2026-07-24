/**
 * Self-contained tests for `no-wildcard-body-parser`. The rule is opt-in and not
 * in the generated registry (we deliberately do not run gen:registry), so we
 * import it directly and drive `lintSource` with an explicit single-rule list
 * rather than the registry-backed `expectFires`/`expectSilent` helpers.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noWildcardBodyParser } from "../../src/diagnostics/http/no-wildcard-body-parser.ts";

const CAPS = new Set(["node", "esm", "typescript", "express"]);

const findings = (source: string) =>
  lintSource({
    filePath: "test.ts",
    sourceText: source,
    diagnostics: [noWildcardBodyParser],
    capabilities: CAPS,
  }).findings.filter((f) => f.diagnostic === "no-wildcard-body-parser");

const fires = (source: string): void => {
  const found = findings(source);
  assert.ok(found.length > 0, `expected no-wildcard-body-parser to FIRE on:\n${source}`);
};

const silent = (source: string): void => {
  const found = findings(source);
  assert.equal(
    found.length,
    0,
    `expected no-wildcard-body-parser to STAY SILENT, got ${found.length}:\n` +
      found.map((f) => `  - ${f.message}`).join("\n") +
      `\n--- source ---\n${source}`,
  );
};

describe("no-wildcard-body-parser", () => {
  // ---- FIRES ---------------------------------------------------------------

  test('fires: express.json({ type: "*/*" })', () => {
    fires(`app.use(express.json({ type: "*/*" }));`);
  });

  test("fires: bodyParser.urlencoded({ type: () => true })", () => {
    fires(`app.use(bodyParser.urlencoded({ type: () => true }));`);
  });

  test('fires: express.raw({ type: "*/*" })', () => {
    fires(`express.raw({ type: "*/*" });`);
  });

  test('fires: express.text({ type: "*/*" })', () => {
    fires(`app.use(express.text({ type: "*/*" }));`);
  });

  test('fires: bodyParser.json({ type: "*/*" })', () => {
    fires(`app.use(bodyParser.json({ type: "*/*" }));`);
  });

  test("fires: type is a block-body function returning true", () => {
    fires(`app.use(express.json({ type: function () { return true; } }));`);
  });

  test("fires: arrow block body `() => { return true; }`", () => {
    fires(`app.use(express.urlencoded({ type: () => { return true; } }));`);
  });

  test('fires: wildcard alongside other options (limit) still fires', () => {
    fires(`app.use(express.json({ limit: "1mb", type: "*/*" }));`);
  });

  test("fires: bare json() from a body-parser named import", () => {
    fires(`import { json } from "body-parser";\napp.use(json({ type: "*/*" }));`);
  });

  test("fires: bare aliased urlencoded from body-parser (require destructure)", () => {
    fires(`const { urlencoded: form } = require("body-parser");\napp.use(form({ type: () => true }));`);
  });

  // ---- SILENT --------------------------------------------------------------

  test("silent: express.json() with no options", () => {
    silent(`app.use(express.json());`);
  });

  test("silent: express.response.json / express.request.json (the res.json serializer, not a parser)", () => {
    silent(`import express from "express"; express.response.json({ type: "*/*" });`);
    silent(`express.request.json({ type: "*/*" });`);
  });

  test('silent: express.json({ type: "application/json" })', () => {
    silent(`app.use(express.json({ type: "application/json" }));`);
  });

  test('silent: only a limit option, no type', () => {
    silent(`app.use(express.json({ limit: "1mb" }));`);
  });

  test("silent: type is a list of scoped media types", () => {
    silent(`app.use(express.json({ type: ["application/json", "application/*+json"] }));`);
  });

  test('silent: scoped subtype "text/*"', () => {
    silent(`app.use(express.text({ type: "text/*" }));`);
  });

  test("silent: dynamic/opaque type value (variable)", () => {
    silent(`app.use(express.json({ type: userType }));`);
  });

  test("silent: express.static is not a body parser", () => {
    silent(`app.use(express.static(dir));`);
  });

  test("silent: unrelated middleware cors()", () => {
    silent(`app.use(cors());`);
  });

  test("silent: a validating type predicate (not trivially true)", () => {
    silent(`app.use(express.json({ type: (req) => req.headers["content-type"] === "application/json" }));`);
  });

  test("silent: bare json() with NO body-parser import", () => {
    silent(`app.use(json({ type: "*/*" }));`);
  });

  test("silent: options is an opaque identifier, not a literal object", () => {
    silent(`app.use(express.json(opts));`);
  });

  test("silent: res.json() lookalike on a request handler", () => {
    silent(`app.get("/x", (req, res) => { res.json({ type: "*/*" }); });`);
  });
});
