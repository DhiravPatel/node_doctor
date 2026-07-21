import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { scanProject } from "../../src/core/scan.ts";
import { mergeConfig } from "../../src/core/config.ts";
import {
  discoverWorkspaceGlobs,
  discoverWorkspaces,
  isWorkspaceRoot,
  scanWorkspaces,
  workspaceFindings,
} from "../../src/core/workspaces.ts";

const agentApp = fileURLToPath(new URL("../fixtures/agent-app", import.meta.url));

// ---------------------------------------------------------------------------
// Parallel file scanning — determinism
// ---------------------------------------------------------------------------

describe("parallel scanning", () => {
  test("parallel and serial produce byte-identical findings + score", async () => {
    const par = await scanProject({ rootDirectory: agentApp, parallel: true });
    const ser = await scanProject({ rootDirectory: agentApp, parallel: false });
    assert.deepEqual(
      par.findings.map((f) => f.id),
      ser.findings.map((f) => f.id),
    );
    assert.equal(par.score.score, ser.score.score);
    assert.equal(par.project.analyzedFileCount, ser.project.analyzedFileCount);
  });
});

// ---------------------------------------------------------------------------
// Config merge (additive)
// ---------------------------------------------------------------------------

describe("mergeConfig", () => {
  test("layers diagnostics (project wins) and unions tags/ignore", () => {
    const merged = mergeConfig(
      { diagnostics: { a: "off", b: "warn" }, ignoreTags: ["x"], ignore: ["**/gen/**"], blocking: "warning" },
      { diagnostics: { b: "error", c: "off" }, ignoreTags: ["y"], blocking: "none" },
    );
    assert.deepEqual(merged.diagnostics, { a: "off", b: "error", c: "off" });
    assert.deepEqual(merged.ignoreTags, ["x", "y"]);
    assert.deepEqual(merged.ignore, ["**/gen/**"]);
    assert.equal(merged.blocking, "none");
  });
});

// ---------------------------------------------------------------------------
// Workspace discovery
// ---------------------------------------------------------------------------

const makeMonorepo = async (rootPkg: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "nd-ws-"));
  await writeFile(join(dir, "package.json"), rootPkg);
  await mkdir(join(dir, "packages", "api", "src"), { recursive: true });
  await mkdir(join(dir, "packages", "web", "src"), { recursive: true });
  await writeFile(join(dir, "packages", "api", "package.json"), JSON.stringify({ name: "@acme/api" }));
  await writeFile(join(dir, "packages", "web", "package.json"), JSON.stringify({ name: "@acme/web" }));
  await writeFile(join(dir, "packages", "api", "src", "h.js"), 'app.post("/x",(req,res)=>{ const o=eval(req.body.c); res.send(o); });\n');
  await writeFile(join(dir, "packages", "web", "src", "u.js"), "export const add=(a,b)=>a+b;\n");
  return dir;
};

describe("workspace discovery", () => {
  test("reads npm workspaces (array form) and finds member roots", async () => {
    const dir = await makeMonorepo(JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }));
    try {
      assert.deepEqual(await discoverWorkspaceGlobs(dir), ["packages/*"]);
      assert.equal(await isWorkspaceRoot(dir), true);
      const roots = await discoverWorkspaces(dir);
      assert.equal(roots.length, 2);
      assert.ok(roots.every((r) => r.includes("/packages/")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("reads npm workspaces object form ({ packages })", async () => {
    const dir = await makeMonorepo(JSON.stringify({ name: "root", workspaces: { packages: ["packages/*"] } }));
    try {
      assert.deepEqual(await discoverWorkspaceGlobs(dir), ["packages/*"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("a plain package is not a workspace root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-plain-"));
    try {
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "solo" }));
      assert.equal(await isWorkspaceRoot(dir), false);
      assert.deepEqual(await discoverWorkspaces(dir), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("reads pnpm-workspace.yaml", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-pnpm-"));
    try {
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "root" }));
      await writeFile(join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n  - "apps/*"\n');
      assert.deepEqual(await discoverWorkspaceGlobs(dir), ["packages/*", "apps/*"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// scanWorkspaces — per-project scoring, worst-of, filtering
// ---------------------------------------------------------------------------

describe("scanWorkspaces", () => {
  test("scores each project, aggregates worst-of, and unions findings", async () => {
    const dir = await makeMonorepo(JSON.stringify({ name: "root", workspaces: ["packages/*"] }));
    try {
      const report = await scanWorkspaces(dir);
      assert.equal(report.multiProject, true);
      assert.equal(report.projectCount, 2);
      const names = report.projects.map((p) => p.name).sort();
      assert.deepEqual(names, ["@acme/api", "@acme/web"]);
      // api has the eval bug → worst-of is api's score, web is clean.
      assert.equal(report.worstProject, "@acme/api");
      assert.equal(report.score.score < 100, true);
      const web = report.projects.find((p) => p.name === "@acme/web")!;
      assert.equal(web.report.score.score, 100);
      assert.equal(workspaceFindings(report).length, report.totalFindings);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("--project filters by name and by path", async () => {
    const dir = await makeMonorepo(JSON.stringify({ name: "root", workspaces: ["packages/*"] }));
    try {
      const byName = await scanWorkspaces(dir, { projectFilter: ["@acme/api"] });
      assert.deepEqual(byName.projects.map((p) => p.name), ["@acme/api"]);
      const byPath = await scanWorkspaces(dir, { projectFilter: ["packages/web"] });
      assert.deepEqual(byPath.projects.map((p) => p.name), ["@acme/web"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("root config layers over each project (disabling a diagnostic silences it everywhere)", async () => {
    const dir = await makeMonorepo(JSON.stringify({ name: "root", workspaces: ["packages/*"] }));
    try {
      const report = await scanWorkspaces(dir, { config: { diagnostics: { "no-eval-with-input": "off" } } });
      const evalHits = workspaceFindings(report).filter((f) => f.diagnostic === "no-eval-with-input");
      assert.equal(evalHits.length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
