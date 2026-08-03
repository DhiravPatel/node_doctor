/**
 * §173 — `no-assertion-free-test`.
 *
 * The rule is opt-in and not in the generated registry for these tests, so we
 * import it directly and drive `lintSource` with an explicit single-rule list.
 *
 * The silence cases matter more than the firing ones here: a false "this test
 * asserts nothing" claim lands on code the author believes is correct. The
 * delegation cases below are drawn from real suite styles, including this
 * project's own (`cron.fires(src)`), which an earlier name-based design
 * false-positived on 674 times.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noAssertionFreeTest } from "../../src/diagnostics/maintainability/no-assertion-free-test.ts";

const CAPS = new Set(["node", "esm", "typescript"]);

const findings = (source: string, filePath = "/repo/thing.test.ts") =>
  lintSource({ filePath, sourceText: source, diagnostics: [noAssertionFreeTest], capabilities: CAPS })
    .findings.filter((f) => f.diagnostic === "no-assertion-free-test");

const fires = (source: string, filePath?: string): void => {
  const found = findings(source, filePath);
  assert.ok(found.length > 0, `expected no-assertion-free-test to FIRE on:\n${source}`);
};

const silent = (source: string, filePath?: string): void => {
  const found = findings(source, filePath);
  assert.equal(
    found.length,
    0,
    `expected no-assertion-free-test to STAY SILENT, got ${found.length}:\n` +
      found.map((f) => `  - ${f.message}`).join("\n") +
      `\n--- source ---\n${source}`,
  );
};

const V = `import { describe, it, expect } from "vitest";\nimport { createUser } from "../src/api";\n`;

describe("no-assertion-free-test — fires", () => {
  test("a test that exercises imported code and never asserts", () => {
    fires(V + `it("creates a user", async () => { await createUser({ email: "a@b.c" }); });`);
  });

  test("multiple statements, still no assertion", () => {
    fires(
      V +
        `it("does the thing", async () => {\n  const a = await createUser({});\n  const b = await createUser({});\n});`,
    );
  });

  test("inside a describe block", () => {
    fires(V + `describe("users", () => {\n  it("works", async () => { await createUser({}); });\n});`);
  });

  test("a node:test file with no assertion", () => {
    fires(
      `import { test } from "node:test";\nimport { createUser } from "../src/api";\ntest("creates", async () => { await createUser({}); });`,
    );
  });
});

describe("no-assertion-free-test — silent when an assertion exists, in any dialect", () => {
  test("jest/vitest expect", () => {
    silent(V + `it("works", async () => { const u = await createUser({}); expect(u.id).toBe(1); });`);
  });

  test("node:assert", () => {
    silent(
      `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { createUser } from "../src/api";\ntest("works", async () => { const u = await createUser({}); assert.equal(u.id, 1); });`,
    );
  });

  test("chai should, on a call result (no static member path)", () => {
    silent(
      `import { it } from "mocha";\nimport { createUser } from "../src/api";\nit("works", () => { createUser({}).should.have.property("id"); });`,
    );
  });

  test("ava-style t.is", () => {
    silent(
      `import test from "ava";\nimport { createUser } from "../src/api";\ntest("works", (t) => { t.is(createUser({}).id, 1); });`,
    );
  });

  test("supertest .expect(200)", () => {
    silent(
      `import request from "supertest";\nimport { app } from "../src/app";\nit("works", async () => { await request(app).get("/x").expect(200); });`,
    );
  });

  test("a rejection assertion", () => {
    silent(V + `it("rejects", async () => { await expect(createUser(null)).rejects.toThrow(); });`);
  });

  test("expect.assertions(n) declares assertions happen out of sight", () => {
    silent(V + `it("async", async () => { expect.assertions(1); await createUser({}); });`);
  });
});

describe("no-assertion-free-test — silent when the assertion is delegated (the 674-FP class)", () => {
  test("a LOCAL helper object's method — this project's own style", () => {
    silent(
      `import { describe, test } from "node:test";\nimport { lintSource } from "../../src/core/scan.ts";\n` +
        `const cron = makeAsserts(rule);\n` +
        `test("fires on a bad expression", () => { cron.fires("0 25 * * *"); });`,
    );
  });

  test("a LOCAL helper function", () => {
    silent(
      V +
        `const runScenario = (src) => { expect(src).toBeTruthy(); };\n` +
        `it("scenario", () => { runScenario("x"); });`,
    );
  });

  test("a helper imported from a helpers module", () => {
    silent(
      `import { it } from "vitest";\nimport { runCase } from "./helpers";\nit("works", () => { runCase("x"); });`,
    );
  });

  test("an imported name that announces it asserts", () => {
    silent(
      `import { it } from "vitest";\nimport { expectValid } from "../shared";\nit("works", () => { expectValid({}); });`,
    );
  });

  test("a locally-destructured helper", () => {
    silent(
      V + `const { ok } = makeHelpers();\nit("works", () => { ok(createUser({})); });`,
    );
  });
});

describe("no-assertion-free-test — silent outside a proven test case", () => {
  test("a skipped or todo case asserts nothing by design", () => {
    silent(V + `it.skip("later", async () => { await createUser({}); });`);
    silent(V + `it.todo("later");`);
    silent(V + `xit("later", async () => { await createUser({}); });`);
  });

  test("an empty body is a placeholder, not false confidence", () => {
    silent(V + `it("placeholder", () => {});`);
  });

  test("a NON-test file that happens to define `test` is never analyzed", () => {
    silent(
      `export const test = (fn) => fn();\nexport const run = () => { test(() => doWork()); };`,
      "/repo/src/runner.ts",
    );
  });

  test("a production file on a test-shaped path with no runner and no test calls", () => {
    silent(`export const helper = () => doWork();`, "/repo/test/helper.ts");
  });

  test("a describe block itself is not a case", () => {
    silent(V + `describe("group", () => { it("works", () => { expect(1).toBe(1); }); });`);
  });
});

describe("no-assertion-free-test — hunt regressions: assertion dialects", () => {
  test("node:test's own `t.assert.*` context surface (Node 22+)", () => {
    silent(
      `import { test } from "node:test";\nimport { parsePort } from "../src/config.ts";\n` +
        `test("parses", (t) => { t.assert.strictEqual(parsePort("8080"), 8080); });`,
    );
    silent(
      `import { test } from "node:test";\nimport { parsePort } from "../src/config.ts";\n` +
        `test("parses", (t) => { t.assert.ok(parsePort("80")); });`,
    );
  });

  test("destructured node:assert helpers called bare", () => {
    silent(
      `import { test } from "node:test";\nimport { strictEqual } from "node:assert";\nimport { parsePort } from "../src/config.ts";\n` +
        `test("parses", () => { strictEqual(parsePort("8080"), 8080); });`,
    );
    silent(
      `import { test } from "node:test";\nimport { ok, match } from "node:assert/strict";\nimport { parsePort } from "../src/config.ts";\n` +
        `test("parses", () => { ok(parsePort("80")); });`,
    );
  });

  test("tape's context assertions", () => {
    silent(
      `import tape from "tape";\nimport { parsePort } from "../src/config.ts";\n` +
        `tape("parses", (t) => { t.equal(parsePort("8080"), 8080); t.end(); });`,
    );
  });

  test("a benchmark is not a test case — it asserts nothing by design", () => {
    silent(
      `import { bench, describe } from "vitest";\nimport { parse } from "../src/parse.ts";\n` +
        `describe("parse", () => { bench("small", () => { parse(SMALL); }); });`,
      "/repo/parse.bench.ts",
    );
  });

  test("production code importing node:assert for runtime invariants is not a test", () => {
    silent(
      `import assert from "node:assert";\nimport { pingDatabase } from "./clients.ts";\n` +
        `export async function health() { const r = await pingDatabase(); assert(r.ok, "db down"); return r; }`,
      "/repo/src/health.ts",
    );
  });
});
