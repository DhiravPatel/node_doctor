/**
 * "Fix with an AI agent" — hand node.doctor's findings to a coding agent
 * (Claude Code first) so it fixes them end-to-end, then you re-scan to confirm.
 * Modeled on react.doctor's agent hand-off, adapted to diagnostics/findings.
 *
 * The prompt builder and agent config are pure and unit-tested; detection, the
 * interactive menu, and the spawn are thin wrappers so a non-interactive/CI run
 * degrades gracefully (print the prompt instead of launching anything).
 */

import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { CATEGORY_WEIGHTS } from "../core/score.ts";
import { computeDelta } from "../core/delta.ts";
import type { ScanReport } from "../core/scan.ts";
import type { Category, Finding } from "../core/types.ts";

export interface AgentDef {
  id: string;
  label: string;
  bin: string;
  /** Flags that put the agent in bypass-approvals / auto-run mode. */
  autoFlags: string[];
}

/** Known coding-agent CLIs, in preference order. Extensible. */
export const AGENTS: AgentDef[] = [
  { id: "claude", label: "Claude Code", bin: "claude", autoFlags: ["--dangerously-skip-permissions"] },
  { id: "codex", label: "Codex", bin: "codex", autoFlags: ["--yolo"] },
  { id: "cursor", label: "Cursor Agent", bin: "cursor-agent", autoFlags: ["--force"] },
];

const onPath = (bin: string): boolean => {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** The agent CLIs actually installed on this machine, in preference order. */
export const detectAgents = (): AgentDef[] => AGENTS.filter((a) => onPath(a.bin));

const SEVERITY_RANK = { error: 0, warn: 1 } as const;
const glyph = (sev: string): string => (sev === "error" ? "✖" : "⚠");

interface Group {
  diagnostic: string;
  confidence: Finding["confidence"];
  category: Category;
  severity: "error" | "warn";
  title: string;
  message: string;
  recommendation: string;
  sites: Finding[];
}

/** Group findings by diagnostic, ranked by severity then category weight then count. */
const groupFindings = (findings: Finding[]): Group[] => {
  const map = new Map<string, Group>();
  for (const f of findings) {
    let g = map.get(f.diagnostic);
    if (!g) {
      g = {
        diagnostic: f.diagnostic,
        confidence: f.confidence,
        category: f.category,
        severity: f.severity,
        title: f.title,
        message: f.message,
        recommendation: f.recommendation,
        sites: [],
      };
      map.set(f.diagnostic, g);
    }
    g.sites.push(f);
  }
  return [...map.values()].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      CATEGORY_WEIGHTS[b.category] - CATEGORY_WEIGHTS[a.category] ||
      b.sites.length - a.sites.length ||
      (a.diagnostic < b.diagnostic ? -1 : 1),
  );
};

const MAX_GROUPS = 8;
const MAX_SITES = 4;

/**
 * Build the instruction prompt handed to the coding agent. Pure and deterministic
 * given a report. Groups findings by diagnostic, names the exact fix mechanism,
 * and carries node.doctor's stance: fix the root cause, never suppress.
 */
export const buildAgentPrompt = (report: ScanReport, opts: { reportPath?: string } = {}): string => {
  const findings = report.findings.filter((f) => f.diagnostic !== "suppression-without-reason");
  const groups = groupFindings(findings);
  const top = groups.slice(0, MAX_GROUPS);
  const errors = findings.filter((f) => f.severity === "error").length;
  const files = new Set(findings.map((f) => f.normalizedFilePath)).size;

  const list = top
    .map((g, i) => {
      const badge = g.sites.length > 1 ? `one root cause · ${g.sites.length} sites` : `1 site`;
      const sites = g.sites
        .slice(0, MAX_SITES)
        .map((f) => `   - ${f.normalizedFilePath}:${f.line}:${f.column}`)
        .join("\n");
      const more = g.sites.length > MAX_SITES ? `\n   - +${g.sites.length - MAX_SITES} more sites` : "";
      return (
        `${i + 1}. ${g.severity === "error" ? "ERROR" : "WARN"} ${g.category}: ${g.title} (${badge}, ${g.confidence} confidence)  [node-doctor/${g.diagnostic}]\n` +
        `   ${g.message}\n` +
        `   Fix: ${g.recommendation}\n${sites}${more}`
      );
    })
    .join("\n\n");

  const remainder = groups.length > MAX_GROUPS ? `\n\nThere are ${groups.length - MAX_GROUPS} more diagnostic group(s) beyond the top ${MAX_GROUPS} — work through them after these.` : "";
  const reportLine = opts.reportPath
    ? `\n\nFull machine-readable report (every finding): ${opts.reportPath}`
    : "";

  return `Fix the node.doctor findings in ${report.project.name} on this pass.

node.doctor — a static analyzer for Node.js backends — scored this project ${report.score.score}/100 (${report.score.label}): ${findings.length} finding(s) (${errors} error, ${findings.length - errors} warn) across ${files} file(s). Every finding is a real, load-dependent production defect and names the exact fix.

## Findings (top ${top.length} of ${groups.length} diagnostic groups)

${list}${remainder}${reportLine}

## How to fix them

- Read each file and fix the **root cause** with the named mechanism in each "Fix:" line. Do **not** suppress or silence a diagnostic to make the scan pass — a false positive is a bug in node.doctor; tell me so I can report it, rather than silencing it.
- For every request handler you touch, check the four questions: (1) where a post-\`await\` rejection goes, (2) whether anything blocks the event loop, (3) whether it fans out proportionally to caller input, (4) where caller-controlled data lands — shell → \`execFile\`, SQL → bound params, filesystem → a containment check, and no \`eval\`-family calls on input.
- Findings that share a diagnostic and message are usually one root cause — fix it once.
- **Confidence** tells you how to act: \`high\` is an unambiguous shape or a proven taint path — fix it. \`medium\` is a strong heuristic — read the code and confirm before changing it. \`low\` is a threshold/style judgement — only act if it genuinely improves the code.

## Verify — don't assume

After your edits, re-run \`npx node-doctor@latest .\` and confirm the health score went up and these findings are gone against the real tool before moving on.

## Teach me as you go

For each finding you fix, explain it in plain language — what the problem is, why it matters, and its real-world impact and severity (e.g. "this SQL injection lets any user read the whole users table" vs. "a minor cleanup with no user impact") — so I understand why it matters, not just what changed.`;
};

