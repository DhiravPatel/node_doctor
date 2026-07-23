/**
 * Attack-path / exploitability proof (§121). A view over the interprocedural
 * taint engine's data — the source→sink chain for every injection sink fed by
 * request data — so it inherits the taint engine's soundness and is exercised
 * for the two things that matter: it names the whole chain, and it is silent when
 * nothing is reachable.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildImpactGraph } from "../../src/core/impact.ts";
import { collectAttackPaths } from "../../src/core/attack-paths.ts";

const workdir = async (): Promise<string> => mkdtemp(join(tmpdir(), "nd-paths-"));

/** handler → search → runQuery(SQL sink), across three files. */
const buildInjectionChain = async (): Promise<string> => {
  const dir = await workdir();
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "package.json"), `{"name":"a","type":"module","dependencies":{"express":"^4.18.0"}}`);
  await writeFile(
    join(dir, "src", "routes.js"),
    `import express from "express";\nimport { search } from "./service.js";\nconst app = express();\napp.post("/search", (req, res) => { res.json(search(req.body.q)); });\nexport default app;\n`,
  );
  await writeFile(join(dir, "src", "service.js"), `import { runQuery } from "./db.js";\nexport function search(term) { return runQuery(term); }\n`);
  await writeFile(
    join(dir, "src", "db.js"),
    `export const db = { query: (s) => s };\nexport function runQuery(term) { return db.query("SELECT * FROM t WHERE x = '" + term + "'"); }\n`,
  );
  return dir;
};

describe("collectAttackPaths (§121)", () => {
  test("traces the full source→sink chain of a cross-file SQL injection", async () => {
    const dir = await buildInjectionChain();
    try {
      const paths = await collectAttackPaths(await buildImpactGraph(dir), dir);
      assert.equal(paths.length, 1);
      const p = paths[0]!;
      assert.equal(p.kind, "sql");
      // handler → search → runQuery: three located hops, ending at the sink file.
      assert.deepEqual(
        p.steps.map((s) => s.normalizedFilePath),
        ["src/routes.js", "src/service.js", "src/db.js"],
      );
      assert.equal(p.sink.normalizedFilePath, "src/db.js");
      // Every hop carries a real 1-based line.
      for (const s of p.steps) assert.ok(s.line >= 1, `hop ${s.label} has no line`);
      assert.ok(p.sink.line >= 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("silent when no caller data reaches a sink", async () => {
    const dir = await workdir();
    try {
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "package.json"), `{"name":"a","type":"module","dependencies":{"express":"^4.18.0"}}`);
      // A handler that never passes request data into a sink.
      await writeFile(
        join(dir, "src", "routes.js"),
        `import express from "express";\nconst app = express();\napp.get("/ping", (req, res) => res.json({ ok: true }));\nexport default app;\n`,
      );
      const paths = await collectAttackPaths(await buildImpactGraph(dir), dir);
      assert.deepEqual(paths, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("output is deterministic", async () => {
    const dir = await buildInjectionChain();
    try {
      const graph = await buildImpactGraph(dir);
      const a = await collectAttackPaths(graph, dir);
      const b = await collectAttackPaths(graph, dir);
      assert.equal(JSON.stringify(a), JSON.stringify(b));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
