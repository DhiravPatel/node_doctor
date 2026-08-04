/**
 * §174 `no-flaky-test-pattern` and §176 `no-tautological-mock-assertion`.
 *
 * Both are opt-in and not in the generated registry for these tests, so we import
 * them directly and drive `lintSource` with an explicit single-rule list.
 *
 * As with §173, the silence cases carry the weight: these rules read a project's
 * own test suite, and a false positive there lands on code the author trusts.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noFlakyTestPattern } from "../../src/diagnostics/maintainability/no-flaky-test-pattern.ts";
import { noTautologicalMockAssertion } from "../../src/diagnostics/maintainability/no-tautological-mock-assertion.ts";

const CAPS = new Set(["node", "esm", "typescript"]);

const makeAsserts = (rule: typeof noFlakyTestPattern | typeof noTautologicalMockAssertion) => ({
  fires: (source: string, filePath = "/repo/thing.test.ts") => {
    const found = lintSource({ filePath, sourceText: source, diagnostics: [rule], capabilities: CAPS })
      .findings.filter((f) => f.diagnostic === rule.id);
    assert.ok(found.length > 0, `expected ${rule.id} to FIRE on:\n${source}`);
  },
  silent: (source: string, filePath = "/repo/thing.test.ts") => {
    const found = lintSource({ filePath, sourceText: source, diagnostics: [rule], capabilities: CAPS })
      .findings.filter((f) => f.diagnostic === rule.id);
    assert.equal(
      found.length,
      0,
      `expected ${rule.id} to STAY SILENT, got ${found.length}:\n` +
        found.map((f) => `  - ${f.message}`).join("\n") +
        `\n--- source ---\n${source}`,
    );
  },
});

const flaky = makeAsserts(noFlakyTestPattern);
const tauto = makeAsserts(noTautologicalMockAssertion);

const V = `import { describe, it, expect, vi } from "vitest";\nimport { save, renderProfile } from "../src/app";\n`;

// ---------------------------------------------------------------------------
// §174 — no-flaky-test-pattern
// ---------------------------------------------------------------------------

describe("no-flaky-test-pattern — fires", () => {
  test("a hard-coded sleep", () => {
    flaky.fires(V + `it("waits", async () => { await new Promise((r) => setTimeout(r, 500)); expect(1).toBe(1); });`);
  });

  test("an assertion against the live clock", () => {
    flaky.fires(V + `it("stamps", () => { expect(save().createdAt).toBe(Date.now()); });`);
  });

  test("an assertion against `new Date()`", () => {
    flaky.fires(V + `it("stamps", () => { expect(save().at).toEqual(new Date()); });`);
  });

  test("Math.random() in the case body", () => {
    flaky.fires(V + `it("random id", () => { const id = Math.random(); expect(save(id)).toBeTruthy(); });`);
  });
});

describe("no-flaky-test-pattern — silent", () => {
  test("a controlled clock makes the sleep and the clock read deterministic", () => {
    flaky.silent(
      V + `beforeEach(() => vi.useFakeTimers());\nit("waits", async () => { await new Promise((r) => setTimeout(r, 500)); expect(1).toBe(1); });`,
    );
    flaky.silent(
      V + `beforeEach(() => vi.useFakeTimers());\nit("stamps", () => { expect(save().createdAt).toBe(Date.now()); });`,
    );
  });

  test("a setTimeout that schedules real work is not a sleep", () => {
    flaky.silent(
      V + `it("schedules", () => { setTimeout(() => { save(); flush(); notify(); }, 100); expect(true).toBe(true); });`,
    );
  });

  test("a clock read used to BUILD a fixture, not to assert", () => {
    flaky.silent(V + `it("builds", () => { const at = Date.now(); expect(save({ at }).ok).toBe(true); });`);
  });

  test("waiting for a condition rather than a duration", () => {
    flaky.silent(V + `it("waits", async () => { await waitFor(() => expect(el).toBeVisible()); });`);
  });

  test("a skipped case", () => {
    flaky.silent(V + `it.skip("waits", async () => { await new Promise((r) => setTimeout(r, 500)); });`);
  });

  test("a non-test file is never analyzed", () => {
    flaky.silent(
      `export const delay = (ms) => new Promise((r) => setTimeout(r, ms));\nexport const id = () => Math.random();`,
      "/repo/src/util.ts",
    );
  });
});

// ---------------------------------------------------------------------------
// §176 — no-tautological-mock-assertion
// ---------------------------------------------------------------------------

describe("no-tautological-mock-assertion — fires", () => {
  test("asserting a mock's configured return value back to itself", () => {
    tauto.fires(
      V + `const getUser = vi.fn().mockReturnValue({ id: 1 });\nit("x", () => { expect(getUser()).toEqual({ id: 1 }); });`,
    );
  });

  test("the jest dialect", () => {
    tauto.fires(
      `import { it, expect, jest } from "@jest/globals";\nconst f = jest.fn().mockReturnValue(42);\nit("x", () => { expect(f()).toBe(42); });`,
    );
  });

  test("an awaited resolved mock", () => {
    tauto.fires(
      V + `const load = vi.fn().mockResolvedValue({ ok: true });\nit("x", async () => { expect(await load()).toEqual({ ok: true }); });`,
    );
  });
});

describe("no-tautological-mock-assertion — silent", () => {
  test("the mock's value flows through real code — that is a real test", () => {
    tauto.silent(
      V + `const getUser = vi.fn().mockReturnValue({ id: 1 });\nit("x", () => { expect(renderProfile(getUser())).toBe("User 1"); });`,
    );
  });

  test("a behavioural assertion about how our code used the mock", () => {
    tauto.silent(
      V + `const getUser = vi.fn().mockReturnValue({ id: 1 });\nit("x", () => { save(); expect(getUser).toHaveBeenCalledWith(1); });`,
    );
  });

  test("an unconfigured mock (no fixed return value to restate)", () => {
    tauto.silent(V + `const spy = vi.fn();\nit("x", () => { save(); expect(spy).toHaveBeenCalled(); });`);
  });

  test("asserting on real code with no mock in the file", () => {
    tauto.silent(V + `it("x", () => { expect(save({ id: 1 })).toEqual({ id: 1 }); });`);
  });

  test("a non-test file is never analyzed", () => {
    tauto.silent(
      `const getUser = vi.fn().mockReturnValue({ id: 1 });\nexport const run = () => getUser();`,
      "/repo/src/util.ts",
    );
  });
});

// ---------------------------------------------------------------------------
// Hunt regressions — each of these previously fired on correct, deterministic
// test code. The lesson is the same in every case: the shape alone is not the
// bug; the bug needs the shape PLUS proof that it is actually racing.
// ---------------------------------------------------------------------------

describe("no-flaky-test-pattern — hunt regressions", () => {
  test("a clock read wrapped in a PREDICATE is deterministic", () => {
    // The assertion is about a property that holds at any instant, not about
    // the instant itself.
    flaky.silent(V + `it("not expired", () => { expect(isExpired(Date.now())).toBe(false); });`);
    flaky.silent(V + `it("valid date", () => { expect(isValidDate(new Date())).toBe(true); });`);
  });

  test("a setTimeout whose handle is returned or cleared is scheduling, not sleeping", () => {
    flaky.silent(
      V + `it("handle", () => { const h = setTimeout(cleanup, 5000); expect(h).toBeDefined(); clearTimeout(h); });`,
    );
    flaky.silent(
      V + `it("async", () => { const spy = vi.fn(); const id = setTimeout(() => spy(), 100); expect(spy).not.toHaveBeenCalled(); clearTimeout(id); });`,
    );
  });

  test("Math.random stubbed by hand or by a spy is deterministic", () => {
    flaky.silent(
      V + `it("stubbed", () => { const o = Math.random; Math.random = () => 0.5; expect(pickShard()).toBe(2); Math.random = o; });`,
    );
    flaky.silent(
      V + `beforeEach(() => vi.spyOn(Math, "random").mockReturnValue(0.5));
it("spied", () => { expect(pickShard()).toBe(2); });`,
    );
  });

  test("the genuine sleep still fires (the guards must not disarm the rule)", () => {
    flaky.fires(V + `it("sleeps", async () => { await new Promise((r) => setTimeout(r, 500)); expect(1).toBe(1); });`);
  });
});

describe("no-tautological-mock-assertion — hunt regressions", () => {
  test("a bare `stub()`/`fn()` is not proof of a mock — it may be a fixture builder", () => {
    tauto.silent(
      V + `const stub = (kind) => ({ returns: (v) => ({ kind, v }) });
const rec = stub("user").returns({ id: 1 });
it("x", () => { expect(rec.v).toEqual({ id: 1 }); });`,
    );
  });

  test("a mocking library's OWN suite, where fn/stub are the code under test", () => {
    tauto.silent(
      `import { it, expect } from "vitest";
import { fn } from "../src/mock.ts";
const m = fn().returns(7);
it("returns the configured value", () => { expect(m()).toBe(7); });`,
    );
  });

  test("a REASSIGNED binding may hold the real implementation by the time it runs", () => {
    tauto.silent(
      V + `let render = vi.fn().mockReturnValue("<p>stub</p>");
render = renderMarkdown;
it("x", () => { expect(render("x")).toBe("<p>stub</p>"); });`,
    );
  });

  test("a mock used to make output deterministic, with REAL code asserted", () => {
    tauto.silent(
      V + `const md5 = vi.fn().mockReturnValue("abc123");
it("x", () => { expect(buildRecord("k", md5())).toEqual({ k: "abc123" }); });`,
    );
  });

  test("the genuine tautology still fires", () => {
    tauto.fires(
      V + `const getUser = vi.fn().mockReturnValue({ id: 1 });
it("x", () => { expect(getUser()).toEqual({ id: 1 }); });`,
    );
  });
});
