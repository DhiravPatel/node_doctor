/**
 * The diagnostic contract and shared vocabulary for node.doctor.
 *
 * A diagnostic is a plain, host-agnostic object: it never touches the filesystem and
 * never knows which host runs it. That purity keeps an ESLint adapter or a
 * future oxlint-plugin host cheap to add.
 */

import type { ScopeResolver } from "./scope.ts";
import type { TypeSource } from "./type-source.ts";
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
 * The intra-file taint answer, keyed by BINDING rather than by name.
 *
 * `hasRef` is the real question — "is this identifier REFERENCE a read of
 * caller-controlled data?" — and it resolves the name to its binding before
 * answering, so a `state` local in one handler cannot borrow taint from a
 * `state` destructured from `request.query` in another. `has` is the older,
 * name-only query, kept only for the one consumer that follows it with its own
 * binding-level confirmation.
 */
export interface TaintLookup {
  /** Loose name-only membership. Prefer `hasRef`. */
  has(name: string): boolean;
  /** Is this Identifier node a read of a caller-controlled binding? */
  hasRef(node: AstNode | null | undefined): boolean;
  readonly size: number;
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
  /**
   * Comment nodes in ascending `start` order. Comments are not part of the AST,
   * so a rule that needs to compare what a comment CLAIMS against what the code
   * DOES has to be handed them separately.
   */
  comments: readonly CommentNode[];
  /** Caller-controlled bindings (intra-file taint). */
  taintedBindings: TaintLookup;
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
  /**
   * Type answers — present only under `--typed`, and only for diagnostics that
   * declare `requiresTypes`. Absent means "no type information", never "no
   * promise": a typed diagnostic must stay silent rather than guess.
   */
  typeSource?: TypeSource;
}

/** A comment as the parser reports it: no `.loc`, offsets only. */
export interface CommentNode {
  /** "Line" for `//`, "Block" for `/* … *\/`. */
  type: string;
  /** The text between the delimiters, verbatim — a JSDoc block still has its `*`s. */
  value: string;
  start: number;
  end: number;
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
  /**
   * AT LEAST ONE of these must be present — the family gate.
   *
   * Some defects are shared by frameworks that spell them identically: a guard
   * that responds without returning is the same bug, and the same fix, on Express
   * and Fastify. `requires` is ALL, so it cannot express that, and dropping the
   * gate would let the rule run on projects with no HTTP framework at all.
   * Combines with `requires` (both must hold). An empty array is no constraint.
   */
  requiresAny?: string[];
  /** ANY of these present disables the diagnostic. */
  disabledWhen?: string[];
  /** Families for `--ignore-tag`. */
  tags?: string[];
  /** false → opt-in only. Default true. */
  defaultEnabled?: boolean;
  /**
   * Needs type information to be correct. These run only under `--typed`; with
   * no type source they are not merely quiet, they are not selected at all, so a
   * normal scan never pays for them and never half-answers them.
   */
  requiresTypes?: boolean;
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