/** Copy text to the OS clipboard (best-effort). */
export const copyToClipboard = (text: string): boolean => {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["pbcopy", [] as string[]]
      : process.platform === "win32"
        ? ["clip", []]
        : ["xclip", ["-selection", "clipboard"]];
  try {
    const r = spawnSync(cmd, args, { input: text });
    return r.status === 0;
  } catch {
    return false;
  }
};

/** The machine-checked outcome of an agent's fix pass (§51). */
export interface VerifyResult {
  /** Findings present before the agent ran (excluding the suppression meta-finding). */
  originalCount: number;
  /** Pre-existing findings the agent actually cleared. */
  resolvedCount: number;
  /** Pre-existing findings still present. */
  remaining: Finding[];
  /** NEW findings the agent's own edits introduced — regressions. */
  introduced: Finding[];
  scoreBefore: number;
  scoreAfter: number;
  /** True only when everything was fixed and nothing was broken. */
  passed: boolean;
}

const realFindings = (report: ScanReport): Finding[] =>
  report.findings.filter((f) => f.diagnostic !== "suppression-without-reason");

/**
 * Compare a pre-fix report with a post-fix re-scan. Pure and deterministic, so
 * the verdict is testable without launching an agent. Matching is evidence-based
 * (via `computeDelta`), so code the agent *moved* is not miscounted as new.
 */
export const verifyFixes = (before: ScanReport, after: ScanReport): VerifyResult => {
  const { introduced, resolved } = computeDelta(before, after);
  const introducedKeys = new Set(introduced.map((f) => f.id));
  const remaining = realFindings(after).filter((f) => !introducedKeys.has(f.id));
  const realIntroduced = introduced.filter((f) => f.diagnostic !== "suppression-without-reason");
  const realResolved = resolved.filter((f) => f.diagnostic !== "suppression-without-reason");
  return {
    originalCount: realFindings(before).length,
    resolvedCount: realResolved.length,
    remaining,
    introduced: realIntroduced,
    scoreBefore: before.score.score,
    scoreAfter: after.score.score,
    passed: realIntroduced.length === 0 && remaining.length === 0,
  };
};

/** Human-readable verdict for the terminal. */
export const renderVerifyResult = (v: VerifyResult): string => {
  const lines = ["", "  Verification (re-scanned after the agent ran)"];
  lines.push(`    ✓ ${v.resolvedCount} of ${v.originalCount} finding(s) resolved`);
  if (v.remaining.length > 0) lines.push(`    ⚠ ${v.remaining.length} still present`);
  if (v.introduced.length > 0) {
    lines.push(`    ✖ ${v.introduced.length} NEW finding(s) introduced by the fix:`);
    for (const f of v.introduced.slice(0, 5)) {
      lines.push(`        ${f.normalizedFilePath}:${f.line} node-doctor/${f.diagnostic}`);
    }
  }
  lines.push(`    score ${v.scoreBefore} → ${v.scoreAfter}`);
  lines.push(v.passed ? "  → PASS" : "  → FAIL");
  lines.push("");
  return lines.join("\n");
};

export type FixAction =
  | { kind: "agent"; agent: AgentDef }
  | { kind: "copy" }
  | { kind: "print" }
  | { kind: "skip" };

