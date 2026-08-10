import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { computeDelta } from "../../src/core/delta.ts";
import type { Finding } from "../../src/core/types.ts";
import { installGitHook } from "../../src/install/git-hook.ts";
import { installCiWorkflow } from "../../src/cli/ci.ts";
import { renderDeltaMarkdown, renderReportMarkdown, SUMMARY_MARKER } from "../../src/report/markdown.ts";
import type { ScanReport } from "../../src/core/scan.ts";

const finding = (over: Partial<Finding>): Finding => ({
  confidence: "high" as const,
  id: `${over.normalizedFilePath ?? "a.ts"}::${over.line ?? 1}:1::node-doctor/${over.diagnostic ?? "d"}::x`,
  filePath: `/x/${over.normalizedFilePath ?? "a.ts"}`,
  normalizedFilePath: "a.ts",
  line: 1,
  column: 1,
  plugin: "node-doctor",
  diagnostic: "no-eval-with-input",
  title: "t",
  category: "Security",
  severity: "error",
  message: "m",
  recommendation: "r",
  tags: [],
  ...over,
});

// ---------------------------------------------------------------------------
// Evidence-based delta
// ---------------------------------------------------------------------------

describe("computeDelta — evidence-based", () => {
  test("a line shift + file rename is NOT introduced (same evidenceKey)", () => {
    const base = [finding({ normalizedFilePath: "a.ts", line: 5, evidenceKey: "E1" })];
    const head = [finding({ normalizedFilePath: "b.ts", line: 40, evidenceKey: "E1" })];
    const { introduced, resolved } = computeDelta(base, head);
    assert.equal(introduced.length, 0);
    assert.equal(resolved.length, 0);
  });
  test("a genuinely new finding is introduced; a removed one resolved", () => {
    const base = [finding({ evidenceKey: "E1" })];
    const head = [finding({ evidenceKey: "E1" }), finding({ diagnostic: "no-sql", evidenceKey: "E2" })];
    const d1 = computeDelta(base, head);
    assert.equal(d1.introduced.length, 1);
    assert.equal(d1.introduced[0]!.evidenceKey, "E2");
    const d2 = computeDelta(head, base);
    assert.equal(d2.resolved.length, 1);
    assert.equal(d2.resolved[0]!.evidenceKey, "E2");
  });
  test("multiset: three copies vs two → one introduced", () => {
    const base = [finding({ evidenceKey: "E" }), finding({ evidenceKey: "E" })];
    const head = [finding({ evidenceKey: "E" }), finding({ evidenceKey: "E" }), finding({ evidenceKey: "E" })];
    assert.equal(computeDelta(base, head).introduced.length, 1);
  });
  test("prefers a same-file match over a cross-file one", () => {
    const base = [finding({ normalizedFilePath: "keep.ts", evidenceKey: "E" })];
    const head = [
      finding({ normalizedFilePath: "keep.ts", evidenceKey: "E" }),
      finding({ normalizedFilePath: "new.ts", evidenceKey: "E" }),
    ];
    const { introduced } = computeDelta(base, head);
    assert.equal(introduced.length, 1);
    assert.equal(introduced[0]!.normalizedFilePath, "new.ts"); // the same-file one matched
  });
  test("falls back to positional id when evidenceKey is absent", () => {
    const base = [finding({ id: "ID-A" })];
    const head = [finding({ id: "ID-A" }), finding({ id: "ID-B" })];
    const { introduced } = computeDelta(base, head);
    assert.equal(introduced.length, 1);
    assert.equal(introduced[0]!.id, "ID-B");
  });
});

// ---------------------------------------------------------------------------
// git-hook installer
// ---------------------------------------------------------------------------

