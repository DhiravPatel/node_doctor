/**
 * CLI runner: subcommand dispatch, output, and exit codes.
 *
 * Exit codes (§10): 0 = no blocking findings (or `--blocking none`); 1 = blocking
 * findings present; 2 = tool error.
 */

import { readFile, writeFile } from "node:fs/promises";
import { readFileSync, existsSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { parseArgs, type ParsedArgs } from "./args.ts";
import { hardenProcess } from "./lifecycle.ts";
import { startSpinner } from "./spinner.ts";
import { applyConfigActions, parseConfigAction } from "./config-writer.ts";
import { installCiWorkflow } from "./ci.ts";
import { installGitHook } from "../install/git-hook.ts";
import { scanProject } from "../core/scan.ts";
import type { ScanReport } from "../core/scan.ts";
import { computeDelta, deltaHasBlocking } from "../core/delta.ts";
import { renderReport, renderDelta, renderWorkspaceReport } from "../report/terminal.ts";
import { isWorkspaceRoot, scanWorkspaces, workspaceFindings } from "../core/workspaces.ts";
import { toJson, toJsonError } from "../report/json.ts";
import { toSarif } from "../report/sarif.ts";
import { toAnnotations } from "../report/annotations.ts";
import { toHtml } from "../report/html.ts";
import { renderReportMarkdown, renderDeltaMarkdown } from "../report/markdown.ts";
import { renderCodeFrame } from "../report/code-frame.ts";
import { buildIssueUrl } from "../report/issue-url.ts";
import { DIAGNOSTICS, DIAGNOSTICS_BY_ID } from "../core/registry.ts";
import { TEXT_DIAGNOSTICS } from "../diagnostics/secrets/index.ts";
import { IAC_DIAGNOSTICS } from "../diagnostics/iac/index.ts";
import { installSkill, CLIENTS, type SkillName } from "../skill/install.ts";
import { detectInstalledClients } from "../install/detect-agents.ts";
import { installAgentHooks } from "../install/agent-hooks.ts";
import { installPackageScript } from "../install/package-script.ts";
import { rememberClients } from "../install/prefs.ts";
import { runDeslop } from "../deslop/index.ts";
import { renderDeslop } from "../report/deslop.ts";
import { fixSource, FIXABLE_DIAGNOSTICS } from "../fix/index.ts";
import { fixDiffForFile } from "../fix/diff.ts";
import { writeConventions, CONVENTION_TARGETS } from "../core/conventions.ts";
import { RATCHET_FILENAME, buildRatchet, compareToRatchet, readRatchet, writeRatchet } from "../core/ratchet.ts";
import { extractRoutes, buildApiSurface, diffApiSurface, type RouteEntry } from "../core/api-surface.ts";
import { buildSbom } from "../core/sbom.ts";
import { scanGitHistoryForSecrets } from "../core/git-history-secrets.ts";
import { parseSource } from "../core/parse.ts";
import { attachParents } from "../core/walk.ts";
import { createLocator } from "../core/location.ts";
import { relative, sep } from "node:path";
import { runAgentFix } from "../agent/fix.ts";
import { lintSource } from "../core/scan.ts";
import { shouldEnableDiagnostic, discoverProject } from "../core/project.ts";
import { BUILTIN_IGNORES, loadConfig, loadConfigWithSource, effectiveSetting } from "../core/config.ts";
import type { NodeDoctorConfig } from "../core/config.ts";
import { startMcpServer } from "../mcp/server.ts";
import type { Finding } from "../core/types.ts";

/** Clickable OSC-8 links only in known-capable interactive terminals. */
const HYPERLINK_TERMS = new Set(["iTerm.app", "WezTerm", "vscode", "Hyper", "ghostty", "rio"]);
const supportsHyperlinks = (args: ParsedArgs): boolean => {
  if (args.json || args.scoreOnly) return false;
  if (process.env.FORCE_HYPERLINK) return true;
  if (!process.stdout.isTTY || process.env.CI) return false;
  return HYPERLINK_TERMS.has(process.env.TERM_PROGRAM ?? "");
};

/** A memoized synchronous source reader for verbose code frames. */
const makeSourceReader = (): ((f: Finding) => string | undefined) => {
  const cache = new Map<string, string | undefined>();
  return (f) => {
    if (!cache.has(f.filePath)) {
      try {
        cache.set(f.filePath, readFileSync(f.filePath, "utf8"));
      } catch {
        cache.set(f.filePath, undefined);
      }
    }
    return cache.get(f.filePath);
  };
};

/**
 * Resolve the directory to scan and the config to use, honoring a `rootDir`
 * config redirect (resolved against the config file's own location).
 */
const resolveScanTarget = async (
  args: ParsedArgs,
): Promise<{ dir: string; config: NodeDoctorConfig }> => {
  const cliDir = resolve(args.positionals[0] ?? ".");
  const loaded = await loadConfigWithSource(cliDir, args.config ? resolve(args.config) : undefined);
  if (loaded.config.rootDir && loaded.sourcePath) {
    const redirected = resolve(dirname(loaded.sourcePath), loaded.config.rootDir);
    if (existsSync(redirected) && statSync(redirected).isDirectory()) {
      return { dir: redirected, config: loaded.config };
    }
    process.stderr.write(`node-doctor: config rootDir "${loaded.config.rootDir}" is not a directory — ignoring.\n`);
  }
  return { dir: cliDir, config: loaded.config };
};

const readRepoUrl = async (): Promise<string | undefined> => {
  try {
    const raw = await readFile(new URL("../../package.json", import.meta.url), "utf8");
    const pkg = JSON.parse(raw) as { repository?: { url?: string } | string; bugs?: { url?: string } | string };
    const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    const bugs = typeof pkg.bugs === "string" ? pkg.bugs : pkg.bugs?.url;
    return repo ?? bugs;
  } catch {
    return undefined;
  }
};

const execFileAsync = promisify(execFile);

const SOURCE_EXT = /\.(js|mjs|cjs|jsx|ts|mts|cts|tsx)$/i;

const readVersion = async (): Promise<string> => {
  try {
    const raw = await readFile(new URL("../../package.json", import.meta.url), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
};

const useColor = (args: ParsedArgs): boolean => {
  if (args.json) return false;
  // Explicit --color / --no-color wins over auto-detection and NO_COLOR.
  if (args.color !== undefined) return args.color;
  return !process.env.NO_COLOR && !!process.stdout.isTTY;
};

const blockingExit = (findings: Finding[], blocking: string): number => {
  if (blocking === "none") return 0;
  if (blocking === "warning") return findings.length > 0 ? 1 : 0;
  return findings.some((d) => d.severity === "error") ? 1 : 0;
};

const gitFiles = async (dir: string, subcommand: string[]): Promise<string[]> => {
  try {
    const { stdout } = await execFileAsync("git", subcommand, { cwd: dir, maxBuffer: 16 * 1024 * 1024 });
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
};

/** True when a scoped subset (not a full scan) is requested. */
const hasScopeSelector = (args: ParsedArgs): boolean =>
  args.staged || args.diff !== undefined || !!args.only || !!args.changedFilesFrom;

/** Resolve an explicit file subset for --only / --diff / --staged / --changed-files-from. */
const resolveOnly = async (args: ParsedArgs, dir: string): Promise<string[] | undefined> => {
  const files = new Set<string>();

  if (args.staged) {
    for (const f of await gitFiles(dir, ["diff", "--cached", "--name-only", "--diff-filter=d"])) {
      if (SOURCE_EXT.test(f)) files.add(resolve(dir, f));
    }
  }
  if (args.diff !== undefined) {
    const base = args.diff || "HEAD";
    const range = args.diff ? `${base}...HEAD` : "HEAD";
    for (const f of await gitFiles(dir, ["diff", "--name-only", "--diff-filter=d", range])) {
      if (SOURCE_EXT.test(f)) files.add(resolve(dir, f));
    }
  }
  if (args.only) {
    const fg = (await import("fast-glob")).default;
    const matched = await fg([args.only], { cwd: dir, absolute: true, dot: false, suppressErrors: true });
    for (const f of matched) if (SOURCE_EXT.test(f)) files.add(f);
  }
  // The plumbing the CI Action uses: a newline-delimited changed-file list.
  if (args.changedFilesFrom) {
    try {
      const raw = await readFile(resolve(args.changedFilesFrom), "utf8");
      for (const line of raw.split("\n")) {
        const f = line.trim();
        if (f && SOURCE_EXT.test(f)) files.add(resolve(dir, f));
      }
    } catch (err) {
      process.stderr.write(
        `node-doctor: --changed-files-from ${args.changedFilesFrom}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  if (!hasScopeSelector(args)) {
    if (args.includeUntracked) {
      process.stderr.write("node-doctor: --include-untracked needs a scope (--staged/--diff/--only); ignoring.\n");
    }
    return undefined;
  }

  // Optionally add untracked (but gitignored-respecting) files to the scope.
  if (args.includeUntracked) {
    for (const f of await gitFiles(dir, ["ls-files", "--others", "--exclude-standard"])) {
      if (SOURCE_EXT.test(f)) files.add(resolve(dir, f));
    }
  }

  return [...files];
};

/**
 * Changed line ranges per file (normalized path → [start,end] inclusive), from
 * `git diff -U0`. Returns undefined when no base ref is available, so callers can
 * degrade to file-level scope. Used by `--scope lines`.
 */
const changedLineRanges = async (
  args: ParsedArgs,
  dir: string,
): Promise<Map<string, Array<[number, number]>> | undefined> => {
  const diffArgs = args.staged
    ? ["diff", "--cached", "-U0", "--diff-filter=d"]
    : args.diff
      ? ["diff", "-U0", "--diff-filter=d", `${args.diff}...HEAD`]
      : ["diff", "-U0", "--diff-filter=d", "HEAD"];

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("git", diffArgs, { cwd: dir, maxBuffer: 32 * 1024 * 1024 }));
  } catch {
    return undefined;
  }

  const ranges = new Map<string, Array<[number, number]>>();
  let current: string | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("+++ ")) {
      // "+++ b/path" or "+++ /dev/null"
      const p = line.slice(4).trim();
      current = p === "/dev/null" ? null : p.replace(/^[ab]\//, "");
      continue;
    }
    if (line.startsWith("@@") && current) {
      // @@ -old +newStart[,newCount] @@
      const m = /\+(\d+)(?:,(\d+))?/.exec(line);
      if (m) {
        const start = Number(m[1]);
        const count = m[2] === undefined ? 1 : Number(m[2]);
        if (count > 0) {
          const list = ranges.get(current) ?? [];
          list.push([start, start + count - 1]);
          ranges.set(current, list);
        }
      }
    }
  }
  return ranges;
};

const inChangedRanges = (finding: Finding, ranges: Map<string, Array<[number, number]>>): boolean => {
  const list = ranges.get(finding.normalizedFilePath);
  if (!list) return false;
  return list.some(([lo, hi]) => finding.line >= lo && finding.line <= hi);
};

const HELP = `node.doctor — deterministic static analysis for Node.js backends

Usage:
  node-doctor [directory] [options]      Scan a directory (default: cwd)
  node-doctor diagnostics [--json] [--category <c>] [--tag <t>] [--framework <f>] [--configured]
                                         List diagnostics + effective severity/source
  node-doctor delta --baseline <f> --current <f> [--blocking <level>]
  node-doctor install [--client <name>|all] [--skill improve-node]
                                         Install an agent skill (defaults to detected clients)
  node-doctor install --git-hook         Install an advisory pre-commit hook
  node-doctor install --agent-hooks      Install post-edit hooks (Claude Code / Cursor)
  node-doctor install --package-script   Add a "doctor" script to package.json
  node-doctor ci                         Scaffold a GitHub Actions workflow
  node-doctor conventions [dir]          Write CLAUDE.md/AGENTS.md from the detected stack
  node-doctor ratchet init|check         Lock current debt; fail only on new findings
  node-doctor surface [--json-out f]     Map every route + its auth posture
  node-doctor surface --baseline <f>     Diff the API surface; fail on breaking changes
  node-doctor sbom [--framework spdx]    Emit a CycloneDX (or SPDX) SBOM
  node-doctor deslop [directory]         Dead-code scan (unused files/exports/deps)
  node-doctor explain <diagnostic-id>          Explain a diagnostic and its fix
  node-doctor explain <file>:<line>      Why a diagnostic fired at a location
  node-doctor init [directory]           Scaffold a node-doctor.config.js
  node-doctor mcp                        Run as an MCP server (stdio) for agents
  node-doctor fix [directory]            Scan, then hand the findings to an AI agent to fix
  node-doctor version                    Print version + platform + Node runtime

Options:
  --json                 Emit the JSON report to stdout
  --json-compact         Emit the JSON report unindented (implies --json)
  --json-out <path>      Write the JSON report to a file
  --sarif-out <path>     Write a SARIF 2.1.0 report to a file
  --html-out <path>      Write a self-contained HTML report to a file
  --annotations          Emit GitHub Actions annotation lines
  --score                Print only the health score (quiet, for badges/CI)
  --fix                  Apply safe autofixes (e.g. node: protocol imports)
  --fix-diff             Print those autofixes as a unified diff instead of writing
  --dead-code            Also run the dead-code scan and fold it into the report
  --cache                Reuse unchanged files between runs (content-hash cache)
  --watch                Re-scan on file changes (implies --cache)
  --audit                Report findings even where inline-suppressed (audit mode)
  --max-duration <sec>   Stop scanning after N seconds (results become advisory)
  --no-parallel          Analyze files serially (default: bounded concurrency pool)
  --no-secrets           Skip the whole-tree secret/config-file scan (.env, YAML, keys)
  --history              Also scan git history for secrets that were committed
  --project <name|path>  (monorepo) scan only matching workspace project(s)
  --no-workspaces        (monorepo) scan the root as a single project
  --yes, -y              (fix) launch the agent without the menu
  --agent <name>         (fix) claude · codex · cursor
  --print                (fix) print the agent prompt instead of launching
  --review               (fix) agent asks before each edit (no bypass-approvals)
  --verify               (fix) re-scan after the agent and gate on the result
  --verbose, -v          Show every diagnostic and every site
  --blocking <level>     Exit policy: error (default), warning, none
  --category <name>      Show only a category (repeatable; display-only)
  --no-warnings          Show only error-severity findings (display-only)
  --ignore-tag <tag>     Disable a diagnostic family (repeatable)
  --only <glob>          Scan only files matching a glob
  --diff [base]          Scan only files changed vs base (default HEAD)
  --staged               Scan only staged files
  --scope <lines|files>  With --diff/--staged, gate only on changed lines
  --changed-files-from <f>  Read a newline-delimited changed-file list (CI)
  --include-untracked    Include untracked files in a scoped scan
  --color / --no-color   Force or disable ANSI color
  --config <path>        Use a specific config file
  --help, -h             Show this help
  --version, -V          Show the version
`;

interface DiagnosticRow {
  id: string;
  title: string;
  category: string;
  severity: "off" | "warn" | "error";
  defaultSeverity: string;
  source: "default" | "config";
  scope: "file" | "project" | "text";
  defaultEnabled: boolean;
  tags: string[];
  requires: string[];
  disabledWhen: string[];
}

/** `node-doctor diagnostics` — the catalog, with config-aware effective severity + filters. */
const runDiagnostics = async (args: ParsedArgs): Promise<number> => {
  // Writing verbs edit the config in place: `diagnostics set|enable|disable|…`.
  const action = parseConfigAction(args.positionals);
  if (action) {
    if ("error" in action) {
      process.stderr.write(`node-doctor: ${action.error}\n`);
      return 2;
    }
    const result = await applyConfigActions(resolve("."), [action]);
    for (const m of result.messages) process.stderr.write(`  ${result.ok ? "✓" : "✗"} ${m}\n`);
    if (result.printBlock) process.stdout.write(`\n${result.printBlock}\n`);
    if (result.ok && result.path) process.stderr.write(`  → wrote ${result.path}\n`);
    return result.exitCode;
  }

  const dir = resolve(args.positionals[0] ?? ".");
  const config = await loadConfig(dir, args.config ? resolve(args.config) : undefined);

  const catalog = [
    ...DIAGNOSTICS.map((d) => ({ d, scope: (d.scope ?? "file") as DiagnosticRow["scope"] })),
    ...[...TEXT_DIAGNOSTICS, ...IAC_DIAGNOSTICS].map((d) => ({ d, scope: "text" as DiagnosticRow["scope"] })),
  ];
  let rows: DiagnosticRow[] = catalog
    .sort((a, b) => (a.d.id < b.d.id ? -1 : 1))
    .map(({ d, scope }) => {
      const setting = effectiveSetting(d.id, d.severity, config);
      return {
        id: d.id,
        title: d.title,
        category: d.category,
        severity: setting,
        defaultSeverity: d.severity,
        source: config.diagnostics?.[d.id] ? "config" : "default",
        scope,
        defaultEnabled: d.defaultEnabled !== false,
        tags: d.tags ?? [],
        requires: d.requires ?? [],
        disabledWhen: d.disabledWhen ?? [],
      };
    });

  // Filters (all narrow the list; none change what a scan runs).
  if (args.categories.length > 0) {
    const set = new Set(args.categories);
    rows = rows.filter((r) => set.has(r.category));
  }
  if (args.tags.length > 0) {
    rows = rows.filter((r) => args.tags.some((t) => r.tags.includes(t)));
  }
  if (args.framework) {
    rows = rows.filter((r) => r.requires.includes(args.framework!));
  }
  if (args.configured) {
    rows = rows.filter((r) => r.source === "config");
  }

  if (args.json) {
    process.stdout.write(
      (args.jsonCompact ? JSON.stringify(rows) : JSON.stringify(rows, null, 2)) + "\n",
    );
    return 0;
  }

  const glyph = (s: string): string => (s === "off" ? "∅" : s === "error" ? "✖" : "⚠");
  for (const r of rows) {
    const gates: string[] = [];
    if (r.requires.length) gates.push(`requires ${r.requires.join(", ")}`);
    if (r.disabledWhen.length) gates.push(`off when ${r.disabledWhen.join(", ")}`);
    if (!r.defaultEnabled) gates.push("opt-in");
    if (r.scope === "project") gates.push("cross-file");
    if (r.scope === "text") gates.push("text-scan");
    if (r.source === "config") gates.push(`${r.severity} via config`);
    const gate = gates.length ? ` · ${gates.join(" · ")}` : "";
    process.stdout.write(`${glyph(r.severity)} node-doctor/${r.id}\n`);
    process.stdout.write(`    ${r.title}\n`);
    process.stdout.write(`    ${r.category}${gate}\n\n`);
  }
  process.stdout.write(`${rows.length} diagnostic${rows.length === 1 ? "" : "s"}\n`);
  return 0;
};

const SOURCE_GLOB = "**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}";

/** Apply safe autofixes to the source tree; returns files changed + edits made. */
/**
 * Apply the safe autofixes. In `diff` mode nothing is written — the change is
 * emitted as a unified diff instead (§54), so an agent can apply a patch rather
 * than re-derive the edit from prose, and a human can review before committing.
 */
const applyFixes = async (
  dir: string,
  only?: string[],
  mode: "write" | "diff" = "write",
): Promise<{ files: number; edits: number; diff: string }> => {
  const fg = (await import("fast-glob")).default;
  const targets =
    only ?? (await fg([SOURCE_GLOB], { cwd: dir, ignore: [...BUILTIN_IGNORES], absolute: true, suppressErrors: true }));
  let files = 0;
  let edits = 0;
  const patches: string[] = [];
  // Sorted so the emitted patch is deterministic across runs and machines.
  for (const f of targets.slice().sort()) {
    if (!SOURCE_EXT.test(f)) continue;
    let src: string;
    try {
      src = await readFile(f, "utf8");
    } catch {
      continue;
    }
    if (mode === "diff") {
      const { diff, applied } = fixDiffForFile(f, src, new Set(FIXABLE_DIAGNOSTICS), { rootDirectory: dir });
      if (applied > 0 && diff) {
        patches.push(diff);
        files += 1;
        edits += applied;
      }
      continue;
    }
    const { fixed, applied } = fixSource(f, src, new Set(FIXABLE_DIAGNOSTICS));
    if (applied > 0 && fixed !== src) {
      await writeFile(f, fixed);
      files += 1;
      edits += applied;
    }
  }
  return { files, edits, diff: patches.join("") };
};

const runWorkspaceScan = async (
  args: ParsedArgs,
  version: string,
  dir: string,
  config: NodeDoctorConfig,
): Promise<number> => {
  const spinner = !args.json && !args.scoreOnly ? startSpinner("scanning workspace…") : { stop: () => {} };
  let report: Awaited<ReturnType<typeof scanWorkspaces>>;
  try {
    report = await scanWorkspaces(dir, {
      config,
      ignoredTags: new Set(args.ignoreTags),
      cache: args.cache,
      parallel: args.parallel,
      secrets: args.secrets,
      respectInlineDisables: !args.audit,
      deadlineEpochMs: args.maxDuration !== undefined ? Date.now() + args.maxDuration * 1000 : undefined,
      projectFilter: args.projectFilter,
    });
  } finally {
    spinner.stop();
  }

  if (report.projects.length === 0) {
    process.stderr.write(
      args.projectFilter.length > 0
        ? `node-doctor: no workspace project matched ${args.projectFilter.map((s) => `"${s}"`).join(", ")}.\n`
        : "node-doctor: no workspace projects found.\n",
    );
    return 2;
  }

  const all = workspaceFindings(report);

  if (args.jsonOut) {
    await writeFile(resolve(args.jsonOut), (args.jsonCompact ? JSON.stringify(report) : JSON.stringify(report, null, 2)) + "\n");
  }

  if (args.json) {
    process.stdout.write((args.jsonCompact ? JSON.stringify(report) : JSON.stringify(report, null, 2)) + "\n");
  } else if (args.scoreOnly) {
    process.stdout.write(`${report.score.score}\n`);
  } else {
    process.stdout.write(renderWorkspaceReport(report, { color: useColor(args), version }) + "\n");
  }

  if (!args.json && !args.scoreOnly && process.stdout.isTTY && all.length > 0) {
    process.stderr.write("  → Fix these with an AI agent:  node-doctor fix\n\n");
  }

  return blockingExit(all, args.blocking);
};

const runScan = async (args: ParsedArgs, version: string): Promise<number> => {
  const { dir, config } = await resolveScanTarget(args);
  const only = await resolveOnly(args, dir);

  // Monorepo: when the root declares workspaces and this isn't a scoped/targeted
  // scan, scan every member project and aggregate a worst-of report.
  if (args.workspaces && only === undefined && !args.fix && (await isWorkspaceRoot(dir))) {
    return await runWorkspaceScan(args, version, dir, config);
  }

  if (args.fixDiff) {
    // Patch mode: emit the diff on stdout and stop — never write, never scan.
    const { files, edits, diff } = await applyFixes(dir, only, "diff");
    if (diff) process.stdout.write(diff);
    process.stderr.write(
      edits > 0
        ? `node-doctor --fix-diff: ${edits} safe edit(s) across ${files} file(s) — apply with \`git apply\`.\n`
        : "node-doctor --fix-diff: nothing mechanically fixable.\n",
    );
    return 0;
  }
  if (args.fix) {
    const { files, edits } = await applyFixes(dir, only);
    process.stderr.write(`node-doctor --fix: applied ${edits} safe edit(s) across ${files} file(s).\n`);
  }

  const ruleErrors: string[] = [];
  const spinner = !args.json && !args.scoreOnly ? startSpinner("scanning…") : { stop: () => {} };
  let report: ScanReport;
  try {
    report = await scanProject({
      rootDirectory: dir,
      config,
      ignoredTags: new Set(args.ignoreTags),
      only,
      cache: args.cache,
      parallel: args.parallel,
      secrets: args.secrets,
      respectInlineDisables: !args.audit,
      deadlineEpochMs: args.maxDuration !== undefined ? Date.now() + args.maxDuration * 1000 : undefined,
      onRuleError: (id, err) =>
        ruleErrors.push(`${id}: ${err instanceof Error ? err.message : String(err)}`),
    });
  } finally {
    spinner.stop();
  }

  // Optional dead-code scan folded into this run.
  const dead = args.deadCode === true ? await runDeslop(dir) : undefined;

  // Scope gating: `--scope lines` narrows the gated set to findings on changed
  // lines (falls back to the file set with a warning when no base is available).
  let gated = report.findings;
  if (args.scope === "lines") {
    const ranges = await changedLineRanges(args, dir);
    if (!ranges) {
      process.stderr.write("node-doctor: --scope lines needs a git base; falling back to file scope.\n");
    } else {
      gated = report.findings.filter((f) => inChangedRanges(f, ranges));
    }
  }

  // Display-only filters (category, warnings) never change score or gating.
  let shown = gated;
  if (args.categories.length > 0) {
    const set = new Set(args.categories);
    shown = shown.filter((f) => set.has(f.category));
  }
  if (!args.warnings) shown = shown.filter((f) => f.severity === "error");

  // The scoped report is what stdout/annotations reflect; file artifacts stay full.
  const scopedReport: ScanReport = args.scope === "lines" ? { ...report, findings: gated } : report;

  // File artifacts are always the complete, canonical report.
  if (args.jsonOut) await writeFile(resolve(args.jsonOut), toJson(report) + "\n");
  if (args.sarifOut) await writeFile(resolve(args.sarifOut), toSarif(report, { version }) + "\n");
  if (args.htmlOut) await writeFile(resolve(args.htmlOut), toHtml(report, { version }));
  if (args.mdOut) await writeFile(resolve(args.mdOut), renderReportMarkdown(report));

  if (args.json) {
    const payload = dead ? { ...scopedReport, deadCode: dead } : scopedReport;
    process.stdout.write(
      (args.jsonCompact ? JSON.stringify(payload) : JSON.stringify(payload, null, 2)) + "\n",
    );
  } else if (args.scoreOnly) {
    process.stdout.write(`${report.score.score}\n`);
  } else {
    const displayReport: ScanReport = { ...report, findings: shown };
    process.stdout.write(
      renderReport(displayReport, {
        verbose: args.verbose,
        color: useColor(args),
        version,
        hyperlinks: supportsHyperlinks(args),
        sourceFor: args.verbose ? makeSourceReader() : undefined,
      }) + "\n",
    );
    if (dead) process.stdout.write(renderDeslop(dead, { color: useColor(args) }) + "\n");
    if (args.verbose && ruleErrors.length > 0) {
      process.stderr.write(`\n  ${ruleErrors.length} diagnostic error(s) (skipped):\n`);
      for (const e of ruleErrors) process.stderr.write(`     ${e}\n`);
    }
  }

  if (args.annotations) process.stdout.write(toAnnotations(scopedReport) + "\n");

  // §68 — history secrets are reported alongside the scan, not scored (they are
  // historical facts about the repo, not defects in the current tree).
  if (args.history) {
    const historic = await scanGitHistoryForSecrets(dir);
    if (historic.length > 0 && !args.json) {
      process.stdout.write(`\n  Git history — ${historic.length} secret(s) committed in the past:\n`);
      for (const h of historic.slice(0, 20)) {
        process.stdout.write(
          `    ${h.commit}  ${h.label}  ${h.file}${h.removedFromHead ? "  (deleted from HEAD — ROTATE IT)" : ""}\n`,
        );
      }
      process.stdout.write("    A deleted secret is still in history and in every clone. Rotate, do not just delete.\n");
    }
  }

  // Time budget exhausted: results are advisory, not a clean bill of health.
  if (args.maxDuration !== undefined && !report.project.complete) {
    process.stderr.write(
      `  ⚠ stopped early after the ${args.maxDuration}s budget — ${report.project.analyzedFileCount} file(s) analyzed; results are advisory.\n`,
    );
  }

  // In an interactive terminal, point the user at the agent-fix flow.
  if (!args.json && !args.scoreOnly && process.stdout.isTTY && shown.length > 0) {
    process.stderr.write("  → Fix these with an AI agent:  node-doctor fix\n\n");
  }

  return blockingExit(gated, args.blocking);
};

const runWatch = async (args: ParsedArgs, version: string): Promise<number> => {
  const dir = resolve(args.positionals[0] ?? ".");
  // Force the content-hash cache on so re-scans only re-analyze changed files.
  const watchArgs: ParsedArgs = { ...args, cache: true, watch: false };

  await runScan(watchArgs, version);
  process.stderr.write("\nnode-doctor: watching for changes — Ctrl-C to stop.\n");

  const { watch } = await import("node:fs");
  let timer: ReturnType<typeof setTimeout> | null = null;
  const rescan = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      process.stderr.write("\n─── re-scan ───\n");
      void runScan(watchArgs, version).catch(() => {});
    }, 200);
  };
  try {
    watch(dir, { recursive: true }, (_event, filename) => {
      if (filename && SOURCE_EXT.test(String(filename))) rescan();
    });
  } catch {
    process.stderr.write("node-doctor: recursive watch is not supported here; watch mode unavailable.\n");
    return 0;
  }
  // Runs until interrupted.
  return new Promise<number>(() => {});
};

const runDelta = async (args: ParsedArgs): Promise<number> => {
  if (!args.baseline || !args.current) {
    process.stderr.write("node-doctor delta: --baseline and --current are required\n");
    return 2;
  }
  let baseline: ScanReport;
  let current: ScanReport;
  try {
    baseline = JSON.parse(await readFile(resolve(args.baseline), "utf8")) as ScanReport;
    current = JSON.parse(await readFile(resolve(args.current), "utf8")) as ScanReport;
  } catch (err) {
    process.stderr.write(`node-doctor delta: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  const { introduced, resolved } = computeDelta(baseline, current);
  if (args.mdOut) {
    await writeFile(
      resolve(args.mdOut),
      renderDeltaMarkdown(introduced, resolved, { headScore: current.score ? { score: current.score.score, label: current.score.label } : undefined }),
    );
  }
  if (args.json) {
    process.stdout.write(JSON.stringify({ introduced, resolved }, null, 2) + "\n");
  } else {
    process.stdout.write(
      renderDelta(introduced, resolved, { color: useColor(args), hyperlinks: supportsHyperlinks(args) }) + "\n",
    );
  }
  return deltaHasBlocking(introduced, args.blocking) ? 1 : 0;
};

const runGitHook = async (args: ParsedArgs): Promise<number> => {
  const cwd = resolve(args.positionals[0] ?? ".");
  try {
    const result = await installGitHook({ cwd });
    process.stdout.write(`  ✓ ${result.action} pre-commit hook → ${result.path}\n`);
    process.stderr.write("  It runs `node-doctor --staged --blocking warning` (advisory — never blocks the commit).\n");
    return 0;
  } catch (err) {
    process.stderr.write(`node-doctor install --git-hook: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
};

const runCi = async (args: ParsedArgs): Promise<number> => {
  const cwd = resolve(args.positionals[0] ?? ".");
  // Accept `ci install` (or bare `ci`); the verb is documentary.
  const result = await installCiWorkflow(cwd);
  if (result.action === "skipped") {
    process.stderr.write(`node-doctor ci: ${result.path} already exists — leaving it untouched.\n`);
    return 1;
  }
  process.stdout.write(`  ✓ wrote ${result.path}\n`);
  process.stderr.write("  It runs the baseline delta on every PR and reports only introduced findings.\n");
  return 0;
};

const runAgentHooks = async (args: ParsedArgs): Promise<number> => {
  const cwd = resolve(args.positionals[0] ?? ".");
  const { written } = await installAgentHooks(cwd);
  for (const w of written) process.stdout.write(`  ✓ ${w}\n`);
  process.stderr.write("  Post-edit hooks installed — the agent gets node.doctor feedback as it edits.\n");
  return 0;
};

const runPackageScript = async (args: ParsedArgs): Promise<number> => {
  const cwd = resolve(args.positionals[0] ?? ".");
  try {
    const r = await installPackageScript({ cwd });
    process.stdout.write(
      r.scriptAdded
        ? `  ✓ added "${r.scriptName}": "node-doctor" to ${r.packageJson}\n`
        : `  · "${r.scriptName}" script already present in ${r.packageJson}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`node-doctor install --package-script: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
};

const runInstall = async (args: ParsedArgs): Promise<number> => {
  if (args.gitHook) return await runGitHook(args);
  if (args.agentHooks) return await runAgentHooks(args);
  if (args.packageScript) return await runPackageScript(args);

  const targetDir = resolve(args.positionals[0] ?? ".");
  const skill: SkillName = args.skill === "improve-node" ? "improve-node" : "node-doctor";

  // Resolve clients: explicit --client wins; "all" forces every known client;
  // otherwise default to the clients detected in this project/machine, else all.
  let client: string | undefined = args.client;
  let clients: string[] | undefined;
  if (client === "all") {
    client = undefined;
  } else if (!client) {
    const detected = detectInstalledClients(targetDir).map((c) => c.id);
    if (detected.length > 0) clients = detected;
  }

  let result;
  try {
    result = await installSkill({ client, clients, skill, targetDir });
  } catch (err) {
    process.stderr.write(`node-doctor install: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  if (result.written.length === 0) {
    process.stderr.write(
      `node-doctor install: no known client path was writable.\n` +
        `Known clients: ${[...CLIENTS.keys()].join(", ")}\n`,
    );
    return 2;
  }
  for (const w of result.written) process.stdout.write(`  ✓ installed ${skill} skill → ${w}\n`);
  // Remember the resolved client selection to pre-fill next time (never read by a scan).
  await rememberClients(client ? [client] : (clients ?? [...CLIENTS.keys()]));
  return 0;
};

const runDeslopCommand = async (args: ParsedArgs): Promise<number> => {
  const dir = resolve(args.positionals[0] ?? ".");
  const result = await runDeslop(dir);
  if (args.jsonOut) await writeFile(resolve(args.jsonOut), JSON.stringify(result, null, 2) + "\n");
  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(renderDeslop(result, { color: useColor(args) }) + "\n");
  }
  const total =
    result.unusedFiles.length + result.unusedExports.length + result.unusedDependencies.length;
  // deslop is informational by default; only `--blocking warning` makes it fail.
  return args.blocking === "warning" && total > 0 ? 1 : 0;
};

const CONFIG_TEMPLATE = `// node-doctor.config.js — see https://github.com/your-org/node-doctor
export default {
  // Override a diagnostic's severity, or turn it off entirely.
  diagnostics: {
    // "no-query-in-loop": "off",
    // "require-fetch-timeout": "error", // upgrade a warning to an error
    // "prefer-node-protocol-imports": "warn", // enable an opt-in diagnostic
  },

  // Disable whole diagnostic families (see \`node-doctor diagnostics\` for tags).
  ignoreTags: [
    // "maintainability",
  ],

  // Skip paths (in addition to the built-in node_modules/dist/build/... ignores).
  ignore: [
    // "**/legacy/**",
    // "**/*.generated.ts",
  ],

  // Default exit policy: "error" | "warning" | "none".
  blocking: "error",
};
`;

const runExplain = async (args: ParsedArgs): Promise<number> => {
  const target = args.positionals[0];
  if (!target) {
    process.stderr.write("usage: node-doctor explain <diagnostic-id> | <file>:<line>\n");
    return 2;
  }

  const bareId = target.replace(/^node-doctor\//, "");
  const fileLine = /^(.+):(\d+)$/.exec(target);

  // file:line mode (unless it is actually a known diagnostic id).
  if (fileLine && !DIAGNOSTICS_BY_ID.has(bareId)) {
    const file = resolve(fileLine[1]!);
    const line = Number(fileLine[2]);
    const project = await discoverProject(dirname(file));
    const caps = project.capabilities;
    let src: string;
    try {
      src = await readFile(file, "utf8");
    } catch {
      process.stderr.write(`node-doctor explain: cannot read ${file}\n`);
      return 2;
    }
    const active = DIAGNOSTICS.filter((r) => shouldEnableDiagnostic(r, caps) && (r.scope ?? "file") === "file");
    const { findings } = lintSource({ filePath: file, sourceText: src, diagnostics: active, capabilities: caps });
    const here = findings.filter((d) => d.line === line);

    if (here.length === 0) {
      process.stdout.write(`No findings on ${fileLine[1]}:${line}.\n`);
      process.stdout.write(`${active.length} file-scope diagnostics were active for this project (${[...caps].sort().join(" ")}).\n`);
      process.stdout.write(`A clean line means "no detected defect", never "correct" — reason about the cross-file cases yourself.\n`);
      return 0;
    }
    const repoUrl = await readRepoUrl();
    for (const d of here) {
      process.stdout.write(`\n${d.severity === "error" ? "✖" : "⚠"} node-doctor/${d.diagnostic}  (${d.category})\n`);
      process.stdout.write(`  ${d.title}\n`);
      const frame = renderCodeFrame({ sourceText: src, line: d.line, column: d.column, indent: "  " });
      if (frame) process.stdout.write(frame + "\n");
      process.stdout.write(`  Why it fired here: ${d.message}\n`);
      process.stdout.write(`  Fix: ${d.recommendation}\n`);
      const issueUrl = buildIssueUrl(d, repoUrl);
      if (issueUrl) process.stdout.write(`  False positive? Report it: ${issueUrl}\n`);
    }
    process.stdout.write("\n");
    return 0;
  }

  // diagnostic-id mode.
  const diagnostic = DIAGNOSTICS_BY_ID.get(bareId);
  if (!diagnostic) {
    process.stderr.write(`node-doctor explain: unknown diagnostic "${target}". Run \`node-doctor diagnostics\` for the catalog.\n`);
    return 2;
  }
  const gate = [
    diagnostic.requires?.length ? `requires ${diagnostic.requires.join(", ")}` : "",
    diagnostic.disabledWhen?.length ? `off on ${diagnostic.disabledWhen.join(", ")}` : "",
    diagnostic.scope === "project" ? "project-scope (cross-file)" : "",
    diagnostic.defaultEnabled === false ? "opt-in" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  process.stdout.write(`\nnode-doctor/${diagnostic.id}\n`);
  process.stdout.write(`${diagnostic.title}\n`);
  process.stdout.write(`${diagnostic.category} · ${diagnostic.severity}${gate ? ` · ${gate}` : ""}\n`);
  process.stdout.write(`tags: ${(diagnostic.tags ?? []).join(", ") || "—"}\n\n`);
  process.stdout.write(`Fix: ${diagnostic.recommendation}\n\n`);
  return 0;
};

const runInit = async (args: ParsedArgs): Promise<number> => {
  const dir = resolve(args.positionals[0] ?? ".");
  const target = join(dir, "node-doctor.config.js");
  try {
    await readFile(target, "utf8");
    process.stderr.write(`node-doctor init: ${target} already exists — leaving it untouched.\n`);
    return 1;
  } catch {
    /* does not exist — create it */
  }
  await writeFile(target, CONFIG_TEMPLATE);
  process.stdout.write(`  ✓ wrote ${target}\n`);
  return 0;
};

/** §50 — write a conventions file derived from the project's own detected stack. */
const runConventions = async (args: ParsedArgs): Promise<number> => {
  const dir = resolve(args.positionals[0] ?? ".");
  const targets = args.projectFilter.length > 0 ? args.projectFilter : undefined;
  const { written, skipped } = await writeConventions({
    rootDirectory: dir,
    targets,
    overwrite: args.overwrite,
  });
  for (const w of written) process.stdout.write(`  ✓ wrote ${w}\n`);
  for (const s of skipped) process.stdout.write(`  · exists, left alone: ${s}  (--overwrite to replace)\n`);
  if (written.length === 0 && skipped.length === 0) {
    process.stderr.write(
      `node-doctor conventions: no target matched. Known: ${CONVENTION_TARGETS.map((t) => t.id).join(", ")}\n`,
    );
    return 2;
  }
  return 0;
};

/** §87 — baseline ratchet: lock today's debt, fail only on new, tighten on improvement. */
const runRatchet = async (args: ParsedArgs, version: string): Promise<number> => {
  const sub = args.positionals[0] ?? "check";
  if (sub !== "init" && sub !== "check") {
    process.stderr.write(`node-doctor ratchet: unknown subcommand "${sub}". Use: init | check\n`);
    return 2;
  }
  const { dir, config } = await resolveScanTarget({ ...args, positionals: args.positionals.slice(1) });
  const ratchetPath = join(dir, RATCHET_FILENAME);
  const report = await scanProject({
    rootDirectory: dir,
    config,
    ignoredTags: new Set(args.ignoreTags),
    cache: args.cache,
    parallel: args.parallel,
    secrets: args.secrets,
  });

  if (sub === "init") {
    const ratchet = buildRatchet(report);
    await writeRatchet(ratchetPath, ratchet);
    process.stdout.write(
      `  ✓ ratchet set at ${report.score.score}/100 with ${ratchet.accepted.length} accepted finding(s)\n` +
        `    ${ratchetPath}\n` +
        `    New findings will now fail; the accepted set can only shrink.\n`,
    );
    return 0;
  }

  const ratchet = await readRatchet(ratchetPath);
  if (!ratchet) {
    process.stderr.write(
      `node-doctor ratchet: no ratchet at ${ratchetPath}. Run \`node-doctor ratchet init\` first.\n`,
    );
    return 2;
  }
  const cmp = compareToRatchet(report, ratchet);

  if (args.json) {
    process.stdout.write(
      (args.jsonCompact ? JSON.stringify(cmp) : JSON.stringify(cmp, null, 2)) + "\n",
    );
  } else {
    const p = useColor(args);
    process.stdout.write(
      `\n  Ratchet: ${cmp.passed ? "PASS" : "FAIL"}  ·  score ${ratchet.score} → ${report.score.score} (${cmp.scoreDelta >= 0 ? "+" : ""}${cmp.scoreDelta})\n`,
    );
    if (cmp.resolved > 0) process.stdout.write(`  ✓ ${cmp.resolved} accepted finding(s) resolved\n`);
    if (cmp.introduced.length > 0) {
      process.stdout.write(`  ✖ ${cmp.introduced.length} NEW finding(s) beyond the accepted baseline:\n`);
      process.stdout.write(
        renderReport({ ...report, findings: cmp.introduced }, { verbose: args.verbose, color: p, version }) + "\n",
      );
    } else if (!cmp.passed) {
      // The score-only regression case — say so, or the FAIL looks unexplained.
      process.stdout.write(
        `  ✖ No new findings, but the score fell below the ratchet floor (${ratchet.score}).\n`,
      );
    }
    process.stdout.write("\n");
  }

  if (cmp.tightened) {
    await writeRatchet(ratchetPath, cmp.tightened);
    process.stderr.write(`  ↓ ratchet tightened to ${cmp.tightened.score}/100 (${cmp.tightened.accepted.length} accepted)\n`);
  }
  return cmp.passed ? 0 : 1;
};

/**
 * §70/§78 — the attack-surface map and API breaking-change diff. Enumerates every
 * route with its guard chain; with --baseline it diffs against a saved surface.
 */
const runSurface = async (args: ParsedArgs): Promise<number> => {
  const { dir, config } = await resolveScanTarget(args);
  const fg = (await import("fast-glob")).default;
  const files = (
    await fg([SOURCE_GLOB], {
      cwd: dir,
      ignore: [...BUILTIN_IGNORES, ...(config.ignore ?? [])],
      absolute: true,
      suppressErrors: true,
    })
  ).sort();

  const routes: RouteEntry[] = [];
  for (const file of files) {
    let src: string;
    try {
      src = await readFile(file, "utf8");
    } catch {
      continue;
    }
    // Cheap pre-filter: no route verb in the text, no need to parse.
    if (!/\.(get|post|put|patch|delete|del|options|head|all|route)\s*\(/.test(src)) continue;
    const parsed = parseSource(file, src);
    if (parsed.parseFailed) continue;
    attachParents(parsed.program);
    routes.push(
      ...extractRoutes(parsed.program, relative(dir, file).split(sep).join("/"), createLocator(src)),
    );
  }
  const surface = buildApiSurface(routes);

  // --baseline <file>: diff instead of listing (§78).
  if (args.baseline) {
    let baselineRoutes: RouteEntry[];
    try {
      const raw = JSON.parse(await readFile(resolve(args.baseline), "utf8")) as { routes?: RouteEntry[] };
      baselineRoutes = raw.routes ?? [];
    } catch (err) {
      process.stderr.write(`node-doctor surface: cannot read baseline — ${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
    const changes = diffApiSurface(baselineRoutes, surface.routes);
    const breaking = changes.filter((c) => c.breaking);
    if (args.json) {
      process.stdout.write((args.jsonCompact ? JSON.stringify({ changes }) : JSON.stringify({ changes }, null, 2)) + "\n");
    } else if (changes.length === 0) {
      process.stdout.write("\n  ✓ No API changes.\n\n");
    } else {
      process.stdout.write("\n");
      for (const c of changes) {
        process.stdout.write(`  ${c.breaking ? "✖ BREAKING" : "·         "}  ${c.route}  — ${c.detail}\n`);
      }
      process.stdout.write(`\n  ${breaking.length} breaking, ${changes.length - breaking.length} other.\n\n`);
    }
    return breaking.length > 0 && args.blocking !== "none" ? 1 : 0;
  }

  if (args.jsonOut) {
    await writeFile(resolve(args.jsonOut), JSON.stringify(surface, null, 2) + "\n");
  }
  if (args.json) {
    process.stdout.write((args.jsonCompact ? JSON.stringify(surface) : JSON.stringify(surface, null, 2)) + "\n");
    return 0;
  }

  const p = useColor(args);
  process.stdout.write(`\n  Attack surface — ${surface.routes.length} route(s), ${surface.unauthenticated.length} unauthenticated\n\n`);
  for (const r of surface.routes) {
    const mark = r.authenticated ? "🔒" : "🌐";
    process.stdout.write(
      `  ${mark} ${r.method.padEnd(7)}${r.path.padEnd(34)} ${r.middleware.join(" → ")}\n` +
        `       ${r.normalizedFilePath}:${r.line}\n`,
    );
  }
  if (surface.unauthenticated.length > 0) {
    process.stdout.write(
      `\n  ⚠ ${surface.unauthenticated.length} route(s) have no recognizable auth guard — confirm each is intentionally public.\n`,
    );
  }
  process.stdout.write("\n");
  void p;
  return 0;
};

/** §67 — emit a CycloneDX or SPDX SBOM for the dependency tree (offline). */
const runSbom = async (args: ParsedArgs): Promise<number> => {
  const dir = resolve(args.positionals[0] ?? ".");
  const format = args.framework === "spdx" ? "spdx" : "cyclonedx";
  try {
    const doc = await buildSbom(dir, { format });
    if (args.jsonOut) await writeFile(resolve(args.jsonOut), doc + "\n");
    else process.stdout.write(doc + "\n");
    return 0;
  } catch (err) {
    process.stderr.write(`node-doctor sbom: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
};

const runFix = async (args: ParsedArgs, version: string): Promise<number> => {
  const dir = resolve(args.positionals[0] ?? ".");
  const only = await resolveOnly(args, dir);
  // The exact scan the verification pass must repeat, so before/after are comparable.
  const scanOptions = {
    rootDirectory: dir,
    ignoredTags: new Set(args.ignoreTags),
    only,
    parallel: args.parallel,
    secrets: args.secrets,
    configPath: args.config ? resolve(args.config) : undefined,
  };
  const report = await scanProject({ ...scanOptions, cache: args.cache });

  // Show the findings first (unless we're only emitting the prompt for piping).
  if (!args.print) {
    process.stdout.write(renderReport(report, { verbose: args.verbose, color: useColor(args), version }) + "\n");
  }

  // Write the full report so the agent can read every finding.
  let reportPath: string | undefined;
  try {
    reportPath = join(tmpdir(), "node-doctor-report.json");
    await writeFile(reportPath, toJson(report) + "\n");
  } catch {
    reportPath = undefined;
  }

  return runAgentFix(report, {
    agent: args.agent,
    yes: args.yes,
    print: args.print,
    review: args.review,
    cwd: dir,
    reportPath,
    verify: args.verify,
    // Re-scan with the cache OFF so the verification sees the agent's edits.
    rescan: () => scanProject({ ...scanOptions, cache: false }),
  });
};

export const main = async (argv: string[]): Promise<number> => {
  hardenProcess();
  const args = parseArgs(argv);
  const version = await readVersion();

  if (args.version) {
    process.stdout.write(`${version}\n`);
    return 0;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.errors.length > 0) {
    if (args.json) {
      process.stdout.write(toJsonError(new Error(args.errors.join("; ")), { compact: args.jsonCompact }) + "\n");
    } else {
      for (const e of args.errors) process.stderr.write(`node-doctor: ${e}\n`);
      process.stderr.write(`Run \`node-doctor --help\` for usage.\n`);
    }
    return 2;
  }

  try {
    switch (args.command) {
      case "version":
        process.stdout.write(`node-doctor/${version} ${process.platform}-${process.arch} node-${process.version}\n`);
        return 0;
      case "diagnostics":
        return await runDiagnostics(args);
      case "delta":
        return await runDelta(args);
      case "install":
        return await runInstall(args);
      case "deslop":
        return await runDeslopCommand(args);
      case "explain":
        return await runExplain(args);
      case "init":
        return await runInit(args);
      case "mcp":
        await startMcpServer();
        return 0;
      case "conventions":
        return await runConventions(args);
      case "sbom":
        return await runSbom(args);
      case "surface":
        return await runSurface(args);
      case "ratchet":
        return await runRatchet(args, version);
      case "ci":
        return await runCi(args);
      case "fix":
        return await runFix(args, version);
      case "scan":
      default:
        return args.watch ? await runWatch(args, version) : await runScan(args, version);
    }
  } catch (err) {
    // In JSON mode, always emit a well-formed error report so CI consumers can parse it.
    if (args.json) {
      process.stdout.write(toJsonError(err, { compact: args.jsonCompact }) + "\n");
    } else {
      process.stderr.write(`node-doctor: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    }
    return 2;
  }
};

// Allow direct execution (`node src/cli/run.ts`) as well as being imported by the
// bin shim. When imported, `process.argv[1]` is the shim, so this stays inert.
const invokedDirectly = (): boolean => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
};

if (invokedDirectly()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`node-doctor: ${err instanceof Error ? err.stack : String(err)}\n`);
      process.exit(2);
    },
  );
}
