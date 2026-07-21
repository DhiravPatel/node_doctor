/**
 * The diagnostic contract and shared vocabulary for node.doctor.
 *
 * A diagnostic is a plain, host-agnostic object: it never touches the filesystem and
 * never knows which host runs it. That purity keeps an ESLint adapter or a
 * future oxlint-plugin host cheap to add.
 */

import type { ScopeResolver } from "./scope.ts";
import type { ProjectGraph } from "./graph.ts";
import type { EffectSummary } from "./effects.ts";

/** The plugin namespace prepended to every diagnostic id in output (`node-doctor/<id>`). */
export const PLUGIN = "node-doctor";

export type Category =
  | "Security"
  | "Reliability"
  | "Bugs"
  | "Performance"
  | "Maintainability";

export type Severity = "error" | "warn";

export type Scope = "file" | "project";

/**
 * How certain the analyzer is that a finding is a real defect — the signal an
 * agent uses to decide between auto-fixing and escalating to a human (§54/§101).
 *
 * - `high`   — an unambiguous shape or a proven taint path. Safe to act on.
 * - `medium` — a strong heuristic (receiver names, structural patterns). Review.
 * - `low`    — a threshold/style judgement. Advisory only; never auto-fix.
 */
export type Confidence = "high" | "medium" | "low";

export const CONFIDENCES: readonly Confidence[] = ["high", "medium", "low"];

/**
 * The five categories in a fixed order used for deterministic grouping and as
 * the authoritative list for scoring.
 */
export const CATEGORIES: readonly Category[] = [
  "Security",
  "Reliability",
  "Bugs",
  "Performance",
  "Maintainability",
];

export const SEVERITIES: readonly Severity[] = ["error", "warn"];

/**
 * A permissive AST node. oxc emits standard ESTree with `start`/`end` character
 * offsets (no `loc`), and we attach a `parent` back-link during the walk. Rules
 * access node-type-specific fields through the index signature — the AST is
 * inherently dynamic and fighting the type system over it buys nothing.
 */