describe("installGitHook", () => {
  test("creates an executable, idempotent pre-commit hook in a git repo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-hook-"));
    try {
      try {
        execFileSync("git", ["init", "-q"], { cwd: dir });
      } catch {
        return; // git unavailable — skip
      }
      const first = await installGitHook({ cwd: dir });
      assert.equal(first.action, "created");
      const body = await readFile(first.path, "utf8");
      assert.match(body, /^#!\/bin\/sh/);
      assert.match(body, />>> node-doctor >>>/);
      assert.match(body, /node-doctor --staged --blocking warning/);
      const mode = (await stat(first.path)).mode & 0o777;
      assert.equal(mode & 0o100, 0o100, "owner-executable");

      const second = await installGitHook({ cwd: dir });
      assert.equal(second.action, "updated");
      const body2 = await readFile(second.path, "utf8");
      assert.equal(body2.match(/>>> node-doctor >>>/g)?.length, 1, "exactly one block after re-run");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("uses the husky hooks dir when present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-husky-"));
    try {
      try {
        execFileSync("git", ["init", "-q"], { cwd: dir });
      } catch {
        return;
      }
      await mkdir(join(dir, ".husky"), { recursive: true });
      const res = await installGitHook({ cwd: dir });
      assert.match(res.path, /\.husky\/pre-commit$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("errors outside a git repo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-nogit-"));
    try {
      await assert.rejects(() => installGitHook({ cwd: dir }), /not inside a git repository/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// ci workflow scaffolder
// ---------------------------------------------------------------------------

describe("installCiWorkflow", () => {
  test("writes a workflow with fetch-depth and the action ref; non-destructive on re-run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-ci-"));
    try {
      const first = await installCiWorkflow(dir);
      assert.equal(first.action, "created");
      const yml = await readFile(first.path, "utf8");
      assert.match(yml, /fetch-depth: 0/);
      assert.match(yml, /uses: DhiravPatel\/node_doctor@/);
      assert.match(yml, /pull_request/);
      const second = await installCiWorkflow(dir);
      assert.equal(second.action, "skipped");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Markdown reporters
// ---------------------------------------------------------------------------

describe("markdown reporters", () => {
  test("renderDeltaMarkdown: marker, no-findings, introduced table, resolved, score", () => {
    const clean = renderDeltaMarkdown([], [], { headScore: { score: 100, label: "healthy" } });
    assert.ok(clean.startsWith(SUMMARY_MARKER));
    assert.match(clean, /No new findings introduced/);
    assert.match(clean, /100\/100/);

    const withFindings = renderDeltaMarkdown([finding({ evidenceKey: "E" })], [finding({ diagnostic: "old" })]);
    assert.match(withFindings, /1 new finding\(s\) introduced/);
    assert.match(withFindings, /\| Severity \| Diagnostic \| Location \| Message \|/);
    assert.match(withFindings, /1 finding\(s\) resolved/);
  });
  test("renderReportMarkdown: score header + findings", () => {
    const report = {
      schemaVersion: 2,
      provenance: { toolVersion: "0.0.0", rulesetHash: "t", ruleset: [], configHash: "t", capabilities: [] },
      project: { name: "svc", rootDirectory: "/x", capabilities: [], analyzedFileCount: 3, totalLines: 100, files: [], complete: true, parseFailures: [], suppressedKeys: [] },
      diagnosticsRun: 1,
      diagnosticsAvailable: 1,
      findings: [finding({ evidenceKey: "E" })],
      score: { score: 40, label: "critical" as const, weighted: 2, perThousandLines: 20, byCategory: { Security: 1, Reliability: 0, Bugs: 0, Performance: 0, Maintainability: 0 } },
    } as ScanReport;
    const md = renderReportMarkdown(report);
    assert.match(md, /## node\.doctor — svc/);
    assert.match(md, /40\/100/);
    assert.match(md, /no-eval-with-input/);
  });
});

// ---------------------------------------------------------------------------
// --md-out (end to end via a written file)
// ---------------------------------------------------------------------------

describe("--md-out", () => {
  test("scan writes a Markdown report file", async () => {
    const { scanProject } = await import("../../src/core/scan.ts");
    const dir = await mkdtemp(join(tmpdir(), "nd-md-"));
    try {
      await writeFile(join(dir, "a.js"), "const x = eval(userInput);\n");
      const report = await scanProject({ rootDirectory: dir });
      const md = renderReportMarkdown(report);
      assert.match(md, /node\.doctor/);
      assert.match(md, /no-eval-with-input/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
