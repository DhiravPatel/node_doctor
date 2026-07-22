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
import { cpus } from "node:os";
import fg from "fast-glob";

import type { AstNode, Category, Finding, Diagnostic, DiagnosticContext, Severity, Confidence } from "./types.ts";
import { PLUGIN, confidenceOf } from "./types.ts";
import { parseSource } from "./parse.ts";
import { attachParents, walk } from "./walk.ts";
import { resolveScopes } from "./scope.ts";
import { computeTaint } from "./taint.ts";
import { collectRequestHandlers } from "./request-path.ts";
import { createLocator, type Locator } from "./location.ts";
import { discoverProject, shouldEnableDiagnostic, capabilitiesSatisfied } from "./project.ts";
import { loadConfig, BUILTIN_IGNORES, effectiveSetting, settingsForFile, type NodeDoctorConfig } from "./config.ts";
import { classifyFileContext, isRelaxedInContext } from "./file-context.ts";
import { runTextScan, selectTextDiagnostics } from "./text-scan.ts";
import { TEXT_DIAGNOSTICS } from "../diagnostics/secrets/index.ts";
import { IAC_DIAGNOSTICS } from "../diagnostics/iac/index.ts";
import { parseDirectives, applySuppressions, suppressionNearMiss } from "./suppress.ts";
import { calculateScore, type ScoreResult } from "./score.ts";
import { collectModuleFacts, buildProjectGraph, type ModuleFacts, type WorkspacePackages } from "./graph.ts";
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
import { toolVersion } from "./version.ts";

/** Every text-scan diagnostic: committed secrets + infrastructure config. */
const ALL_TEXT_DIAGNOSTICS = [...TEXT_DIAGNOSTICS, ...IAC_DIAGNOSTICS];

export const SCHEMA_VERSION = 2;

/** JSON with deterministic key order — so a config hash is stable across runs. */
const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
};

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

/**
 * Provenance (§104): everything that determines a scan's output, so "why did
 * this pass yesterday and fail today" is answerable from the artifact alone.
 * Two reports with identical provenance and identical sources are byte-identical.
 */
export interface Provenance {
  /** node.doctor version that produced the report. */
  toolVersion: string;
  /** Hash of the active diagnostic set (ids + effective severities). */
  rulesetHash: string;
  /** Hash of the resolved configuration. */
  configHash: string;
  /** Sorted capability tokens that gated the run. */
  capabilities: string[];
}

export interface ScanReport {
  schemaVersion: number;
  provenance: Provenance;
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
  confidence: Confidence;
  suppressionHint?: string;
  /** Normalized source text of the triggering node — the delta evidence. */
  evidenceText?: string;
}

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warn: 1 };

const normalizePath = (rootDirectory: string, filePath: string): string => {
  const rel = relative(rootDirectory, filePath) || filePath;
  return rel.split(sep).join("/");
};

const countLines = (text: string): number => (text.length === 0 ? 0 : text.split("\n").length);

/** Deterministic, stable finding id (§5.5) — positional, used for display + dedupe. */
const makeId = (d: PendingFinding): string => {
  const hash = createHash("sha256")
    .update(`${d.normalizedFilePath}|${d.line}|${d.column}|${d.ruleId}|${d.message}`)
    .digest("hex")
    .slice(0, 8);
  return `${d.normalizedFilePath}::${d.line}:${d.column}::${PLUGIN}/${d.ruleId}::${hash}`;
};

/**
 * Length-prefixed join: unambiguous without a control-character separator, so
 * no field can forge a boundary and the source stays plain text.
 */
const evidenceInput = (ruleId: string, message: string, evidenceText: string): string =>
  `${ruleId.length}:${ruleId}|${message.length}:${message}|${evidenceText.length}:${evidenceText}`;

/**
 * A position-independent identity for a finding: the diagnostic + message +
 * the code that triggered it, normalized. Two scans agree on this key even when
 * the code moved to a different line or file — so a baseline delta reports only
 * findings the change truly *introduced*, not ones a line shift renumbered.
 */
