/**
 * §155 — Internal Package API Semver Linting.
 *
 * Covers surface extraction (named/default/class/type/CJS exports, `export *`
 * following, dist→src entry fallback), the baseline diff (removed = breaking,
 * added = minor-expected), version-bump verdicts (major clears a removal; a 0.x
 * minor does too), the partial-surface refusal to claim removals, workspace vs
 * single-package roots, and determinism.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApiSemverReport, type ApiSemverReport } from "../../src/core/api-semver.ts";

const makeProject = async (files: Record<string, string>): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "nd-semver-"));
  for (const [rel, src] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, src);
  }
  return dir;
};

const pkg = (r: ApiSemverReport, name: string) => {
  const p = r.packages.find((x) => x.name === name);
  assert.ok(p, `expected package ${name}`);
  return p!;
};

const WORKSPACE = {
  "package.json": `{ "name": "root", "private": true, "workspaces": ["packages/*"] }`,
  "packages/api/package.json": `{ "name": "@acme/api", "version": "1.2.0", "main": "dist/index.js" }`,
  "packages/api/src/index.ts": `
export const createServer = () => {};
export function stopServer() {}
export class Router {}
export type RouteConfig = { path: string };
export * from "./helpers.ts";
export default createServer;
`,
  "packages/api/src/helpers.ts": `
export const parseQuery = (q) => q;
export const buildUrl = (p) => p;
`,
  "packages/shared/package.json": `{ "name": "@acme/shared", "version": "0.3.1" }`,
  "packages/shared/src/index.ts": `
export const logger = {};
export const config = {};
`,
};

describe("buildApiSemverReport — surface extraction", () => {
  test("workspace members, dist→src fallback, star re-exports, defaults, types", async () => {
    const dir = await makeProject(WORKSPACE);
    try {
      const r = await buildApiSemverReport(dir);
      const api = pkg(r, "@acme/api");
      assert.equal(api.entry, "packages/api/src/index.ts", "dist/index.js falls back to src/index.ts");
      assert.equal(api.complete, true);
      assert.deepEqual(api.exports, [
        "RouteConfig", "Router", "buildUrl", "createServer", "default", "parseQuery", "stopServer",
      ]);
      assert.deepEqual(pkg(r, "@acme/shared").exports, ["config", "logger"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("destructuring exports bind the VALUE side, never the property key", async () => {
    const dir = await makeProject({
      "package.json": `{ "name": "pat", "version": "1.0.0" }`,
      "src/index.ts": `
export const { parse: parseIt, stringify } = JSON;
export const [first, , third = 3, ...others] = arr;
`,
    });
    try {
      const r = await buildApiSemverReport(dir);
      assert.deepEqual(pkg(r, "pat").exports, ["first", "others", "parseIt", "stringify", "third"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a single-package repo (no workspaces) analyzes the root", async () => {
    const dir = await makeProject({
      "package.json": `{ "name": "solo", "version": "3.1.0" }`,
      "src/index.ts": `export const one = 1;\nexport const two = 2;`,
    });
    try {
      const r = await buildApiSemverReport(dir);
      assert.equal(r.packages.length, 1);
      assert.deepEqual(pkg(r, "solo").exports, ["one", "two"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("CommonJS surfaces: exports.x and module.exports = { … }", async () => {
    const dir = await makeProject({
      "package.json": `{ "name": "cjs", "version": "1.0.0", "main": "index.js" }`,
      "index.js": `
exports.readThing = function () {};
module.exports.writeThing = () => {};
`,
    });
    try {
      const r = await buildApiSemverReport(dir);
      assert.deepEqual(pkg(r, "cjs").exports, ["readThing", "writeThing"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an unfollowable `export *` marks the surface partial", async () => {
    const dir = await makeProject({
      "package.json": `{ "name": "wild", "version": "1.0.0" }`,
      "src/index.ts": `export const known = 1;\nexport * from "some-external-pkg";`,
    });
    try {
      const r = await buildApiSemverReport(dir);
      const p = pkg(r, "wild");
      assert.equal(p.complete, false);
      assert.deepEqual(p.exports, ["known"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a package with no resolvable entry is unanalyzed, not guessed", async () => {
    const dir = await makeProject({
      "package.json": `{ "name": "opaque", "version": "1.0.0", "main": "dist/bundle.js" }`,
    });
    try {
      const r = await buildApiSemverReport(dir);
      assert.equal(pkg(r, "opaque").entry, null);
      assert.equal(r.summary.unanalyzed, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("buildApiSemverReport — baseline diff + version lint", () => {
  test("a removed export without a major bump is breaking; a major bump clears it", async () => {
    const dir = await makeProject(WORKSPACE);
    try {
      const baseline = await buildApiSemverReport(dir);
      await writeFile(
        join(dir, "packages/api/src/index.ts"),
        `export const createServer = () => {};\nexport class Router {}\nexport * from "./helpers.ts";\nexport default createServer;\n`,
      );
      let r = await buildApiSemverReport(dir, { baseline });
      const api = r.diff!.verdicts.find((v) => v.package === "@acme/api")!;
      assert.deepEqual(api.removed.sort(), ["RouteConfig", "stopServer"]);
      assert.equal(api.verdict, "breaking-without-major");
      assert.equal(r.summary.breaking, 1);

      await writeFile(
        join(dir, "packages/api/package.json"),
        `{ "name": "@acme/api", "version": "2.0.0", "main": "dist/index.js" }`,
      );
      r = await buildApiSemverReport(dir, { baseline });
      assert.equal(r.diff!.verdicts.find((v) => v.package === "@acme/api")!.verdict, "ok");
      assert.equal(r.summary.breaking, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a 0.x package may break on a MINOR bump (semver 0.x rules)", async () => {
    const dir = await makeProject(WORKSPACE);
    try {
      const baseline = await buildApiSemverReport(dir);
      await writeFile(join(dir, "packages/shared/src/index.ts"), `export const logger = {};`);
      let r = await buildApiSemverReport(dir, { baseline });
      assert.equal(r.diff!.verdicts.find((v) => v.package === "@acme/shared")!.verdict, "breaking-without-major");

      await writeFile(join(dir, "packages/shared/package.json"), `{ "name": "@acme/shared", "version": "0.4.0" }`);
      r = await buildApiSemverReport(dir, { baseline });
      assert.equal(r.diff!.verdicts.find((v) => v.package === "@acme/shared")!.verdict, "ok");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an added export with an unchanged version is minor-expected (advisory)", async () => {
    const dir = await makeProject(WORKSPACE);
    try {
      const baseline = await buildApiSemverReport(dir);
      await writeFile(
        join(dir, "packages/shared/src/index.ts"),
        `export const logger = {};\nexport const config = {};\nexport const metrics = {};`,
      );
      const r = await buildApiSemverReport(dir, { baseline });
      const shared = r.diff!.verdicts.find((v) => v.package === "@acme/shared")!;
      assert.deepEqual(shared.added, ["metrics"]);
      assert.equal(shared.verdict, "minor-expected");
      assert.equal(r.summary.breaking, 0, "additions never exit-1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a partial surface refuses removal claims (never a phantom breaking)", async () => {
    const dir = await makeProject({
      "package.json": `{ "name": "wild", "version": "1.0.0" }`,
      "src/index.ts": `export const a = 1;\nexport const b = 2;`,
    });
    try {
      const baseline = await buildApiSemverReport(dir);
      // b moves behind an unfollowable wildcard — it may still be exported.
      await writeFile(join(dir, "src/index.ts"), `export const a = 1;\nexport * from "external-pkg";`);
      const r = await buildApiSemverReport(dir, { baseline });
      const v = r.diff!.verdicts.find((x) => x.package === "wild")!;
      assert.deepEqual(v.removed, [], "a partial surface cannot prove a removal");
      assert.equal(r.summary.breaking, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("removed/added packages are reported as info, never exit-1 claims", async () => {
    const dir = await makeProject(WORKSPACE);
    try {
      const baseline = await buildApiSemverReport(dir);
      await rm(join(dir, "packages/shared"), { recursive: true, force: true });
      const r = await buildApiSemverReport(dir, { baseline });
      const removed = r.diff!.changes.find((c) => c.kind === "removed-package");
      assert.equal(removed?.package, "@acme/shared");
      assert.equal(r.summary.breaking, 0, "no version left to lint — info only");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("buildApiSemverReport — hunt regressions (a surface is complete only when proven)", () => {
  const surfaceOf = async (files: Record<string, string>) => {
    const dir = await makeProject(files);
    try {
      const r = await buildApiSemverReport(dir);
      return { p: r.packages[0]!, report: r };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  test("a directory-form main resolves to its index, not a conventional guess", async () => {
    const { p } = await surfaceOf({
      "package.json": `{ "name": "a", "version": "1.0.0", "main": "./lib" }`,
      "lib/index.js": `exports.alpha = () => 1;\nexports.beta = () => 2;`,
      // A decoy the old fallthrough would have picked:
      "src/index.ts": `export const internalHelper = 42;`,
    });
    assert.equal(p.entry, "lib/index.js");
    assert.deepEqual(p.exports, ["alpha", "beta"]);
  });

  test("a declared-but-unresolvable entry is unanalyzed, never a conventional guess", async () => {
    const { p } = await surfaceOf({
      "package.json": `{ "name": "ghost", "version": "1.0.0", "main": "./dist/bundle.js" }`,
      "src/index.ts": `export const internal = 1;`,
    });
    assert.equal(p.entry, null, "guessing src/index.ts would assert a surface consumers never see");
    assert.equal(p.complete, false);
  });

  test("a `types` condition never wins over a runtime condition", async () => {
    const { p } = await surfaceOf({
      "package.json": `{ "name": "b", "version": "1.0.0", "exports": { ".": { "types": "./dist/index.d.ts", "require": "./dist/index.js", "default": "./dist/index.js" } } }`,
      "dist/index.js": `function connect(){ return "c"; }\nmodule.exports = connect;`,
      "dist/index.d.ts": `declare function connect(): string;\nexport = connect;`,
    });
    assert.equal(p.entry, "dist/index.js", "Node's resolver never uses the types condition");
    assert.equal(p.complete, false, "an opaque module.exports value hides its shape");
  });

  for (const [label, body] of [
    ["Object.assign(module.exports, …)", `Object.assign(module.exports, { alpha: 1, beta: 2 });`],
    ["tsc __exportStar output", `__exportStar(require("./other"), exports);`],
    ["a chained module.exports = exports.x = …", `module.exports = exports.parse = function(){};\nexports.stringify = function(){};`],
    ["an exports assignment inside a block", `exports.visible = 1;\nif (true) { exports.hidden = 2; }`],
    ["Object.defineProperty(exports, …) getters", `Object.defineProperty(exports, "greet", { get: () => 1 });`],
  ] as Array<[string, string]>) {
    test(`${label} makes the surface partial (no removal claims)`, async () => {
      const { p } = await surfaceOf({
        "package.json": `{ "name": "cjs", "version": "1.0.0", "main": "index.js" }`,
        "index.js": body,
      });
      assert.equal(p.complete, false, `${label} may hide names we did not read`);
    });
  }

  test("`export * as \"string name\"` exports one name, not the target's names", async () => {
    const { p } = await surfaceOf({
      "package.json": `{ "name": "strstar", "version": "1.0.0" }`,
      "src/index.ts": `export * as "string name" from "./z.ts";`,
      "src/z.ts": `export const zOnly1 = 1;\nexport const zOnly2 = 2;`,
    });
    assert.deepEqual(p.exports, ["string name"]);
  });

  test("a name reached through two different `export *` sources is ambiguous", async () => {
    const { p } = await surfaceOf({
      "package.json": `{ "name": "amb", "version": "1.0.0" }`,
      "src/index.ts": `export * from "./a.ts";\nexport * from "./b.ts";`,
      "src/a.ts": `export const x = 1;`,
      "src/b.ts": `export const x = 2;`,
    });
    assert.equal(p.complete, false, "ES semantics exclude an ambiguous star name entirely");
  });

  test("controls: clean ESM and clean CJS surfaces stay complete", async () => {
    const esm = await surfaceOf({
      "package.json": `{ "name": "clean", "version": "1.0.0", "main": "dist/index.js" }`,
      "src/index.ts": `export const a = 1;\nexport * from "./h.ts";\nexport default a;`,
      "src/h.ts": `export const helper = 2;`,
    });
    assert.equal(esm.p.complete, true);
    assert.deepEqual(esm.p.exports, ["a", "default", "helper"]);

    const cjs = await surfaceOf({
      "package.json": `{ "name": "cleancjs", "version": "1.0.0", "main": "index.js" }`,
      "index.js": `exports.readThing = function () {};\nmodule.exports.writeThing = () => {};`,
    });
    assert.equal(cjs.p.complete, true);
    assert.deepEqual(cjs.p.exports, ["readThing", "writeThing"]);
  });

  test("a packaging-only refactor (main form changed, same files) claims nothing", async () => {
    const dir = await makeProject({
      "package.json": `{ "name": "pkg", "version": "1.0.0", "main": "./lib/index.js" }`,
      "lib/index.js": `exports.alpha = () => 1;\nexports.beta = () => 2;`,
    });
    try {
      const baseline = await buildApiSemverReport(dir);
      await writeFile(join(dir, "package.json"), `{ "name": "pkg", "version": "1.0.1", "main": "./lib" }`);
      const r = await buildApiSemverReport(dir, { baseline });
      assert.deepEqual(r.diff!.changes, [], "the consumer surface is byte-identical");
      assert.equal(r.summary.breaking, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("buildApiSemverReport — determinism", () => {
  test("identical input yields byte-identical JSON across runs", async () => {
    const dir = await makeProject(WORKSPACE);
    try {
      const a = await buildApiSemverReport(dir);
      const b = await buildApiSemverReport(dir);
      assert.equal(JSON.stringify(a), JSON.stringify(b));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
