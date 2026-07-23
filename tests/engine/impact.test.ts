/**
 * Blast-radius / change-impact analysis (§120).
 *
 * `computeImpact` is a pure function of the import graph, so it is exercised both
 * directly (against a hand-built fixture through `buildImpactGraph`) and for its
 * two invariants that matter most: it reaches exactly the transitive dependents
 * (no more, no fewer), and it is deterministic.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildImpactGraph, computeImpact } from "../../src/core/impact.ts";

const workdir = async (): Promise<string> => mkdtemp(join(tmpdir(), "nd-impact-"));

/** pool ← db ← service ← routes(handler); plus an unrelated leaf. */
const buildChain = async (): Promise<string> => {
  const dir = await workdir();
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "package.json"), `{"name":"i","type":"module","dependencies":{"express":"^4.18.0"}}`);
  await writeFile(join(dir, "src", "pool.js"), `export const q = (s) => s;\nexport const pool = { query: q };\n`);
  await writeFile(join(dir, "src", "db.js"), `import { pool } from "./pool.js";\nexport const findUser = (id) => pool.query(id);\n`);
  await writeFile(join(dir, "src", "service.js"), `import { findUser } from "./db.js";\nexport const load = (id) => findUser(id);\n`);
  await writeFile(
    join(dir, "src", "routes.js"),
    `import express from "express";\nimport { load } from "./service.js";\nconst app = express();\napp.get("/u/:id", (req, res) => res.json(load(req.params.id)));\nexport default app;\n`,
  );
  await writeFile(join(dir, "src", "unrelated.js"), `export const helper = () => 42;\n`);
  return dir;
};

describe("computeImpact (§120)", () => {
  test("reaches every transitive dependent, at the right depth", async () => {
    const dir = await buildChain();
    try {
      const graph = await buildImpactGraph(dir);
      const report = computeImpact(graph, [join(dir, "src/pool.js")]);
      assert.deepEqual(report.changed, ["src/pool.js"]);
      assert.deepEqual(
        report.dependents.map((d) => `${d.depth}:${d.normalizedFilePath}`),
        ["1:src/db.js", "2:src/service.js", "3:src/routes.js"],
      );
      assert.equal(report.reachedCount, 3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("identifies the route-bearing file — the endpoint whose behaviour changes", async () => {
    const dir = await buildChain();
    try {
      const graph = await buildImpactGraph(dir);
      const report = computeImpact(graph, [join(dir, "src/pool.js")]);
      assert.deepEqual(report.routeBearingFiles, ["src/routes.js"]);
      assert.equal(report.dependents.find((d) => d.normalizedFilePath === "src/routes.js")?.hasHandlers, true);
      assert.equal(report.dependents.find((d) => d.normalizedFilePath === "src/db.js")?.hasHandlers, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a file nothing imports has a self-contained blast radius", async () => {
    const dir = await buildChain();
    try {
      const graph = await buildImpactGraph(dir);
      const report = computeImpact(graph, [join(dir, "src/unrelated.js")]);
      assert.equal(report.reachedCount, 0);
      assert.deepEqual(report.dependents, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("never reports a file that does not depend on the change", async () => {
    const dir = await buildChain();
    try {
      const graph = await buildImpactGraph(dir);
      const report = computeImpact(graph, [join(dir, "src/pool.js")]);
      assert.equal(
        report.dependents.some((d) => d.normalizedFilePath === "src/unrelated.js"),
        false,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a changed file that is not in the graph is reported as unresolved, not silently dropped", async () => {
    const dir = await buildChain();
    try {
      const graph = await buildImpactGraph(dir);
      const report = computeImpact(graph, [join(dir, "src/does-not-exist.js")]);
      assert.equal(report.changed.length, 0);
      assert.equal(report.unresolved.length, 1);
      assert.equal(report.reachedCount, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("changing several files unions their blast radius without double-counting", async () => {
    const dir = await buildChain();
    try {
      const graph = await buildImpactGraph(dir);
      const report = computeImpact(graph, [join(dir, "src/pool.js"), join(dir, "src/db.js")]);
      // db.js is a changed file, so it is a seed, not its own dependent.
      const files = report.dependents.map((d) => d.normalizedFilePath);
      assert.equal(files.includes("src/db.js"), false, "a changed file is not its own dependent");
      assert.deepEqual(files, ["src/service.js", "src/routes.js"]);
      // service.js is a direct importer of the (changed) db.js → depth 1.
      assert.equal(report.dependents.find((d) => d.normalizedFilePath === "src/service.js")?.depth, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("output is deterministic — identical graph and input give identical bytes", async () => {
    const dir = await buildChain();
    try {
      const graph = await buildImpactGraph(dir);
      const a = computeImpact(graph, [join(dir, "src/pool.js")]);
      const b = computeImpact(graph, [join(dir, "src/pool.js")]);
      assert.equal(JSON.stringify(a), JSON.stringify(b));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // The classic reverse-BFS hazard: an import cycle must terminate and not
  // inflate depth. A <-> B, C imports A, D imports C; changing A reaches B and C
  // at depth 1 and D at depth 2, with A (the seed, itself in the cycle) excluded.
  test("an import cycle terminates and yields correct depths", async () => {
    const dir = await workdir();
    try {
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "package.json"), `{"name":"c","type":"module"}`);
      await writeFile(join(dir, "src", "a.js"), `import { b } from "./b.js";\nexport const a = () => b();\n`);
      await writeFile(join(dir, "src", "b.js"), `import { a } from "./a.js";\nexport const b = () => 1;\n`);
      await writeFile(join(dir, "src", "c.js"), `import { a } from "./a.js";\nexport const c = () => a();\n`);
      await writeFile(join(dir, "src", "d.js"), `import { c } from "./c.js";\nexport const d = () => c();\n`);
      const graph = await buildImpactGraph(dir);
      const report = computeImpact(graph, [join(dir, "src/a.js")]);
      assert.deepEqual(
        report.dependents.map((x) => `${x.depth}:${x.normalizedFilePath}`),
        ["1:src/b.js", "1:src/c.js", "2:src/d.js"],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("blast radius crosses a package boundary in a workspace", async () => {
    const dir = await workdir();
    try {
      await mkdir(join(dir, "apps", "api", "src"), { recursive: true });
      await mkdir(join(dir, "packages", "db", "src"), { recursive: true });
      await writeFile(join(dir, "packages", "db", "src", "index.js"), `export const warm = () => 1;\n`);
      await writeFile(
        join(dir, "apps", "api", "src", "routes.js"),
        `import express from "express";\nimport { warm } from "@acme/db";\nconst app = express();\napp.get("/w", (req, res) => res.json(warm()));\nexport default app;\n`,
      );
      const workspacePackages = new Map([["@acme/db", join(dir, "packages", "db")]]);
      const graph = await buildImpactGraph(dir, { workspacePackages });
      const report = computeImpact(graph, [join(dir, "packages/db/src/index.js")]);
      assert.equal(report.routeBearingFiles.length, 1, "the apps/api route depends on packages/db");
      assert.match(report.routeBearingFiles[0]!, /apps\/api\/src\/routes\.js$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
