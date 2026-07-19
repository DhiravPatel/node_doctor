/**
 * The orchestrator: discover → select diagnostics → Phase A (per-file) → Phase B
 * (project) → assign ids → sort → score. Also the single-file `lintSource`
 * entry used by editors and unit tests.
 *
 * Invariants enforced here:
 *  - Diagnostic isolation: a diagnostic that throws in `create` or a visitor is skipped,
 *    never crashes the scan (§5.4).
 *  - Determinism: identical input → byte-identical output; findings sorted by
 *    severity, file, line, column, diagnostic id (§5.3).
 *  - Honest coverage: a parse failure is a gap, never a silent "clean" (§5.6).
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, sep, join } from "node:path";
import fg from "fast-glob";

import type { AstNode, Category, Finding, Diagnostic, DiagnosticContext, Severity } from "./types.ts";
import { PLUGIN } from "./types.ts";
import { parseSource } from "./parse.ts";
import { attachParents, walk } from "./walk.ts";
import { resolveScopes } from "./scope.ts";
import { computeTaint } from "./taint.ts";
import { collectRequestHandlers } from "./request-path.ts";
import { createLocator, type Locator } from "./location.ts";
import { discoverProject, shouldEnableDiagnostic, capabilitiesSatisfied } from "./project.ts";
import { loadConfig, BUILTIN_IGNORES, effectiveSetting, type NodeDoctorConfig } from "./config.ts";
import { parseDirectives, applySuppressions } from "./suppress.ts";
import { calculateScore, type ScoreResult } from "./score.ts";
import { collectModuleFacts, buildProjectGraph, type ModuleFacts } from "./graph.ts";
import { summarizeEffects } from "./effects.ts";
import {
  loadCache,
  saveCache,
  hashContent,
  computeProbe,
  CACHE_DIR_NAME,
  type CacheStore,
} from "./cache.ts";
import { DIAGNOSTICS } from "./registry.ts";

export const SCHEMA_VERSION = 2;

const SOURCE_GLOB = "**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}";

/** The synthetic finding raised for a suppression that lacks a reason. */
const SUPPRESSION_META = {
  ruleId: "suppression-without-reason",
  title: "Suppression comment without a reason",
  category: "Maintainability" as Category,
  severity: "warn" as Severity,
  recommendation:
    "Add a reason after `--`, e.g. `// node-doctor-disable-next-line <diagnostic> -- why this is safe`. A false positive is a bug in the diagnostic and should be reported, not silently suppressed.",
  message: "This node-doctor suppression has no reason — every suppression must justify itself.",
  tags: ["suppression"],
};

export interface ParseFailure {
  filePath: string;
  normalizedFilePath: string;
  message: string;
}

export interface ScanReport {
  schemaVersion: number;
  project: {
    name: string;
    rootDirectory: string;
    capabilities: string[];
    analyzedFileCount: number;
    totalLines: number;
    complete: boolean;
    parseFailures: ParseFailure[];
  };
  diagnosticsRun: number;
  diagnosticsAvailable: number;
  findings: Finding[];
  score: ScoreResult;
}

interface PendingFinding {
  ruleId: string;
  title: string;
  category: Category;
  severity: Severity;
  recommendation: string;
  tags: string[];
  filePath: string;
  normalizedFilePath: string;
  line: number;
  column: number;
  message: string;
}

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warn: 1 };

const normalizePath = (rootDirectory: string, filePath: string): string => {
  const rel = relative(rootDirectory, filePath) || filePath;
  return rel.split(sep).join("/");
};

const countLines = (text: string): number => (text.length === 0 ? 0 : text.split("\n").length);

/** Deterministic, stable finding id (§5.5). */
const makeId = (d: PendingFinding): string => {
  const hash = createHash("sha256")
    .update(`${d.normalizedFilePath}|${d.line}|${d.column}|${d.ruleId}|${d.message}`)
    .digest("hex")
    .slice(0, 8);
  return `${d.normalizedFilePath}::${d.line}:${d.column}::${PLUGIN}/${d.ruleId}::${hash}`;
};

