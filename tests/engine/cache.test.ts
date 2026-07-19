import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanProject } from "../../src/core/scan.ts";
import { toJson } from "../../src/report/json.ts";

const makeProject = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "nd-cache-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "c", type: "module", dependencies: { express: "^4.18.0" } }));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(
    join(dir, "src", "app.js"),
    `app.get("/r", (req, res) => { const t = require("fs").readFileSync("x"); res.send(t); });\n`,
  );
  return dir;
};

describe("content-hash cache", () => {
  test("warm run is byte-identical to the cold run", async () => {
    const dir = await makeProject();
    try {
      const cold = await scanProject({ rootDirectory: dir, cache: true });
      const warm = await scanProject({ rootDirectory: dir, cache: true });
      assert.equal(toJson(cold), toJson(warm));
      // The sidecar was written.
      const cacheRaw = await readFile(join(dir, ".node-doctor-cache", "cache.json"), "utf8");
      assert.ok(JSON.parse(cacheRaw).files);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("editing a file invalidates its cache entry and re-analyzes", async () => {
    const dir = await makeProject();
    try {
      await scanProject({ rootDirectory: dir, cache: true });
      // Replace the bad handler with a clean one.
      await writeFile(join(dir, "src", "app.js"), `export const ok = 1;\n`);
      const after = await scanProject({ rootDirectory: dir, cache: true });
      assert.equal(after.findings.length, 0, "cache must not return stale findings for a changed file");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("cached output matches an uncached scan", async () => {
    const dir = await makeProject();
    try {
      const uncached = await scanProject({ rootDirectory: dir });
      const cached1 = await scanProject({ rootDirectory: dir, cache: true });
      const cached2 = await scanProject({ rootDirectory: dir, cache: true });
      assert.equal(uncached.findings.length, cached1.findings.length);
      assert.equal(cached1.findings.length, cached2.findings.length);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
