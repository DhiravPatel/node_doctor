/**
 * CLI runner: subcommand dispatch, output, and exit codes.
 *
 * Exit codes (§10): 0 = no blocking findings (or `--blocking none`); 1 = blocking
 * findings present; 2 = tool error.
 */

import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs, type ParsedArgs } from "./args.ts";
import { scanProject } from "../core/scan.ts";
import type { ScanReport } from "../core/scan.ts";
import { computeDelta, deltaHasBlocking } from "../core/delta.ts";
import { renderReport, renderDelta } from "../report/terminal.ts";
import { toJson } from "../report/json.ts";
import { toSarif } from "../report/sarif.ts";
import { toAnnotations } from "../report/annotations.ts";
import { toHtml } from "../report/html.ts";
import { DIAGNOSTICS, DIAGNOSTICS_BY_ID } from "../core/registry.ts";
import { installSkill, CLIENTS } from "../skill/install.ts";
import { runDeslop } from "../deslop/index.ts";
import { renderDeslop } from "../report/deslop.ts";
import { fixSource, FIXABLE_DIAGNOSTICS } from "../fix/index.ts";
import { lintSource } from "../core/scan.ts";
import { shouldEnableDiagnostic, discoverProject } from "../core/project.ts";
import { BUILTIN_IGNORES } from "../core/config.ts";
import { startMcpServer } from "../mcp/server.ts";
import type { Finding } from "../core/types.ts";

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

const useColor = (args: ParsedArgs): boolean =>
  !args.json && !process.env.NO_COLOR && !!process.stdout.isTTY;

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

/** Resolve an explicit file subset for --only / --diff / --staged. */
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

  if (!args.staged && args.diff === undefined && !args.only) return undefined;
  return [...files];
};

const HELP = `node.doctor — deterministic static analysis for Node.js backends

Usage:
  node-doctor [directory] [options]      Scan a directory (default: cwd)
  node-doctor diagnostics                      List every diagnostic and its gating
  node-doctor delta --baseline <f> --current <f> [--blocking <level>]
  node-doctor install [--client <name>]  Install the agent skill
  node-doctor deslop [directory]         Dead-code scan (unused files/exports/deps)
  node-doctor explain <diagnostic-id>          Explain a diagnostic and its fix
  node-doctor explain <file>:<line>      Why a diagnostic fired at a location
  node-doctor init [directory]           Scaffold a node-doctor.config.js
  node-doctor mcp                        Run as an MCP server (stdio) for agents

Options:
  --json                 Emit the JSON report to stdout
  --json-out <path>      Write the JSON report to a file
  --sarif-out <path>     Write a SARIF 2.1.0 report to a file
  --html-out <path>      Write a self-contained HTML report to a file
  --annotations          Emit GitHub Actions annotation lines
  --fix                  Apply safe autofixes (e.g. node: protocol imports)
  --cache                Reuse unchanged files between runs (content-hash cache)
  --watch                Re-scan on file changes (implies --cache)
  --verbose, -v          Show every diagnostic and every site
  --blocking <level>     Exit policy: error (default), warning, none
  --ignore-tag <tag>     Disable a diagnostic family (repeatable)
  --only <glob>          Scan only files matching a glob
  --diff [base]          Scan only files changed vs base (default HEAD)
  --staged               Scan only staged files
  --config <path>        Use a specific config file
  --help, -h             Show this help
  --version, -V          Show the version
`;

const printDiagnostics = (): void => {
  const sorted = DIAGNOSTICS.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
  const glyph = (s: string): string => (s === "error" ? "✖" : "⚠");
  for (const diagnostic of sorted) {
    const gates: string[] = [];
    if (diagnostic.requires?.length) gates.push(`requires ${diagnostic.requires.join(", ")}`);
    if (diagnostic.disabledWhen?.length) gates.push(`off when ${diagnostic.disabledWhen.join(", ")}`);
    if (diagnostic.defaultEnabled === false) gates.push("opt-in");
    const gate = gates.length ? ` · ${gates.join(" · ")}` : "";
    process.stdout.write(`${glyph(diagnostic.severity)} node-doctor/${diagnostic.id}\n`);
    process.stdout.write(`    ${diagnostic.title}\n`);
    process.stdout.write(`    ${diagnostic.category}${gate}\n\n`);
  }
  process.stdout.write(`${DIAGNOSTICS.length} diagnostics\n`);
};

