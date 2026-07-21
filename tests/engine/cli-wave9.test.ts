import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { diagnose } from "../../src/api.ts";
import oxlint, { rules as oxRules } from "../../src/adapters/oxlint.ts";
import { detectInstalledClients, onPath } from "../../src/install/detect-agents.ts";
import { installSkill } from "../../src/skill/install.ts";
import { installPackageScript, findNearestPackageJson, detectPackageManager } from "../../src/install/package-script.ts";
import { installAgentHooks, claudeHookInstalled } from "../../src/install/agent-hooks.ts";

const goodApp = fileURLToPath(new URL("../fixtures/good-app", import.meta.url));
const agentApp = fileURLToPath(new URL("../fixtures/agent-app", import.meta.url));

// ---------------------------------------------------------------------------
// diagnose() API
// ---------------------------------------------------------------------------

describe("diagnose()", () => {
  test("single directory returns a ScanReport", async () => {
    const report = await diagnose(goodApp);
    assert.equal(report.score.score, 100);
    assert.equal(Array.isArray(report.findings), true);
  });
  test("batch returns per-directory results + worst-of score + union findings", async () => {
    const batch = await diagnose({ directories: [goodApp, agentApp] });
    assert.equal(batch.ok, true);
    assert.equal(batch.results.length, 2);
    assert.equal(batch.score.score, 0, "worst-of is the agent-app critical score");
    assert.ok(batch.findings.length > 0);
    assert.ok(batch.results.every((r) => r.ok));
  });
  test("options pass through (secrets off)", async () => {
    const report = await diagnose(agentApp, { secrets: false });
    assert.ok(report.findings.every((f) => f.diagnostic !== "no-committed-env-secret"));
  });
});

// ---------------------------------------------------------------------------
// oxlint plugin host
// ---------------------------------------------------------------------------

describe("oxlint adapter", () => {
  test("plugin shape: meta.name + only file-scope rules", () => {
    assert.equal(oxlint.meta.name, "node-doctor");
    assert.ok(Object.keys(oxRules).length > 50);
    // project-scope + text-scan diagnostics must NOT be exposed
    assert.equal(oxRules["no-sync-io-reachable-from-handler"], undefined);
    assert.equal(oxRules["no-circular-imports"], undefined);
    assert.equal(oxRules["no-committed-env-secret"], undefined);
    assert.ok(oxRules["no-eval-with-input"]);
  });
  test("a rule reports through the oxlint context", () => {
    const reports: Array<{ loc: { line: number; column: number }; message: string }> = [];
    const context = {
      filename: "a.ts",
      sourceCode: { getText: () => "const x = eval(userInput);" },
      report: (d: { loc: { line: number; column: number }; message: string }) => reports.push(d),
    };
    oxRules["no-eval-with-input"]!.create(context).Program!(null);
    assert.equal(reports.length, 1);
    assert.equal(reports[0]!.loc.line, 1);
    assert.match(reports[0]!.message, /eval/);
  });
});

// ---------------------------------------------------------------------------
// agent/client detection
// ---------------------------------------------------------------------------

describe("detectInstalledClients", () => {
  test("detects a client from a project config dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-detect-"));
    try {
      await mkdir(join(dir, ".claude"), { recursive: true });
      const ids = detectInstalledClients(dir).map((c) => c.id);
      assert.ok(ids.includes("claude-code"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("onPath is a boolean probe", () => {
    assert.equal(typeof onPath("definitely-not-a-real-binary-xyz"), "boolean");
    assert.equal(onPath("definitely-not-a-real-binary-xyz"), false);
  });
});

// ---------------------------------------------------------------------------
// skill install — audit skill + client filtering
// ---------------------------------------------------------------------------

describe("installSkill", () => {
  test("installs the improve-node skill to its own path for selected clients", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-skill-"));
    try {
      const res = await installSkill({ skill: "improve-node", clients: ["claude-code"], targetDir: dir });
      assert.equal(res.written.length, 1);
      assert.match(res.written[0]!, /\.claude\/skills\/improve-node\/SKILL\.md$/);
      const content = await readFile(res.written[0]!, "utf8");
      assert.match(content, /audit-then-plan/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("clients list filters to known ids", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-skill2-"));
    try {
      const res = await installSkill({ clients: ["cursor", "bogus"], targetDir: dir });
      assert.equal(res.written.length, 1);
      assert.match(res.written[0]!, /\.cursor\//);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// package.json script installer
// ---------------------------------------------------------------------------

describe("installPackageScript", () => {
  test("adds a doctor script; falls back when taken; errors without package.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-pkg-"));
    try {
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "demo" }));
      const r1 = await installPackageScript({ cwd: dir });
      assert.equal(r1.scriptName, "doctor");
      assert.equal(r1.scriptAdded, true);
      assert.equal(JSON.parse(await readFile(join(dir, "package.json"), "utf8")).scripts.doctor, "node-doctor");

      // second run: "doctor" now taken → falls back
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "demo", scripts: { doctor: "something-else" } }));
      const r2 = await installPackageScript({ cwd: dir });
      assert.equal(r2.scriptName, "node-doctor");

      assert.equal(findNearestPackageJson(dir)!.endsWith("package.json"), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("errors when no package.json is found", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-nopkg-"));
    try {
      await assert.rejects(() => installPackageScript({ cwd: dir }), /no package\.json/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("detectPackageManager reads the lockfile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-pm-"));
    try {
      await writeFile(join(dir, "pnpm-lock.yaml"), "");
      assert.equal(detectPackageManager(dir), "pnpm");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// agent hooks installer
// ---------------------------------------------------------------------------

describe("installAgentHooks", () => {
  test("writes hook scripts + configs and merges the PostToolUse hook idempotently", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-hooks-"));
    try {
      const first = await installAgentHooks(dir);
      assert.ok(first.written.some((p) => p.endsWith(".claude/hooks/node-doctor.mjs")));
      assert.ok(first.written.some((p) => p.endsWith(".cursor/hooks.json")));

      const settings = JSON.parse(await readFile(join(dir, ".claude", "settings.json"), "utf8"));
      assert.equal(claudeHookInstalled(settings, "node .claude/hooks/node-doctor.mjs"), true);

      // second run must not duplicate the PostToolUse entry
      await installAgentHooks(dir);
      const settings2 = JSON.parse(await readFile(join(dir, ".claude", "settings.json"), "utf8"));
      assert.equal(settings2.hooks.PostToolUse.length, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
