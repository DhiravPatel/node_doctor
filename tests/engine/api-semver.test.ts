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