export const makeEvidenceKey = (ruleId: string, message: string, evidenceText: string): string =>
  createHash("sha256").update(evidenceInput(ruleId, message, evidenceText)).digest("hex").slice(0, 16);

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
  confidence: p.confidence,
  evidenceKey: makeEvidenceKey(p.ruleId, p.message, p.evidenceText ?? ""),
  ...(p.suppressionHint ? { suppressionHint: p.suppressionHint } : {}),
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
  /** When false, inline disable directives are ignored (audit mode). */
  respectInlineDisables?: boolean;
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
      const end = typeof node?.end === "number" ? node.end : offset;
      const { line, column } = locate(offset);
      const severity = effectiveSeverity.get(diagnostic.id) ?? overrides?.severity ?? diagnostic.severity;
      const tags = (overrides?.tags ?? diagnostic.tags ?? []).slice().sort();
      // The triggering code, normalized — position-independent delta evidence.
      const evidenceText = sourceText.slice(offset, end).replace(/\s+/g, " ").trim().slice(0, 200);
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
        // Derived from the diagnostic itself, not the config-overridden severity:
        // downgrading a severity doesn't make the analyzer less certain.
        confidence: confidenceOf(diagnostic),
        evidenceText,
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
  //
  // Audit mode (respectInlineDisables === false) ignores all disable directives
  // so suppressed issues surface — nothing is filtered out and no reason-less
  // meta-finding is raised.
  let finalPending: PendingFinding[];
  if (opts.respectInlineDisables === false) {
    finalPending = pending.slice();
  } else {
    const directives = parseDirectives(parsed.comments, locate);
    const wrapped = pending.map((p, index) => ({ diagnostic: p.ruleId, line: p.line, index }));
    const { kept, reasonMissing } = applySuppressions(wrapped, directives);
    const keptIndices = new Set(kept.map((k) => k.index));
    finalPending = pending.filter((_, i) => keptIndices.has(i));

    // Near-miss hints: a finding that fired despite an almost-right disable comment.
    if (directives.length > 0) {
      for (const p of finalPending) {
        const hint = suppressionNearMiss({ diagnostic: p.ruleId, line: p.line }, directives);
        if (hint) p.suppressionHint = hint;
      }
    }

    // Reason-less suppression meta-findings.
    for (const missing of reasonMissing) {
      finalPending.push({
        confidence: "high" as Confidence, // a reason-less directive is a fact, not a heuristic
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
  }

  const moduleFacts = collectModuleFacts(filePath, normalizedFilePath, program, scope, handlers);

  // Auto-relax: drop diagnostics that are noise in this file's role (e.g. a
  // stray console.log is fine in a test or CLI script).
  const context = classifyFileContext(normalizedFilePath, sourceText);
  const relaxedPending =
    context === "source" ? finalPending : finalPending.filter((p) => !isRelaxedInContext(p.ruleId, context));

  return {
    pending: relaxedPending,
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
  /** When false, inline disable directives are ignored (audit mode). */
  respectInlineDisables?: boolean;
  /**
   * Absolute wall-clock deadline (epoch ms). Files not yet analyzed when the
   * deadline passes are skipped; the report is marked `complete: false`. Files
   * are processed in sorted order so truncation is deterministic.
   */
  deadlineEpochMs?: number;
  /** Analyze files with a bounded concurrency pool (default true). */
  parallel?: boolean;
  /** Run the whole-tree secret/config-file text scan (default true). */
  secrets?: boolean;
  /**
   * Workspace member name → source root (§96). With this set, a bare import of a
   * sibling package resolves into the graph instead of dead-ending.
   */
  workspacePackages?: WorkspacePackages;
  /**
   * Module facts from sibling workspace packages. They join the Phase B graph so
   * reachability can cross a package boundary, but they are never analyzed here —
   * findings stay attributed to files inside this project.
   */
  externalModuleFacts?: ModuleFacts[];
  /** Receives this project's Phase A module facts (the workspace scanner reuses them). */
  onModuleFacts?: (facts: ModuleFacts[]) => void;
}

/** Pool size: 1 when parallel is off, else CPU count (or NODE_DOCTOR_CONCURRENCY), capped by file count. */
const resolveConcurrency = (parallel: boolean | undefined, fileCount: number): number => {
  if (parallel === false) return 1;
  const envRaw = Number(process.env.NODE_DOCTOR_CONCURRENCY);
  const fromEnv = Number.isInteger(envRaw) && envRaw > 0 ? envRaw : undefined;
  const cpu = Math.max(1, cpus().length || 4);
  return Math.max(1, Math.min(fromEnv ?? cpu, Math.max(1, fileCount)));
};

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
    // A per-path override can re-enable a globally-off diagnostic for some files.
    const overrideEnables = (config.overrides ?? []).some((o) => {
      const s = o.diagnostics[diagnostic.id];
      return s === "warn" || s === "error";
    });
    if (setting === "off" && !overrideEnables) continue;

    const explicitlyConfigured = !!config.diagnostics?.[diagnostic.id] || overrideEnables;
    // Opt-in diagnostics run only when config (or an override) explicitly enables them.
    if (diagnostic.defaultEnabled === false && !explicitlyConfigured) continue;
    if (diagnostic.defaultEnabled !== false && !shouldEnableDiagnostic(diagnostic, capabilities) && !explicitlyConfigured) {
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
  // The workspace pass needs this project's facts even when this project runs no
  // project-scope diagnostic of its own — a cache hit must not swallow them.
  const needFacts = projectDiagnostics.length > 0 || options.onModuleFacts !== undefined;
  const nextCache: CacheStore = { version: 1, files: {} };

  const recordParseFailure = (filePath: string, normalizedFilePath: string, message: string): void => {
    parseFailures.push({ filePath, normalizedFilePath, message });
  };

  const deadline = options.deadlineEpochMs;
  let timedOut = false;

  interface FileResult {
    filePath: string;
    normalizedFilePath: string;
    pending: PendingFinding[];
    moduleFacts?: ModuleFacts;
    parseFailureMessage?: string;
    totalLines: number;
    cacheEntry?: CacheStore["files"][string];
  }

  // Analyze one file → a self-contained result (no shared-state mutation), so the
  // pool can run reads concurrently and we fan results in deterministically.
  const processFile = async (filePath: string): Promise<FileResult> => {
    const normalizedFilePath = normalizePath(rootDirectory, filePath);
    let sourceText: string;
    try {
      sourceText = await readFile(filePath, "utf8");
    } catch (err) {
      return {
        filePath,
        normalizedFilePath,
        pending: [],
        totalLines: 0,
        parseFailureMessage: err instanceof Error ? err.message : "unreadable file",
      };
    }

    const hash = cacheEnabled ? hashContent(sourceText) : "";
    const hit = cacheEnabled ? cache.files[normalizedFilePath] : undefined;
    const isHit = !!hit && hit.hash === hash && hit.probe === probe;

    // Fast path: cache hit and no project pass needed — skip parsing entirely.
    if (isHit && !needFacts) {
      return {
        filePath,
        normalizedFilePath,
        pending: hit!.pending as PendingFinding[],
        totalLines: hit!.totalLines,
        parseFailureMessage: hit!.parseFailed ? (hit!.errors[0] ?? "parse error") : undefined,
        cacheEntry: hit!,
      };
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
      respectInlineDisables: options.respectInlineDisables,
      // Cache hit but the project pass needs the AST: reuse diagnostic results, still parse.
      cachedPending: isHit ? (hit!.pending as PendingFinding[]) : undefined,
    });

    return {
      filePath,
      normalizedFilePath,
      pending: result.pending,
      moduleFacts: result.moduleFacts,
      totalLines: result.totalLines,
      parseFailureMessage: result.parseFailed ? (result.errors[0] ?? "parse error") : undefined,
      cacheEntry: cacheEnabled
        ? {
            hash,
            probe,
            pending: result.pending,
            totalLines: result.totalLines,
            parseFailed: result.parseFailed,
            errors: result.errors,
          }
        : undefined,
    };
  };

  // Phase A — bounded-concurrency pool over the sorted file list. Reads overlap;
  // the deadline stops scheduling new files (files complete in flight).
  const results: (FileResult | null)[] = new Array(files.length).fill(null);
  const concurrency = resolveConcurrency(options.parallel, files.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (deadline !== undefined && Date.now() > deadline) {
        timedOut = true;
        return;
      }
      const i = cursor++;
      if (i >= files.length) return;
      results[i] = await processFile(files[i]!);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // Deterministic fan-in in sorted file order.
  for (const r of results) {
    if (!r) continue;
    analyzedFileCount += 1;
    totalLines += r.totalLines;
    pending.push(...r.pending);
    if (r.moduleFacts) moduleFactsList.push(r.moduleFacts);
    if (r.parseFailureMessage !== undefined) {
      recordParseFailure(r.filePath, r.normalizedFilePath, r.parseFailureMessage);
    }
    if (cacheEnabled && r.cacheEntry) nextCache.files[r.normalizedFilePath] = r.cacheEntry;
  }

  if (cacheEnabled) await saveCache(cacheDir, nextCache);
  options.onModuleFacts?.(moduleFactsList);

  // Phase B — project pass (only if project-scope diagnostics are active).
  if (projectDiagnostics.length > 0) {
    const external = options.externalModuleFacts ?? [];
    const graph = buildProjectGraph(
      external.length > 0 ? [...moduleFactsList, ...external] : moduleFactsList,
      options.workspacePackages,
    );
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
        respectInlineDisables: options.respectInlineDisables,
      });
      pending.push(...result.pending);
    }
  }

  // Per-path overrides: re-severity or drop findings for files matching an
  // `overrides[].files` glob. Applied as a post-pass so it re-severities or
  // silences diagnostics that already ran (it cannot enable a globally-off one).
  let effectivePending = pending;
  if ((config.overrides?.length ?? 0) > 0) {
    const perFile = new Map<string, ReturnType<typeof settingsForFile>>();
    effectivePending = [];
    for (const p of pending) {
      let settings = perFile.get(p.normalizedFilePath);
      if (!settings) {
        settings = settingsForFile(config, p.normalizedFilePath);
        perFile.set(p.normalizedFilePath, settings);
      }
      const s = settings[p.ruleId];
      if (s === "off") continue;
      effectivePending.push(s === "warn" || s === "error" ? { ...p, severity: s } : p);
    }
  }

  const astFindings = effectivePending.map(finalize);

  // Phase C — whole-tree text scan (secrets in .env / config / CI files).
  let textFindings: Finding[] = [];
  const activeText =
    options.secrets === false
      ? []
      : selectTextDiagnostics(ALL_TEXT_DIAGNOSTICS, config, ignoredTags, project.capabilities);
  const textDiagnosticsRun = activeText.length;
  {
    if (activeText.length > 0) {
      textFindings = await runTextScan(rootDirectory, {
        textDiagnostics: activeText,
        config,
        ignoredTags,
        capabilities: project.capabilities,
        deadlineEpochMs: options.deadlineEpochMs,
      });
    }
  }

  // Provenance (§104): the inputs that determine this output.
  const rulesetHash = createHash("sha256")
    .update(
      [
        ...diagnostics.map((d) => `${d.id}:${effectiveSeverity.get(d.id) ?? d.severity}`),
        ...activeText.map((d) => `${d.id}:${effectiveSeverity.get(d.id) ?? d.severity}`),
      ]
        .sort()
        .join("\n"),
    )
    .digest("hex")
    .slice(0, 16);
  const configHash = createHash("sha256").update(stableStringify(config)).digest("hex").slice(0, 16);
  const provenance: Provenance = {
    toolVersion: toolVersion(),
    rulesetHash,
    configHash,
    capabilities: [...project.capabilities].sort(),
  };

  const findings = sortFindings([...astFindings, ...textFindings]);
  const score = calculateScore(findings, { totalLines });

  return {
    schemaVersion: SCHEMA_VERSION,
    provenance,
    project: {
      name: project.name,
      rootDirectory,
      capabilities: [...project.capabilities].sort(),
      analyzedFileCount,
      totalLines,
      complete: parseFailures.length === 0 && !timedOut,
      parseFailures: parseFailures.sort((a, b) =>
        a.normalizedFilePath < b.normalizedFilePath ? -1 : a.normalizedFilePath > b.normalizedFilePath ? 1 : 0,
      ),
    },
    diagnosticsRun: diagnostics.length + textDiagnosticsRun,
    diagnosticsAvailable: DIAGNOSTICS.length + ALL_TEXT_DIAGNOSTICS.length,
    findings,
    score,
  };
};
