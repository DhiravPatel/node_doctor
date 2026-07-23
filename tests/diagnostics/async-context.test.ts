/**
 * §152 async-context propagation integrity:
 *   - no-lost-async-context (Reliability, OPT-IN)
 *
 * This test imports the diagnostic module directly and lints with an explicit
 * diagnostic list, so it does NOT depend on the generated registry. The rule is
 * `defaultEnabled: false`, which is irrelevant here — passing it explicitly to
 * `lintSource` runs it regardless of its default-enabled status.
 *
 * The MUST-be-silent cases are the precision contract: each one is a shape where
 * AsyncLocalStorage.getStore() is fine (propagates correctly) or the receiver is
 * not an ALS at all. A false positive on any of them is a release blocker.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noLostAsyncContext } from "../../src/diagnostics/reliability/no-lost-async-context.ts";
import type { Diagnostic } from "../../src/core/types.ts";

const CAPS = new Set(["node", "esm", "typescript"]);

const findingsFor = (diagnostic: Diagnostic, source: string): number => {
  const { findings, parseFailed } = lintSource({
    filePath: "test.ts",
    sourceText: source,
    diagnostics: [diagnostic],
    capabilities: CAPS,
  });
  assert.ok(!parseFailed, `source failed to parse:\n${source}`);
  return findings.filter((f) => f.diagnostic === diagnostic.id).length;
};

const fires = (diagnostic: Diagnostic, source: string): void =>
  assert.ok(findingsFor(diagnostic, source) > 0, `expected ${diagnostic.id} to FIRE on:\n${source}`);

const silent = (diagnostic: Diagnostic, source: string): void =>
  assert.equal(findingsFor(diagnostic, source), 0, `expected ${diagnostic.id} to STAY SILENT on:\n${source}`);

describe("no-lost-async-context", () => {
  const R = noLostAsyncContext;

  // FIRES ------------------------------------------------------------------
  test("fires: getStore() inside an .on listener (binding-resolved ALS)", () => {
    fires(
      R,
      `const als = new AsyncLocalStorage(); emitter.on("data", () => { const c = als.getStore(); use(c); });`,
    );
  });
  test("fires: .once listener variant", () => {
    fires(
      R,
      `const als = new AsyncLocalStorage(); emitter.once("data", () => { const c = als.getStore(); });`,
    );
  });
  test("fires: .addListener variant", () => {
    fires(
      R,
      `const als = new AsyncLocalStorage(); emitter.addListener("data", () => { const c = als.getStore(); });`,
    );
  });
  test("fires: .prependListener variant", () => {
    fires(
      R,
      `const als = new AsyncLocalStorage(); emitter.prependListener("evt", () => { als.getStore(); });`,
    );
  });
  test("fires: FunctionExpression listener (not just arrow)", () => {
    fires(
      R,
      `const als = new AsyncLocalStorage(); emitter.on("data", function () { const c = als.getStore(); });`,
    );
  });
  test("fires: getStore nested in a block inside the listener", () => {
    fires(
      R,
      `const als = new AsyncLocalStorage(); emitter.on("data", () => { if (x) { const c = als.getStore(); } });`,
    );
  });
  test("fires: arrow with expression body", () => {
    fires(
      R,
      `const als = new AsyncLocalStorage(); emitter.on("data", () => als.getStore());`,
    );
  });
  test("fires: name-heuristic receiver with ALS imported (asyncLocalStorage)", () => {
    fires(
      R,
      `import { AsyncLocalStorage } from "node:async_hooks"; bus.on("tick", () => { const c = asyncLocalStorage.getStore(); });`,
    );
  });
  test("silent: generic name-heuristic receiver 'storage'/'context' is too broad (narrowed to als/asyncLocalStorage)", () => {
    // `storage`/`context` name too many non-ALS objects with a getStore-like method;
    // only unmistakably-ALS names (als/asyncLocalStorage) trip the name branch.
    silent(
      R,
      `const { AsyncLocalStorage } = require("async_hooks"); bus.on("tick", () => { storage.getStore(); });`,
    );
    silent(
      R,
      `import { AsyncLocalStorage } from "async_hooks"; bus.on("tick", () => { context.getStore(); });`,
    );
  });
  test("fires: new async_hooks.AsyncLocalStorage() member-constructed binding", () => {
    fires(
      R,
      `const als = new async_hooks.AsyncLocalStorage(); emitter.on("data", () => { als.getStore(); });`,
    );
  });

  // MUST BE SILENT ---------------------------------------------------------
  test("silent: als.run(store, fn) direct run scope (not an emitter)", () => {
    silent(
      R,
      `const als = new AsyncLocalStorage(); als.run(store, () => { const c = als.getStore(); });`,
    );
  });
  test("silent: setTimeout callback propagates in modern Node", () => {
    silent(
      R,
      `const als = new AsyncLocalStorage(); setTimeout(() => { als.getStore(); }, 0);`,
    );
  });
  test("silent: setTimeout nested inside a listener (nearest fn is the timer)", () => {
    silent(
      R,
      `const als = new AsyncLocalStorage(); emitter.on("data", () => { setTimeout(() => als.getStore(), 0); });`,
    );
  });
  test("silent: process.nextTick callback propagates", () => {
    silent(
      R,
      `const als = new AsyncLocalStorage(); process.nextTick(() => { als.getStore(); });`,
    );
  });
  test("silent: queueMicrotask callback propagates", () => {
    silent(
      R,
      `const als = new AsyncLocalStorage(); queueMicrotask(() => { als.getStore(); });`,
    );
  });
  test("silent: getStore at function top-level, not in any emitter callback", () => {
    silent(
      R,
      `const als = new AsyncLocalStorage(); function handle() { const c = als.getStore(); return c; }`,
    );
  });
  test("silent: getStore at module top-level (no enclosing function)", () => {
    silent(R, `const als = new AsyncLocalStorage(); const c = als.getStore();`);
  });
  test("silent: foo.getStore() where foo is not an AsyncLocalStorage", () => {
    silent(R, `emitter.on("data", () => { const c = foo.getStore(); });`);
  });
  test("silent: ALS-shaped name but file never imports AsyncLocalStorage", () => {
    silent(R, `emitter.on("data", () => { const c = context.getStore(); });`);
  });
  test("silent: store captured BEFORE .on, then used inside the listener", () => {
    silent(
      R,
      `const als = new AsyncLocalStorage(); const ctx = als.getStore(); emitter.on("data", () => use(ctx));`,
    );
  });
  test("silent: als.getStore() inside an await/promise chain, not an emitter", () => {
    silent(
      R,
      `const als = new AsyncLocalStorage(); async function f() { await tick(); const c = als.getStore(); }`,
    );
  });
  test("silent: .emit is not a registration method", () => {
    silent(
      R,
      `const als = new AsyncLocalStorage(); emitter.emit("data", () => { const c = als.getStore(); });`,
    );
  });
});