const finalize = (p: PendingFinding): Finding => ({
  id: makeId(p),
  filePath: p.filePath,
  normalizedFilePath: p.normalizedFilePath,
  line: p.line,
  column: p.column,
  plugin: PLUGIN,
  diagnostic: p.ruleId,
  title: p.title,
  category: p.category,
  severity: p.severity,
  message: p.message,
  recommendation: p.recommendation,
  tags: p.tags,
});

/** The stable sort that makes output byte-identical across runs. */
export const sortFindings = (findings: Finding[]): Finding[] =>
  findings.slice().sort((a, b) => {
    const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (s !== 0) return s;
    if (a.normalizedFilePath !== b.normalizedFilePath) {
      return a.normalizedFilePath < b.normalizedFilePath ? -1 : 1;
    }
    if (a.line !== b.line) return a.line - b.line;
    if (a.column !== b.column) return a.column - b.column;
    if (a.diagnostic !== b.diagnostic) return a.diagnostic < b.diagnostic ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

interface AnalyzeOptions {
  filePath: string;
  normalizedFilePath: string;
  sourceText: string;
  diagnostics: Diagnostic[];
  capabilities: Set<string>;
  effectiveSeverity: Map<string, Severity>;
  runScope: "file" | "project";
  graph?: import("./graph.ts").ProjectGraph;
  onRuleError?: (ruleId: string, err: unknown) => void;
  /** Cache hit: parse for facts but reuse these pending findings (skip diagnostics). */
  cachedPending?: PendingFinding[];
}

interface AnalyzeResult {
  pending: PendingFinding[];
  moduleFacts: ModuleFacts;
  parseFailed: boolean;
  errors: string[];
  totalLines: number;
}

/** Parse one file, run the given diagnostics against it, apply inline suppressions. */
const analyzeFile = (opts: AnalyzeOptions): AnalyzeResult => {
  const { filePath, normalizedFilePath, sourceText, diagnostics, capabilities, effectiveSeverity } = opts;
  const parsed = parseSource(filePath, sourceText);
  const program = parsed.program;
  attachParents(program);
  const scope = resolveScopes(program);
  const tainted = computeTaint(program);
  const handlers = collectRequestHandlers(program, scope);

  // Cache hit: we still parse (the project graph needs the AST + facts), but the
  // file-scope diagnostic results are reused rather than recomputed.
  if (opts.cachedPending) {
    return {
      pending: opts.cachedPending,
      moduleFacts: collectModuleFacts(filePath, normalizedFilePath, program, scope, handlers),
      parseFailed: parsed.parseFailed,
      errors: parsed.errors,
      totalLines: countLines(sourceText),
    };
  }

  const locate: Locator = createLocator(sourceText);

  const pending: PendingFinding[] = [];
  const enterMap = new Map<string, Array<[string, (n: AstNode) => void]>>();
  const exitMap = new Map<string, Array<[string, (n: AstNode) => void]>>();

  const makeContext = (diagnostic: Diagnostic): DiagnosticContext => ({
    filePath,
    normalizedFilePath,
    sourceText,
    program,
    taintedBindings: tainted,
    capabilities,
    hasCapability: (token) => capabilities.has(token),
    scope,
    requestHandlers: handlers,
    runScope: opts.runScope,
    graph: opts.graph,
    effectsOf: opts.graph ? (fn) => opts.graph!.effectsOf(fn) : (fn) => summarizeEffects(fn),
    report: (node, message, overrides) => {
      const offset = typeof node?.start === "number" ? node.start : 0;
      const { line, column } = locate(offset);
      const severity = effectiveSeverity.get(diagnostic.id) ?? overrides?.severity ?? diagnostic.severity;
      const tags = (overrides?.tags ?? diagnostic.tags ?? []).slice().sort();
      pending.push({
        ruleId: diagnostic.id,
        title: diagnostic.title,
        category: diagnostic.category,
        severity,
        recommendation: overrides?.recommendation ?? diagnostic.recommendation,
        tags,
        filePath,
        normalizedFilePath,
        line,
        column,
        message: overrides?.message ?? message,
      });
    },
  });

  for (const diagnostic of diagnostics) {
    let visitors: Record<string, (n: AstNode) => void>;
    try {
      visitors = diagnostic.create(makeContext(diagnostic));
    } catch (err) {
      opts.onRuleError?.(diagnostic.id, err);
      continue;
    }
    for (const [key, fn] of Object.entries(visitors)) {
      if (typeof fn !== "function") continue;
      const isExit = key.endsWith(":exit");
      const type = isExit ? key.slice(0, -":exit".length) : key;
      const map = isExit ? exitMap : enterMap;
      const list = map.get(type) ?? [];
      list.push([diagnostic.id, fn]);
      map.set(type, list);
    }
  }

  const dispatch = (list: Array<[string, (n: AstNode) => void]> | undefined, node: AstNode): void => {
    if (!list) return;
    for (const [ruleId, fn] of list) {
      try {
        fn(node);
      } catch (err) {
        opts.onRuleError?.(ruleId, err);
      }
    }
  };

  walk(program, {
    enter: (node) => dispatch(enterMap.get(node.type), node),
    exit: (node) => dispatch(exitMap.get(node.type), node),
  });

  // Inline suppression (per file, using this file's comments). We track by index
  // so identical (diagnostic, line) findings are handled independently.
  const directives = parseDirectives(parsed.comments, locate);
  const wrapped = pending.map((p, index) => ({ diagnostic: p.ruleId, line: p.line, index }));
  const { kept, reasonMissing } = applySuppressions(wrapped, directives);
  const keptIndices = new Set(kept.map((k) => k.index));
  const finalPending: PendingFinding[] = pending.filter((_, i) => keptIndices.has(i));

  // Reason-less suppression meta-findings.
  for (const missing of reasonMissing) {
    finalPending.push({
      ruleId: SUPPRESSION_META.ruleId,
      title: SUPPRESSION_META.title,
      category: SUPPRESSION_META.category,
      severity: SUPPRESSION_META.severity,
      recommendation: SUPPRESSION_META.recommendation,
      tags: SUPPRESSION_META.tags.slice().sort(),
      filePath,
      normalizedFilePath,
      line: missing.line,
      column: missing.column,
      message: SUPPRESSION_META.message,
    });
  }

  const moduleFacts = collectModuleFacts(filePath, normalizedFilePath, program, scope, handlers);

  return {
    pending: finalPending,
    moduleFacts,
    parseFailed: parsed.parseFailed,
    errors: parsed.errors,
    totalLines: countLines(sourceText),
  };
};

// ---------------------------------------------------------------------------
// Public: lintSource (single source string, file-scope diagnostics)
// ---------------------------------------------------------------------------

export interface LintSourceOptions {
  filePath: string;
  sourceText: string;
  diagnostics?: Diagnostic[];
  capabilities?: Set<string>;
}

export interface LintSourceResult {
  findings: Finding[];
  parseFailed: boolean;
  errors: string[];
}

/** Lint a single source string with no filesystem access. */
export const lintSource = (options: LintSourceOptions): LintSourceResult => {
  const capabilities = options.capabilities ?? new Set(["node"]);
  const diagnostics = (options.diagnostics ?? DIAGNOSTICS).filter((r) => (r.scope ?? "file") === "file");
  const effectiveSeverity = new Map<string, Severity>();
  const normalizedFilePath = options.filePath.split(sep).join("/");

  const result = analyzeFile({
    filePath: options.filePath,
    normalizedFilePath,
    sourceText: options.sourceText,
    diagnostics,
    capabilities,
    effectiveSeverity,
    runScope: "file",
  });

  const findings = sortFindings(result.pending.map(finalize));
  return { findings, parseFailed: result.parseFailed, errors: result.errors };
};

// ---------------------------------------------------------------------------
// Public: scanProject (full directory scan)
// ---------------------------------------------------------------------------

export interface ScanProjectOptions {
  rootDirectory: string;
  /** Diagnostic families to skip (from `--ignore-tag`). */
  ignoredTags?: Set<string>;
  /** Explicit absolute file list (diff/staged mode) instead of globbing. */
  only?: string[];
  /** Pre-loaded config (else loaded from disk). */
  config?: NodeDoctorConfig;
  /** Explicit config file path. */
  configPath?: string;
  /** Collect diagnostic-execution errors here (verbose reporting). */
  onRuleError?: (ruleId: string, err: unknown) => void;
  /** Enable the content-hash cache (reuse unchanged files between runs). */
  cache?: boolean;
  /** Cache directory (default: `<root>/.node-doctor-cache`). */
  cacheDir?: string;
}

const selectDiagnostics = (
  capabilities: Set<string>,
  config: NodeDoctorConfig,
  ignoredTags: Set<string>,
): { diagnostics: Diagnostic[]; effectiveSeverity: Map<string, Severity> } => {
  const diagnostics: Diagnostic[] = [];
  const effectiveSeverity = new Map<string, Severity>();
  const allIgnoredTags = new Set([...(config.ignoreTags ?? []), ...ignoredTags]);

  for (const diagnostic of DIAGNOSTICS) {
    if (!capabilitiesSatisfied(diagnostic, capabilities)) continue;

    const setting = effectiveSetting(diagnostic.id, diagnostic.severity, config);
    if (setting === "off") continue;

    // Opt-in diagnostics run only when config explicitly enables them.
    if (diagnostic.defaultEnabled === false && !config.diagnostics?.[diagnostic.id]) continue;
    if (diagnostic.defaultEnabled !== false && !shouldEnableDiagnostic(diagnostic, capabilities) && !config.diagnostics?.[diagnostic.id]) {
      continue;
    }

    const tags = diagnostic.tags ?? [];
    if (tags.some((t) => allIgnoredTags.has(t))) continue;

    diagnostics.push(diagnostic);
    effectiveSeverity.set(diagnostic.id, setting === "warn" ? "warn" : "error");
  }
  return { diagnostics, effectiveSeverity };
};

/** Scan a directory. Returns the same report shape as `--json`. */
export const scanProject = async (options: ScanProjectOptions): Promise<ScanReport> => {
  const { rootDirectory } = options;
  const project = await discoverProject(rootDirectory);
  const config = options.config ?? (await loadConfig(rootDirectory, options.configPath));
  const ignoredTags = options.ignoredTags ?? new Set<string>();

  const { diagnostics, effectiveSeverity } = selectDiagnostics(project.capabilities, config, ignoredTags);
  const fileDiagnostics = diagnostics.filter((r) => (r.scope ?? "file") === "file");
  const projectDiagnostics = diagnostics.filter((r) => r.scope === "project");

  // Resolve the file set.
  let files: string[];
  if (options.only && options.only.length > 0) {
    files = options.only.slice().sort();
  } else {
    const found = await fg([SOURCE_GLOB], {
      cwd: rootDirectory,
      ignore: [...BUILTIN_IGNORES, ...(config.ignore ?? [])],
      absolute: true,
      dot: false,
      followSymbolicLinks: false,
      suppressErrors: true,
    });
    files = found.sort();
  }

  const pending: PendingFinding[] = [];
  const parseFailures: ParseFailure[] = [];
  const moduleFactsList: ModuleFacts[] = [];
  let totalLines = 0;
  let analyzedFileCount = 0;

  // Content-hash cache setup.
  const cacheDir = options.cacheDir ?? join(rootDirectory, CACHE_DIR_NAME);
  const cacheEnabled = options.cache === true;
  const cache: CacheStore = cacheEnabled ? await loadCache(cacheDir) : { version: 1, files: {} };
  const probe = cacheEnabled ? computeProbe(fileDiagnostics, effectiveSeverity, project.capabilities) : "";
  const needFacts = projectDiagnostics.length > 0;
  const nextCache: CacheStore = { version: 1, files: {} };

  const recordParseFailure = (filePath: string, normalizedFilePath: string, message: string): void => {
    parseFailures.push({ filePath, normalizedFilePath, message });
  };

  // Phase A — per-file.
  for (const filePath of files) {
    let sourceText: string;
    try {
      sourceText = await readFile(filePath, "utf8");
    } catch (err) {
      recordParseFailure(
        filePath,
        normalizePath(rootDirectory, filePath),
        err instanceof Error ? err.message : "unreadable file",
      );
      continue;
    }
    const normalizedFilePath = normalizePath(rootDirectory, filePath);

    const hash = cacheEnabled ? hashContent(sourceText) : "";
    const hit = cacheEnabled ? cache.files[normalizedFilePath] : undefined;
    const isHit = !!hit && hit.hash === hash && hit.probe === probe;

    // Fast path: cache hit and no project pass needed — skip parsing entirely.
    if (isHit && !needFacts) {
      analyzedFileCount += 1;
      totalLines += hit!.totalLines;
      pending.push(...(hit!.pending as PendingFinding[]));
      if (hit!.parseFailed) recordParseFailure(filePath, normalizedFilePath, hit!.errors[0] ?? "parse error");
      nextCache.files[normalizedFilePath] = hit!;
      continue;
    }

    const result = analyzeFile({
      filePath,
      normalizedFilePath,
      sourceText,
      diagnostics: fileDiagnostics,
      capabilities: project.capabilities,
      effectiveSeverity,
      runScope: "file",
      onRuleError: options.onRuleError,
      // Cache hit but the project pass needs the AST: reuse diagnostic results, still parse.
      cachedPending: isHit ? (hit!.pending as PendingFinding[]) : undefined,
    });

    analyzedFileCount += 1;
    totalLines += result.totalLines;
    pending.push(...result.pending);
    moduleFactsList.push(result.moduleFacts);
    if (result.parseFailed) {
      recordParseFailure(filePath, normalizedFilePath, result.errors[0] ?? "parse error");
    }
    if (cacheEnabled) {
      nextCache.files[normalizedFilePath] = {
        hash,
        probe,
        pending: result.pending,
        totalLines: result.totalLines,
        parseFailed: result.parseFailed,
        errors: result.errors,
      };
    }
  }

  if (cacheEnabled) await saveCache(cacheDir, nextCache);

  // Phase B — project pass (only if project-scope diagnostics are active).
  if (projectDiagnostics.length > 0) {
    const graph = buildProjectGraph(moduleFactsList);
    for (const facts of moduleFactsList) {
      let sourceText: string;
      try {
        sourceText = await readFile(facts.filePath, "utf8");
      } catch {
        continue;
      }
      const result = analyzeFile({
        filePath: facts.filePath,
        normalizedFilePath: facts.normalizedFilePath,
        sourceText,
        diagnostics: projectDiagnostics,
        capabilities: project.capabilities,
        effectiveSeverity,
        runScope: "project",
        graph,
        onRuleError: options.onRuleError,
      });
      pending.push(...result.pending);
    }
  }

  const findings = sortFindings(pending.map(finalize));
  const score = calculateScore(findings, { totalLines });

  return {
    schemaVersion: SCHEMA_VERSION,
    project: {
      name: project.name,
      rootDirectory,
      capabilities: [...project.capabilities].sort(),
      analyzedFileCount,
      totalLines,
      complete: parseFailures.length === 0,
      parseFailures: parseFailures.sort((a, b) =>
        a.normalizedFilePath < b.normalizedFilePath ? -1 : a.normalizedFilePath > b.normalizedFilePath ? 1 : 0,
      ),
    },
    diagnosticsRun: diagnostics.length,
    diagnosticsAvailable: DIAGNOSTICS.length,
    findings,
    score,
  };
};
