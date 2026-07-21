/**
 * Whole-tree text scan (Phase C): a second file walk over NON-source files —
 * `.env*`, `*.pem`/`*.key`, YAML/CI configs, Dockerfiles, `*.tfvars`, lockfiles —
 * for committed secrets and misconfigurations that never appear in the ESTree
 * AST. Findings flow through the same `Finding` pipeline and reporters.
 *
 * Two guards keep it precise and cheap: a per-bucket **size cap** (a secret is
 * never in an 8 MB blob) and a **committed-files-only** gate for leaked key
 * material, so a gitignored local `.env` is never flagged.
 */

import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fg from "fast-glob";
import { PLUGIN, confidenceOf, type Category, type Severity, type Finding, type Confidence } from "./types.ts";
import { BUILTIN_IGNORES, effectiveSetting, settingsForFile, globToRegExp, type NodeDoctorConfig } from "./config.ts";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_BYTES = 512 * 1024;

export interface TextScanContext {
  filePath: string;
  normalizedFilePath: string;
  content: string;
  /** Is this file git-tracked? */
  committed: boolean;
  report(finding: { line: number; column?: number; message: string; recommendation?: string }): void;
}

export interface TextDiagnostic {
  id: string;
  title: string;
  severity: Severity;
  category: Category;
  tags?: string[];
  requires?: string[];
  disabledWhen?: string[];
  /** false → opt-in only. Default true. */
  defaultEnabled?: boolean;
  /** How certain this diagnostic is (see `confidenceOf` for the default). */
  confidence?: Confidence;
  recommendation: string;
  /** Glob patterns (relative to root) selecting candidate files. */
  files: string[];
  /** Skip files larger than this many bytes (default 512 KiB). */
  maxBytes?: number;
  /** Only scan git-tracked files (leaked-secret gate). */
  committedFilesOnly?: boolean;
  scan(ctx: TextScanContext): void;
}

/** Identity function that validates a text diagnostic's shape at load. */
export const defineTextDiagnostic = (d: TextDiagnostic): TextDiagnostic => {
  if (!d || typeof d.id !== "string" || typeof d.scan !== "function" || !Array.isArray(d.files)) {
    throw new TypeError("defineTextDiagnostic: expected { id, files, scan, … }");
  }
  return d;
};

const makeId = (normalizedFilePath: string, line: number, column: number, ruleId: string, message: string): string => {
  const hash = createHash("sha256")
    .update(`${normalizedFilePath}|${line}|${column}|${ruleId}|${message}`)
    .digest("hex")
    .slice(0, 8);
  return `${normalizedFilePath}::${line}:${column}::${PLUGIN}/${ruleId}::${hash}`;
};

/** git-tracked files as normalized relative paths (empty when not a git repo). */
const trackedFiles = async (rootDirectory: string): Promise<Set<string>> => {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files"], {
      cwd: rootDirectory,
      maxBuffer: 64 * 1024 * 1024,
    });
    // git prints forward-slash paths, one per line (rare newline-in-name is quoted).
    return new Set(
      stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('"')),
    );
  } catch {
    return new Set();
  }
};

const capabilityOk = (d: TextDiagnostic, capabilities: Set<string>): boolean => {
  if (d.requires && !d.requires.every((r) => capabilities.has(r))) return false;
  if (d.disabledWhen && d.disabledWhen.some((t) => capabilities.has(t))) return false;
  return true;
};

export interface RunTextScanOptions {
  textDiagnostics: TextDiagnostic[];
  config?: NodeDoctorConfig;
  ignoredTags?: Set<string>;
  capabilities?: Set<string>;
  deadlineEpochMs?: number;
}

/** The active text diagnostics after config + capability + tag gating. */
export const selectTextDiagnostics = (
  all: TextDiagnostic[],
  config: NodeDoctorConfig,
  ignoredTags: Set<string>,
  capabilities: Set<string>,
): TextDiagnostic[] => {
  const allIgnored = new Set([...(config.ignoreTags ?? []), ...ignoredTags]);
  return all.filter((d) => {
    if (effectiveSetting(d.id, d.severity, config) === "off") return false;
    if (d.defaultEnabled === false && !config.diagnostics?.[d.id]) return false;
    if (!capabilityOk(d, capabilities)) return false;
    if ((d.tags ?? []).some((t) => allIgnored.has(t))) return false;
    return true;
  });
};

/** Run the text scan over `rootDirectory`, returning findings (unsorted). */
export const runTextScan = async (rootDirectory: string, options: RunTextScanOptions): Promise<Finding[]> => {
  const config = options.config ?? {};
  const ignoredTags = options.ignoredTags ?? new Set<string>();
  const capabilities = options.capabilities ?? new Set(["node"]);

  const enabled = selectTextDiagnostics(options.textDiagnostics, config, ignoredTags, capabilities);
  if (enabled.length === 0) return [];

  // Precompile each diagnostic's file matchers.
  const matchers = enabled.map((d) => ({ d, res: d.files.map((g) => globToRegExp(g)) }));

  const patterns = [...new Set(enabled.flatMap((d) => d.files))];
  const matches = await fg(patterns, {
    cwd: rootDirectory,
    absolute: true,
    dot: true,
    ignore: [...BUILTIN_IGNORES],
    onlyFiles: true,
    suppressErrors: true,
    followSymbolicLinks: false,
  });

  const needTracked = enabled.some((d) => d.committedFilesOnly);
  const tracked = needTracked ? await trackedFiles(rootDirectory) : new Set<string>();

  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const filePath of matches.sort()) {
    if (options.deadlineEpochMs !== undefined && Date.now() > options.deadlineEpochMs) break;
    const normalizedFilePath = relative(rootDirectory, filePath).split(sep).join("/");
    const committed = tracked.has(normalizedFilePath);

    const applicable = matchers.filter(
      ({ d, res }) => res.some((re) => re.test(normalizedFilePath)) && (!d.committedFilesOnly || committed),
    );
    if (applicable.length === 0) continue;

    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      continue;
    }
    const byteLength = Buffer.byteLength(content);
    const perFile = settingsForFile(config, normalizedFilePath);
    const contentLines = content.split("\n");

    for (const { d } of applicable) {
      if (byteLength > (d.maxBytes ?? DEFAULT_MAX_BYTES)) continue;
      const setting = perFile[d.id] ?? effectiveSetting(d.id, d.severity, config);
      if (setting === "off") continue;

      const ctx: TextScanContext = {
        filePath,
        normalizedFilePath,
        content,
        committed,
        report: ({ line, column = 1, message, recommendation }) => {
          const id = makeId(normalizedFilePath, line, column, d.id, message);
          if (seen.has(id)) return;
          seen.add(id);
          const evidenceText = (contentLines[line - 1] ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
          findings.push({
            id,
            filePath,
            normalizedFilePath,
            line,
            column,
            plugin: PLUGIN,
            diagnostic: d.id,
            title: d.title,
            category: d.category,
            severity: setting === "warn" ? "warn" : "error",
            message,
            recommendation: recommendation ?? d.recommendation,
            tags: (d.tags ?? []).slice().sort(),
            confidence: confidenceOf(d),
            evidenceKey: createHash("sha256").update(`${d.id} ${message} ${evidenceText}`).digest("hex").slice(0, 16),
          });
        },
      };
      try {
        d.scan(ctx);
      } catch {
        /* isolate a throwing text diagnostic */
      }
    }
  }
  return findings;
};