const SOURCE_GLOB = "**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}";

/** Apply safe autofixes to the source tree; returns files changed + edits made. */
const applyFixes = async (dir: string, only?: string[]): Promise<{ files: number; edits: number }> => {
  const fg = (await import("fast-glob")).default;
  const targets =
    only ?? (await fg([SOURCE_GLOB], { cwd: dir, ignore: [...BUILTIN_IGNORES], absolute: true, suppressErrors: true }));
  let files = 0;
  let edits = 0;
  for (const f of targets) {
    if (!SOURCE_EXT.test(f)) continue;
    let src: string;
    try {
      src = await readFile(f, "utf8");
    } catch {
      continue;
    }
    const { fixed, applied } = fixSource(f, src, new Set(FIXABLE_DIAGNOSTICS));
    if (applied > 0 && fixed !== src) {
      await writeFile(f, fixed);
      files += 1;
      edits += applied;
    }
  }
  return { files, edits };
};

const runScan = async (args: ParsedArgs, version: string): Promise<number> => {
  const dir = resolve(args.positionals[0] ?? ".");
  const only = await resolveOnly(args, dir);

  if (args.fix) {
    const { files, edits } = await applyFixes(dir, only);
    process.stderr.write(`node-doctor --fix: applied ${edits} safe edit(s) across ${files} file(s).\n`);
  }

  const ruleErrors: string[] = [];
  const report = await scanProject({
    rootDirectory: dir,
    ignoredTags: new Set(args.ignoreTags),
    only,
    cache: args.cache,
    configPath: args.config ? resolve(args.config) : undefined,
    onRuleError: (id, err) =>
      ruleErrors.push(`${id}: ${err instanceof Error ? err.message : String(err)}`),
  });

  if (args.jsonOut) await writeFile(resolve(args.jsonOut), toJson(report) + "\n");
  if (args.sarifOut) await writeFile(resolve(args.sarifOut), toSarif(report, { version }) + "\n");
  if (args.htmlOut) await writeFile(resolve(args.htmlOut), toHtml(report, { version }));

  if (args.json) {
    process.stdout.write(toJson(report) + "\n");
  } else {
    process.stdout.write(renderReport(report, { verbose: args.verbose, color: useColor(args), version }) + "\n");
    if (args.verbose && ruleErrors.length > 0) {
      process.stderr.write(`\n  ${ruleErrors.length} diagnostic error(s) (skipped):\n`);
      for (const e of ruleErrors) process.stderr.write(`     ${e}\n`);
    }
  }

  if (args.annotations) process.stdout.write(toAnnotations(report) + "\n");

  return blockingExit(report.findings, args.blocking);
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
  if (args.json) {
    process.stdout.write(JSON.stringify({ introduced, resolved }, null, 2) + "\n");
  } else {
    process.stdout.write(renderDelta(introduced, resolved, { color: useColor(args) }) + "\n");
  }
  return deltaHasBlocking(introduced, args.blocking) ? 1 : 0;
};

const runInstall = async (args: ParsedArgs): Promise<number> => {
  const targetDir = resolve(args.positionals[0] ?? ".");
  const result = await installSkill({ client: args.client, targetDir });
  if (result.written.length === 0) {
    process.stderr.write(
      `node-doctor install: no known client path was writable.\n` +
        `Known clients: ${[...CLIENTS.keys()].join(", ")}\n`,
    );
    return 2;
  }
  for (const w of result.written) process.stdout.write(`  ✓ installed skill → ${w}\n`);
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
    for (const d of here) {
      process.stdout.write(`\n${d.severity === "error" ? "✖" : "⚠"} node-doctor/${d.diagnostic}  (${d.category})\n`);
      process.stdout.write(`  ${d.title}\n`);
      process.stdout.write(`  Why it fired here: ${d.message}\n`);
      process.stdout.write(`  Fix: ${d.recommendation}\n`);
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

export const main = async (argv: string[]): Promise<number> => {
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
    for (const e of args.errors) process.stderr.write(`node-doctor: ${e}\n`);
    process.stderr.write(`Run \`node-doctor --help\` for usage.\n`);
    return 2;
  }

  try {
    switch (args.command) {
      case "diagnostics":
        printDiagnostics();
        return 0;
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
      case "scan":
      default:
        return args.watch ? await runWatch(args, version) : await runScan(args, version);
    }
  } catch (err) {
    process.stderr.write(`node-doctor: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
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
