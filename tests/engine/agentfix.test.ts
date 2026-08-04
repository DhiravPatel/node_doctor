import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { scanProject } from "../../src/core/scan.ts";
import { buildAgentPrompt, runAgentFix, detectAgents, AGENTS, type AgentDef } from "../../src/agent/fix.ts";

const agentApp = fileURLToPath(new URL("../fixtures/agent-app", import.meta.url));
const goodApp = fileURLToPath(new URL("../fixtures/good-app", import.meta.url));

const claude = (): AgentDef => AGENTS.find((a) => a.id === "claude")!;

describe("agent-fix prompt builder", () => {
  test("includes project, score, grouped findings, sites, and the stance", async () => {
    const report = await scanProject({ rootDirectory: agentApp });
    const prompt = buildAgentPrompt(report, { reportPath: "/tmp/report.json" });

    assert.match(prompt, /agent-app/);
    assert.match(prompt, /0\/100 \(critical\)/);
    assert.match(prompt, /node-doctor\/no-/); // a diagnostic id
    assert.match(prompt, /:\d+:\d+/); // a file:line:col site
    assert.match(prompt, /suppress or silence/i);
    assert.match(prompt, /npx node-doctor@latest \./); // verify step
    assert.match(prompt, /Teach me/);
    assert.match(prompt, /\/tmp\/report\.json/); // report pointer
  });

  test("excludes the suppression-without-reason meta finding", () => {
    const report = {
      schemaVersion: 2,
      provenance: { toolVersion: "0.0.0", rulesetHash: "t", configHash: "t", capabilities: [] },
      project: { name: "x", rootDirectory: "/x", capabilities: ["node"], analyzedFileCount: 1, totalLines: 10, complete: true, parseFailures: [], suppressedKeys: [] },
      diagnosticsRun: 1,
      diagnosticsAvailable: 1,
      findings: [
        { id: "1", filePath: "/x/a.js", normalizedFilePath: "a.js", line: 1, column: 1, plugin: "node-doctor", diagnostic: "suppression-without-reason", title: "Suppression without a reason", category: "Maintainability" as const, severity: "warn" as const, message: "m", recommendation: "r", tags: [], confidence: "high" as const },
        { id: "2", filePath: "/x/a.js", normalizedFilePath: "a.js", line: 2, column: 1, plugin: "node-doctor", diagnostic: "no-sql-template-interpolation", title: "SQL built by string interpolation", category: "Security" as const, severity: "error" as const, message: "SQL injection", recommendation: "Use bound params", tags: [], confidence: "high" as const },
      ],
      score: { score: 40, label: "critical" as const, weighted: 6, perThousandLines: 600, byCategory: { Security: 1, Reliability: 0, Bugs: 0, Performance: 0, Maintainability: 1 } },
    };
    const prompt = buildAgentPrompt(report);
    assert.ok(!prompt.includes("suppression-without-reason"));
    assert.match(prompt, /no-sql-template-interpolation/);
  });
});

describe("agent config", () => {
  test("Claude Code uses the bypass-approvals flag; prefers claude first", () => {
    assert.equal(AGENTS[0]!.id, "claude");
    assert.deepEqual(claude().autoFlags, ["--dangerously-skip-permissions"]);
    assert.equal(claude().bin, "claude");
  });
  test("detectAgents returns a subset of AGENTS", () => {
    const ids = new Set(AGENTS.map((a) => a.id));
    for (const a of detectAgents()) assert.ok(ids.has(a.id));
  });
});

describe("runAgentFix (injected chooser + spawn — never launches a real agent)", () => {
  test("launches the chosen agent with [...autoFlags, prompt] (prompt is the last argv)", async () => {
    const report = await scanProject({ rootDirectory: agentApp });
    let bin = "";
    let args: string[] = [];
    const code = await runAgentFix(report, {
      chooseAction: async () => ({ kind: "agent", agent: claude() }),
      spawnAgent: async (b, a) => {
        bin = b;
        args = a;
        return 0;
      },
      out: () => {},
      err: () => {},
    });
    assert.equal(code, 0);
    assert.equal(bin, "claude");
    assert.equal(args[0], "--dangerously-skip-permissions");
    assert.match(args[args.length - 1]!, /Fix the node\.doctor findings/); // prompt is the last argv
  });

  test("--review drops the bypass-approvals flags", async () => {
    const report = await scanProject({ rootDirectory: agentApp });
    let args: string[] = [];
    await runAgentFix(report, {
      review: true,
      chooseAction: async () => ({ kind: "agent", agent: claude() }),
      spawnAgent: async (_b, a) => {
        args = a;
        return 0;
      },
      out: () => {},
      err: () => {},
    });
    assert.ok(!args.includes("--dangerously-skip-permissions"));
  });

  test("skip and print never spawn", async () => {
    const report = await scanProject({ rootDirectory: agentApp });
    let spawns = 0;
    const spawnAgent = async (): Promise<number> => {
      spawns++;
      return 0;
    };
    await runAgentFix(report, { chooseAction: async () => ({ kind: "skip" }), spawnAgent, out: () => {}, err: () => {} });
    let printed = "";
    await runAgentFix(report, { print: true, spawnAgent, out: (s) => (printed += s), err: () => {} });
    assert.equal(spawns, 0);
    assert.match(printed, /Fix the node\.doctor findings/);
  });

  test("good-app: nothing to fix → returns 0, no spawn", async () => {
    const report = await scanProject({ rootDirectory: goodApp });
    let spawns = 0;
    const code = await runAgentFix(report, { spawnAgent: async () => (spawns++, 0), out: () => {}, err: () => {} });
    assert.equal(code, 0);
    assert.equal(spawns, 0);
  });
});