/** The interactive menu (dependency-free). Returns the chosen action. */
const defaultChooser = (agents: AgentDef[]): Promise<FixAction> =>
  new Promise((resolve) => {
    const rows: [string, string, FixAction][] = [];
    agents.forEach((a, i) => rows.push([String(i + 1), `Fix with ${a.label}  (${a.bin})`, { kind: "agent", agent: a }]));
    rows.push(["c", "Copy the prompt to your clipboard", { kind: "copy" }]);
    rows.push(["p", "Print the prompt", { kind: "print" }]);
    rows.push(["s", "Skip", { kind: "skip" }]);

    process.stderr.write("\n  What would you like to do?\n");
    for (const [key, label] of rows) process.stderr.write(`    ${key}) ${label}\n`);
    if (agents.length === 0) {
      process.stderr.write("    (no supported agent CLI found on PATH — install Claude Code, Codex, or Cursor)\n");
    }

    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question("  > ", (answer) => {
      rl.close();
      const match = rows.find((r) => r[0] === answer.trim().toLowerCase());
      resolve(match ? match[2] : { kind: "skip" });
    });
  });

export interface RunAgentFixOptions {
  /** Preferred agent id (e.g. "claude"). */
  agent?: string;
  /** Skip the menu and launch the preferred/first agent. */
  yes?: boolean;
  /** Just print the prompt; never launch or prompt. */
  print?: boolean;
  /** Launch the agent WITHOUT its bypass-approvals flags (it asks before each edit). */
  review?: boolean;
  /** Working directory the agent runs in. */
  cwd?: string;
  /** Path to a written full report the prompt points the agent at. */
  reportPath?: string;
  /** Injected menu (for tests). */
  chooseAction?: (agents: AgentDef[]) => Promise<FixAction>;
  /** Injected spawn (for tests) — returns the child exit code. */
  spawnAgent?: (bin: string, args: string[], cwd: string) => Promise<number>;
  /**
   * Re-scan after the agent finishes and machine-verify the fix (§51). Requires
   * `rescan`. The exit code then reflects the verdict, not the agent's own code.
   */
  verify?: boolean;
  /** Produce a fresh report for verification (injected so this stays testable). */
  rescan?: () => Promise<ScanReport>;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

const realSpawn = (bin: string, args: string[], cwd: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 0));
  });

/**
 * Offer to fix the report's findings with a coding agent, then hand off to it.
 * Returns the process exit code to use.
 */
export const runAgentFix = async (report: ScanReport, opts: RunAgentFixOptions = {}): Promise<number> => {
  const out = opts.out ?? ((s) => process.stdout.write(s));
  const err = opts.err ?? ((s) => process.stderr.write(s));

  const findings = report.findings.filter((f) => f.diagnostic !== "suppression-without-reason");
  if (findings.length === 0) {
    err("  ✓ No findings to fix.\n");
    return 0;
  }

  const agents = detectAgents();
  const prompt = buildAgentPrompt(report, { reportPath: opts.reportPath });

  if (opts.print) {
    out(prompt + "\n");
    return 0;
  }

  // Decide the action.
  let action: FixAction;
  if (opts.yes) {
    const chosen = opts.agent ? agents.find((a) => a.id === opts.agent) : agents[0];
    action = chosen ? { kind: "agent", agent: chosen } : { kind: "print" };
  } else if (!process.stdin.isTTY && !opts.chooseAction) {
    // Non-interactive with no explicit choice: print the prompt for the user's agent.
    err("  (non-interactive — printing the prompt for your agent)\n\n");
    out(prompt + "\n");
    return 0;
  } else {
    action = await (opts.chooseAction ?? defaultChooser)(agents);
  }

  switch (action.kind) {
    case "skip":
      return 0;
    case "print":
      out(prompt + "\n");
      return 0;
    case "copy":
      if (copyToClipboard(prompt)) err("  ✓ Prompt copied — paste it into your agent.\n");
      else out(prompt + "\n");
      return 0;
    case "agent": {
      const a = action.agent;
      const args = [...(opts.review ? [] : a.autoFlags), prompt];
      err(
        `\n  → Handing ${findings.length} finding(s) to ${a.label}. ` +
          (opts.review ? "It will ask before each edit.\n\n" : "It runs in auto-accept mode and will fix them end-to-end, then re-scan to confirm.\n\n"),
      );
      let agentExit: number;
      try {
        agentExit = await (opts.spawnAgent ?? realSpawn)(a.bin, args, opts.cwd ?? process.cwd());
      } catch {
        err(`\n  Couldn't launch ${a.bin}. Here's the prompt instead:\n\n`);
        out(prompt + "\n");
        return 0;
      }

      // §51 — don't take the agent's word for it: re-scan and check.
      if (opts.verify && opts.rescan) {
        try {
          const after = await opts.rescan();
          const verdict = verifyFixes(report, after);
          err(renderVerifyResult(verdict));
          return verdict.passed ? 0 : 1;
        } catch (e) {
          err(`\n  Verification re-scan failed: ${e instanceof Error ? e.message : String(e)}\n`);
          return agentExit;
        }
      }
      return agentExit;
    }
  }
};
