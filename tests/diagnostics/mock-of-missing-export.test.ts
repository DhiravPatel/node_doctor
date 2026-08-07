/**
 * §175 — `no-mock-of-missing-export`.
 *
 * The claim is "that module does not export this name", which is false the
 * moment the export surface cannot be fully enumerated. Every silence below is
 * a surface this cannot read: a barrel's `export *`, a CommonJS module built at
 * runtime, a partial mock that spreads the real module.
 *
 * Project-scope, so `lintSource` cannot drive it — these run a real `scanProject`
 * over a temp project.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scanProject } from "../../src/core/scan.ts";

const RULE = "no-mock-of-missing-export";

const findingsFor = async (files: Record<string, string>): Promise<string[]> => {
  const dir = await mkdtemp(join(tmpdir(), "nd-mockdrift-"));
  try {
    await writeFile(
      join(dir, "package.json"),
      `{ "name": "app", "version": "1.0.0", "type": "module" }`,
    );
    for (const [rel, src] of Object.entries(files)) {
      const full = join(dir, rel);
      await mkdir(join(full, ".."), { recursive: true });
      await writeFile(full, src);
    }
    const report = await scanProject({
      rootDirectory: dir,
      // Opt-in rule: enable it explicitly, exactly as a user's config would.
      config: { diagnostics: { [RULE]: "warn" } },
    });
    return report.findings.filter((f) => f.diagnostic === RULE).map((f) => f.message);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const fires = async (files: Record<string, string>): Promise<string[]> => {
  const found = await findingsFor(files);
  assert.ok(found.length > 0, `expected ${RULE} to FIRE on:\n${JSON.stringify(files, null, 1)}`);
  return found;
};

const silent = async (files: Record<string, string>): Promise<void> => {
  const found = await findingsFor(files);
  assert.equal(
    found.length,
    0,
    `expected ${RULE} to STAY SILENT, got ${found.length}:\n` +
      found.map((m) => `  - ${m}`).join("\n") +
      `\n--- files ---\n${JSON.stringify(files, null, 1)}`,
  );
};

describe("no-mock-of-missing-export — fires", () => {
  test("a mock stubs a member the module does not export", async () => {
    const [message] = await fires({
      "src/service.ts": `export const fetchUser = async (id) => ({ id });\n`,
      "src/service.test.ts": `import { vi } from "vitest";\nvi.mock("./service.ts", () => ({ getUser: vi.fn() }));\n`,
    });
    assert.match(message!, /`getUser`/);
    assert.match(message!, /drifted/);
  });

  test("jest.mock, vi.doMock and jest.doMock all count", async () => {
    for (const call of ["jest.mock", "vi.doMock", "jest.doMock"]) {
      await fires({
        "src/service.ts": `export const fetchUser = () => 1;\n`,
        "src/a.test.ts": `${call}("./service.ts", () => ({ getUser: 1 }));\n`,
      });
    }
  });

  test("a `return { … }` factory body is read too", async () => {
    await fires({
      "src/service.ts": `export const fetchUser = () => 1;\n`,
      "src/a.test.ts": `vi.mock("./service.ts", () => { return { getUser: vi.fn() }; });\n`,
    });
  });

  test("only the drifted key is reported, not the whole mock", async () => {
    const found = await fires({
      "src/service.ts": `export const fetchUser = () => 1;\nexport const listUsers = () => [];\n`,
      "src/a.test.ts": `vi.mock("./service.ts", () => ({ fetchUser: 1, listUsers: 2, getUser: 3 }));\n`,
    });
    assert.equal(found.length, 1);
    assert.match(found[0]!, /`getUser`/);
  });

  test("a string-literal key is read like an identifier key", async () => {
    await fires({
      "src/service.ts": `export const fetchUser = () => 1;\n`,
      "src/a.test.ts": `vi.mock("./service.ts", () => ({ "getUser": 1 }));\n`,
    });
  });
});

describe("no-mock-of-missing-export — silent", () => {
  test("every mocked member really is exported", async () => {
    await silent({
      "src/service.ts": `export const fetchUser = () => 1;\nexport function listUsers() { return []; }\nexport class Repo {}\n`,
      "src/a.test.ts": `vi.mock("./service.ts", () => ({ fetchUser: 1, listUsers: 2, Repo: 3 }));\n`,
    });
  });

  test("every export form is recognized", async () => {
    await silent({
      "src/inner.ts": `export const inner = 1;\n`,
      "src/service.ts":
        `const a = 1;\nexport { a as renamed };\nexport { inner } from "./inner.ts";\n` +
        `export type Shape = { x: number };\nexport interface Other { y: number }\nexport enum E { A }\n`,
      "src/a.test.ts": `vi.mock("./service.ts", () => ({ renamed: 1, inner: 2, Shape: 3, Other: 4, E: 5 }));\n`,
    });
  });

  test("a barrel's `export *` makes the surface unreadable — abstain", async () => {
    await silent({
      "src/inner.ts": `export const inner = 1;\n`,
      "src/index.ts": `export * from "./inner.ts";\n`,
      "src/a.test.ts": `vi.mock("./index.ts", () => ({ anythingAtAll: 1 }));\n`,
    });
  });

  test("a CommonJS surface is built at runtime — abstain", async () => {
    await silent({
      "src/service.cjs": `module.exports = { fetchUser: () => 1 };\n`,
      "src/a.test.ts": `vi.mock("./service.cjs", () => ({ getUser: 1 }));\n`,
    });
    await silent({
      "src/other.cjs": `exports.fetchUser = () => 1;\n`,
      "src/b.test.ts": `vi.mock("./other.cjs", () => ({ getUser: 1 }));\n`,
    });
  });

  test("a module with no ESM exports is unreadable, not empty", async () => {
    await silent({
      "src/side-effect.ts": `console.log("boot");\n`,
      "src/a.test.ts": `vi.mock("./side-effect.ts", () => ({ anything: 1 }));\n`,
    });
  });

  test("a partial mock that spreads the real module supplies names this cannot see", async () => {
    await silent({
      "src/service.ts": `export const fetchUser = () => 1;\n`,
      "src/a.test.ts":
        `vi.mock("./service.ts", async () => ({ ...(await vi.importActual("./service.ts")), getUser: 1 }));\n`,
    });
  });

  test("an auto-mock has no keys to check", async () => {
    await silent({
      "src/service.ts": `export const fetchUser = () => 1;\n`,
      "src/a.test.ts": `vi.mock("./service.ts");\n`,
    });
  });

  test("a package specifier is not in the graph", async () => {
    await silent({
      "src/a.test.ts": `vi.mock("axios", () => ({ notARealExport: 1 }));\n`,
      "src/b.test.ts": `vi.mock("node:fs", () => ({ alsoNotReal: 1 }));\n`,
    });
  });

  test("an unresolvable relative specifier claims nothing", async () => {
    await silent({
      "src/a.test.ts": `vi.mock("./does-not-exist.ts", () => ({ whatever: 1 }));\n`,
    });
  });

  test("`default` and `__esModule` are interop keys, never checked", async () => {
    await silent({
      "src/service.ts": `export const fetchUser = () => 1;\n`,
      "src/a.test.ts": `vi.mock("./service.ts", () => ({ __esModule: true, default: {}, fetchUser: 1 }));\n`,
    });
  });

  test("a computed key is not a name this can check", async () => {
    await silent({
      "src/service.ts": `export const fetchUser = () => 1;\n`,
      "src/a.test.ts": `const k = "getUser";\nvi.mock("./service.ts", () => ({ [k]: 1 }));\n`,
    });
  });

  test("a factory that computes its shape is not an object literal", async () => {
    await silent({
      "src/service.ts": `export const fetchUser = () => 1;\n`,
      "src/a.test.ts": `vi.mock("./service.ts", () => buildMock());\n`,
    });
    await silent({
      "src/service.ts": `export const fetchUser = () => 1;\n`,
      "src/b.test.ts": `vi.mock("./service.ts", () => { const m = {}; m.getUser = 1; return m; });\n`,
    });
  });

  test("a `mock` call on something that is not jest/vi", async () => {
    await silent({
      "src/service.ts": `export const fetchUser = () => 1;\n`,
      "src/a.test.ts": `registry.mock("./service.ts", () => ({ getUser: 1 }));\n`,
    });
  });
});

describe("no-mock-of-missing-export — determinism", () => {
  test("the same project yields identical findings", async () => {
    const files = {
      "src/service.ts": `export const fetchUser = () => 1;\n`,
      "src/a.test.ts": `vi.mock("./service.ts", () => ({ getUser: 1, listUsers: 2 }));\n`,
    };
    const a = await findingsFor(files);
    const b = await findingsFor(files);
    assert.deepEqual(a, b);
    assert.equal(a.length, 2, "each drifted key is its own finding");
  });
});