export interface AstNode {
  type: string;
  start: number;
  end: number;
  parent?: AstNode | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/** A single finding, as emitted in the JSON report. */
export interface Finding {
  /** Deterministic, stable id (hash of location + diagnostic + message). */
  id: string;
  /** Absolute path of the file. */
  filePath: string;
  /** Repo-relative, forward-slash path (cross-OS). */
  normalizedFilePath: string;
  line: number;
  column: number;
  plugin: string;
  diagnostic: string;
  title: string;
  category: Category;
  severity: Severity;
  message: string;
  recommendation: string;
  /** Sorted family tags. */
  tags: string[];
  /** How certain the analyzer is — drives agent auto-fix vs. escalate (§54). */
  confidence: Confidence;
  /** A corrective hint when a nearby disable comment almost matched (near-miss). */
  suppressionHint?: string;
  /**
   * Position-independent identity (diagnostic + message + triggering code),
   * used by the baseline delta so a line shift or file move doesn't read as a
   * new finding. The positional `id` remains the display/dedupe key.
   */
  evidenceKey?: string;
}

/** Per-finding sharpening a diagnostic may apply at report time. */
export interface ReportOverrides {
  severity?: Severity;
  recommendation?: string;
  tags?: string[];
  /** Sharpen the message without changing diagnostic identity semantics. */
  message?: string;
}

/**
 * Everything a diagnostic's visitors receive. Project-scope diagnostics additionally get
 * `graph` and `effectsOf`.
 */
export interface DiagnosticContext {
  /** Record a finding anchored at `node`. */
  report(node: AstNode, message: string, overrides?: ReportOverrides): void;
  /** Absolute path of the file being linted. */
  filePath: string;
  /** Repo-relative, forward-slash path. */
  normalizedFilePath: string;
  /** The raw source. */
  sourceText: string;
  /** The parsed ESTree Program root. */
  program: AstNode;
  /** Caller-controlled binding names (intra-file taint). */
  taintedBindings: Set<string>;
  /** All active capability tokens. */
  capabilities: Set<string>;
  /** Query a capability token. */
  hasCapability(token: string): boolean;
  /** The scope/binding resolver for this file. */
  scope: ScopeResolver;
  /** Function nodes that run in request context (computed once per file). */
  requestHandlers: Set<AstNode>;
  /** Which pass is running. */
  runScope: Scope;
  /** Project graph — present only for project-scope diagnostics in Phase B. */
  graph?: ProjectGraph;
  /** Effect summary lookup — present only for project-scope diagnostics in Phase B. */
  effectsOf?: (fn: AstNode) => EffectSummary;
}

/** A diagnostic visitor map: ESTree node type (optionally `:exit`) → handler. */
export type Visitors = Record<string, (node: AstNode) => void>;

export interface Diagnostic {
  /** Unique id → surfaced as `node-doctor/<id>`. */
  id: string;
  /** Headline, no trailing period. */
  title: string;
  severity: Severity;
  category: Category;
  /** Default "file". "project" diagnostics run in Phase B. */
  scope?: Scope;
  /** ALL of these capability tokens must be present for the diagnostic to run. */
  requires?: string[];
  /** ANY of these present disables the diagnostic. */
  disabledWhen?: string[];
  /** Families for `--ignore-tag`. */
  tags?: string[];
  /** false → opt-in only. Default true. */
  defaultEnabled?: boolean;
  /**
   * How certain this diagnostic is when it fires. Omit to take the derived
   * default (see `confidenceOf`): opt-in/threshold → low, warn → medium,
   * error → high. Declare it explicitly to correct a weaker heuristic.
   */
  confidence?: Confidence;
  /** The fix, naming the mechanism. */
  recommendation: string;
  /** Build the visitor map for one file. */
  create(ctx: DiagnosticContext): Visitors;
}

/**
 * The effective confidence for a diagnostic. The default is principled and
 * explainable rather than hand-tuned per rule: a threshold/style judgement is
 * advisory (`low`), a warning is a strong heuristic (`medium`), and an error
 * fires only on an unambiguous shape or proven taint (`high`).
 */
export const confidenceOf = (d: {
  confidence?: Confidence;
  severity: Severity;
  defaultEnabled?: boolean;
}): Confidence => {
  if (d.confidence) return d.confidence;
  if (d.defaultEnabled === false) return "low";
  return d.severity === "error" ? "high" : "medium";
};

/**
 * Identity function that validates a diagnostic's shape at module load. The returned
 * value *is* the contract — no wrapping, no hot-path cost.
 */
export const defineDiagnostic = (diagnostic: Diagnostic): Diagnostic => {
  if (!diagnostic || typeof diagnostic !== "object") {
    throw new TypeError("defineDiagnostic: expected a diagnostic object");
  }
  if (typeof diagnostic.id !== "string" || diagnostic.id.length === 0) {
    throw new TypeError("defineDiagnostic: diagnostic.id must be a non-empty string");
  }
  if (typeof diagnostic.title !== "string" || diagnostic.title.length === 0) {
    throw new TypeError(`defineDiagnostic(${diagnostic.id}): title is required`);
  }
  if (!SEVERITIES.includes(diagnostic.severity)) {
    throw new TypeError(`defineDiagnostic(${diagnostic.id}): severity must be "error" | "warn"`);
  }
  if (!CATEGORIES.includes(diagnostic.category)) {
    throw new TypeError(`defineDiagnostic(${diagnostic.id}): unknown category ${JSON.stringify(diagnostic.category)}`);
  }
  if (diagnostic.scope !== undefined && diagnostic.scope !== "file" && diagnostic.scope !== "project") {
    throw new TypeError(`defineDiagnostic(${diagnostic.id}): scope must be "file" | "project"`);
  }
  if (typeof diagnostic.recommendation !== "string" || diagnostic.recommendation.length === 0) {
    throw new TypeError(`defineDiagnostic(${diagnostic.id}): recommendation is required and must name the fix`);
  }
  if (typeof diagnostic.create !== "function") {
    throw new TypeError(`defineDiagnostic(${diagnostic.id}): create must be a function returning visitors`);
  }
  return diagnostic;
};
