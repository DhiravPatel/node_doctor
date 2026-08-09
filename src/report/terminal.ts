/**
 * The terminal reporter. Reads top-to-bottom: score → counts → findings grouped
 * by category (largest first), then diagnostic (most sites first). Colors via
 * picocolors; degrades gracefully when not a TTY or when `color: false`.
 */

import pc from "picocolors";
import type { Category, Finding } from "../core/types.ts";
import { CATEGORIES } from "../core/types.ts";
import type { ScanReport } from "../core/scan.ts";
import { renderCodeFrame } from "./code-frame.ts";

export interface RenderOptions {
  verbose?: boolean;
  color?: boolean;
  version?: string;
  /** Emit OSC-8 clickable hyperlinks on file locations (capable terminals). */
  hyperlinks?: boolean;
  /** Provide a file's source so verbose output can draw a code frame. */
  sourceFor?: (finding: Finding) => string | undefined;
}

const OSC8 = `${String.fromCharCode(27)}]8;;`;
const OSC8_ST = String.fromCharCode(27, 92); // ESC \

/** Wrap `text` in an OSC-8 hyperlink to `target` when enabled. */
const hyperlink = (target: string, text: string, enabled: boolean): string =>
  enabled ? `${OSC8}${target}${OSC8_ST}${text}${OSC8}${OSC8_ST}` : text;

type Colorize = (s: string) => string;

interface Palette {
  bold: Colorize;
  dim: Colorize;
  red: Colorize;
  green: Colorize;
  yellow: Colorize;
  cyan: Colorize;
}

const identity: Colorize = (s) => s;

const makePalette = (color: boolean): Palette =>
  color
    ? { bold: pc.bold, dim: pc.dim, red: pc.red, green: pc.green, yellow: pc.yellow, cyan: pc.cyan }
    : { bold: identity, dim: identity, red: identity, green: identity, yellow: identity, cyan: identity };

const BAR_WIDTH = 30;
const DEFAULT_SITE_CAP = 3;

const scoreColor = (label: string, p: Palette): Colorize =>
  label === "healthy" ? p.green : label === "needs work" ? p.yellow : p.red;

const bar = (score: number, p: Palette): string => {
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((score / 100) * BAR_WIDTH)));
  const color = scoreColor(score >= 75 ? "healthy" : score >= 50 ? "needs work" : "critical", p);
  return color("█".repeat(filled)) + p.dim("░".repeat(BAR_WIDTH - filled));
};

const glyph = (severity: string, p: Palette): string =>
  severity === "error" ? p.red("✖") : p.yellow("⚠");

const groupBy = <T, K>(items: T[], key: (item: T) => K): Map<K, T[]> => {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k) ?? [];
    list.push(item);
    map.set(k, list);
  }
  return map;
};

/** Produce the terminal-formatted string for a report. */
export const renderReport = (report: ScanReport, options: RenderOptions = {}): string => {
  const verbose = options.verbose ?? false;
  const p = makePalette(options.color ?? true);
  const version = options.version ? `v${options.version}` : "";
  const lines: string[] = [];
  const { project, findings, score } = report;

  const errors = findings.filter((d) => d.severity === "error").length;
  const warnings = findings.length - errors;

  lines.push("");
  lines.push(`  ${p.bold("node.doctor")} ${p.dim(version)}  ${p.bold(project.name)}`);
  lines.push(
    p.dim(
      `  ${project.analyzedFileCount} files · ${project.totalLines.toLocaleString("en-US")} lines · ${report.diagnosticsRun}/${report.diagnosticsAvailable} diagnostics active`,
    ),
  );
  const caps = project.capabilities.filter((c) => c !== "node");
  if (caps.length > 0) lines.push(p.dim(`  detected: ${caps.join(" ")}`));
  lines.push("");

  const scoreLine = `  ${bar(score.score, p)}  ${p.bold(`${score.score}/100`)}  ${scoreColor(score.label, p)(score.label)}`;
  lines.push(scoreLine);
  lines.push("");
  lines.push(
    `  ${p.red(`${errors} errors`)}  ·  ${p.yellow(`${warnings} warnings`)}  ·  ${p.dim(`${score.perThousandLines} weighted/kLOC`)}`,
  );

  if (!project.complete) {
    lines.push("");
    lines.push(
      p.yellow(
        `  ⚠ ${project.parseFailures.length} file(s) could not be parsed — results are incomplete, not "clean".`,
      ),
    );
    for (const f of project.parseFailures.slice(0, verbose ? Infinity : 3)) {
      lines.push(p.dim(`     ${f.normalizedFilePath}: ${f.message}`));
    }
  }

  if (findings.length === 0) {
    lines.push("");
    lines.push(project.complete ? p.green("  ✓ No findings.") : p.dim("  No findings in the files that parsed."));
    lines.push("");
    return lines.join("\n");
  }

  // Group by category, largest first (tie-break by canonical order).
  const byCategory = groupBy(findings, (d) => d.category);
  const orderedCategories = [...byCategory.keys()].sort((a, b) => {
    const diff = byCategory.get(b)!.length - byCategory.get(a)!.length;
    if (diff !== 0) return diff;
    return CATEGORIES.indexOf(a) - CATEGORIES.indexOf(b);
  });

  for (const category of orderedCategories) {
    const catDiags = byCategory.get(category)!;
    lines.push("");
    lines.push(`  ${p.bold(category as Category)} ${p.dim(`(${catDiags.length})`)}`);

    // Group by diagnostic, most sites first.
    const byRule = groupBy(catDiags, (d) => d.diagnostic);
    const orderedRules = [...byRule.keys()].sort((a, b) => {
      const diff = byRule.get(b)!.length - byRule.get(a)!.length;
      if (diff !== 0) return diff;
      return a < b ? -1 : 1;
    });

    for (const diagnostic of orderedRules) {
      const ruleDiags = byRule.get(diagnostic)!;
      const first = ruleDiags[0]!;
      const siteWord = ruleDiags.length === 1 ? "site" : "sites";
      lines.push("");
      lines.push(
        `  ${glyph(first.severity, p)} ${p.bold(first.title)} ${p.dim(`· ${ruleDiags.length} ${siteWord}`)}`,
      );
      lines.push(`     ${first.message}`);

      const cap = verbose ? Infinity : DEFAULT_SITE_CAP;
      const shown = ruleDiags.slice(0, cap);
      for (const d of shown) {
        const loc = `${d.normalizedFilePath}:${d.line}:${d.column}`;
        lines.push(p.cyan(`     ${hyperlink(`file://${d.filePath}`, loc, options.hyperlinks ?? false)}`));
        if (d.suppressionHint) lines.push(p.yellow(`       ↳ suppression near-miss: ${d.suppressionHint}`));
        if (verbose && options.sourceFor) {
          const src = options.sourceFor(d);
          if (src) {
            const frame = renderCodeFrame({ sourceText: src, line: d.line, column: d.column, dim: p.dim, caret: p.red });
            if (frame) lines.push(frame);
          }
        }
      }
      const remaining = ruleDiags.length - shown.length;
      if (remaining > 0) lines.push(p.dim(`     … ${remaining} more`));

      lines.push(p.dim(`     → ${first.recommendation}`));
      lines.push(p.dim(`     node-doctor/${diagnostic}`));
    }
  }

  lines.push("");
  return lines.join("\n");
};

/** Render a monorepo/workspace report: worst-of headline + per-project scores. */
export const renderWorkspaceReport = (
  report: {
    rootDirectory: string;
    projects: Array<{ name: string; normalizedRoot: string; report: ScanReport }>;
    score: { score: number; label: string };
    worstProject: string | null;
    projectCount: number;
    totalFindings: number;
  },
  options: RenderOptions = {},
): string => {
  const p = makePalette(options.color ?? true);
  const version = options.version ? `v${options.version}` : "";
  const lines: string[] = [""];

  lines.push(`  ${p.bold("node.doctor")} ${p.dim(version)}  ${p.dim("workspace")} · ${p.bold(String(report.projectCount))} projects`);
  lines.push(
    `  ${bar(report.score.score, p)}  ${p.bold(`${report.score.score}/100`)}  ${scoreColor(report.score.label, p)(report.score.label)}  ${p.dim("(worst-of)")}`,
  );
  lines.push(p.dim(`  ${report.totalFindings} finding(s) across the workspace`));
  lines.push("");

  // Projects, worst score first.
  const ordered = report.projects
    .slice()
    .sort((a, b) => a.report.score.score - b.report.score.score || (a.name < b.name ? -1 : 1));
  for (const proj of ordered) {
    const s = proj.report.score;
    const count = proj.report.findings.length;
    const mark = scoreColor(s.label, p);
    lines.push(
      `  ${mark(`${String(s.score).padStart(3)}/100`)}  ${p.bold(proj.name)} ${p.dim(proj.normalizedRoot)}  ${p.dim(`· ${count} finding(s)`)}`,
    );
  }
  lines.push("");
  lines.push(p.dim(`  Scan one project:  node-doctor . --project <name>`));
  lines.push("");
  return lines.join("\n");
};

/** Render just the delta view (introduced/resolved). */
export const renderDelta = (
  introduced: Finding[],
  resolved: Finding[],
  options: RenderOptions = {},
): string => {
  const p = makePalette(options.color ?? true);
  const lines: string[] = [""];

  if (resolved.length > 0) {
    lines.push(p.green(`  ✓ ${resolved.length} finding(s) resolved by this change`));
    lines.push("");
  }

  if (introduced.length === 0) {
    lines.push(p.green("  ✓ No new findings introduced by this change."));
    lines.push("");
    return lines.join("\n");
  }

  lines.push(p.bold(`  ${introduced.length} new finding(s) introduced by this change:`));
  for (const d of introduced) {
    const loc = `${d.normalizedFilePath}:${d.line}:${d.column}`;
    lines.push("");
    lines.push(`  ${glyph(d.severity, p)} ${p.cyan(hyperlink(`file://${d.filePath}`, loc, options.hyperlinks ?? false))}`);
    lines.push(`    ${p.bold(d.title)}`);
    lines.push(`    ${d.message}`);
    lines.push(p.dim(`    → ${d.recommendation}`));
    lines.push(p.dim(`    node-doctor/${d.diagnostic}`));
  }
  lines.push("");
  return lines.join("\n");
};

/**
 * §120 — the blast radius of a change: the routes and files a change can reach,
 * nearest first. Deliberately leads with the route count, because that is the
 * number a reviewer needs before reading the diff.
 */
export const renderImpact = (
  report: import("../core/impact.ts").ImpactReport,
  options: { color?: boolean } = {},
): string => {
  const p = makePalette(options.color ?? true);
  const lines: string[] = [""];

  lines.push(`  ${p.bold("Change impact")} — ${report.changed.length} changed file(s)`);
  for (const c of report.changed) lines.push(p.dim(`    · ${c}`));
  for (const u of report.unresolved) lines.push(p.dim(`    ? ${u} (not in the analyzed graph)`));
  lines.push("");

  if (report.reachedCount === 0) {
    lines.push(p.dim("  Nothing in the project imports the changed file(s) — blast radius is self-contained."));
    lines.push("");
    return lines.join("\n");
  }

  // "handler-shaped", not "routes": the detection matches the `(req, res)` shape,
  // which a middleware factory has too. Naming the signal honestly costs a word.
  const routes = report.routeBearingFiles.length;
  lines.push(
    `  ${p.bold(String(report.reachedCount))} file(s) transitively depend on this change` +
      (routes > 0 ? `, including ${p.bold(String(routes))} with request-handler code:` : ":"),
  );
  lines.push("");
  for (const d of report.dependents) {
    const marker = d.hasHandlers ? p.yellow("[handler]") : "         ";
    lines.push(`  ${marker} ${p.dim(`d${d.depth}`)} ${d.normalizedFilePath}`);
  }
  lines.push("");
  if (routes > 0) {
    lines.push(p.dim(`  Review the ${routes} handler-bearing file(s) first — their responses can change.`));
    lines.push("");
  }
  return lines.join("\n");
};

/**
 * §121 — source→sink attack paths: for each injection sink fed by request data,
 * the exact chain of calls that carries caller input to it. The proof a finding
 * is reachable, laid out step by step from the request handler to the sink.
 */
export const renderAttackPaths = (
  paths: readonly import("../core/attack-paths.ts").AttackPath[],
  options: { color?: boolean } = {},
): string => {
  const p = makePalette(options.color ?? true);
  const lines: string[] = [""];
  if (paths.length === 0) {
    lines.push(p.dim("  No caller-controlled data reaches an injection sink through the call graph."));
    lines.push("");
    return lines.join("\n");
  }
  lines.push(`  ${p.bold(String(paths.length))} exploitable path(s) — caller data reaching an injection sink:`);
  for (const path of paths) {
    lines.push("");
    lines.push(`  ${p.red("▸")} ${p.bold(path.sinkKind)}`);
    path.steps.forEach((s, i) => {
      const arrow = i === 0 ? "source" : `  ↓  `;
      lines.push(`      ${p.dim(arrow)}  ${s.label}  ${p.cyan(`${s.normalizedFilePath}:${s.line}`)}`);
    });
    lines.push(`      ${p.red("  ↓  ")}  ${p.red("sink")}  ${p.cyan(`${path.sink.normalizedFilePath}:${path.sink.line}`)}`);
  }
  lines.push("");
  return lines.join("\n");
};

// A human label for each sensitive-file category, largest-blast-radius first.
const CONTEXT_CATEGORY_LABEL: Record<string, string> = {
  env: "Environment files",
  "key-material": "Private keys / key material",
  credentials: "Credential files",
  "secret-content": "Files containing a secret",
  "data-dump": "Database dumps / data exports",
};
const CONTEXT_CATEGORY_ORDER = ["env", "key-material", "credentials", "secret-content", "data-dump"];

/**
 * §158 — the agent context-hygiene report: which on-disk files hold secrets/key
 * material and are NOT yet fenced off from an AI agent's reads. Groups the
 * exposed files by category; a clean tree gets a one-line all-clear.
 */
export const renderContextHygiene = (
  report: import("../core/agent-context.ts").ContextHygieneReport,
  options: { color?: boolean } = {},
): string => {
  const p = makePalette(options.color ?? true);
  const lines: string[] = [""];

  if (report.exposed.length === 0) {
    lines.push(`  ${p.green("✓")} No sensitive files exposed to agent context.`);
    if (report.summary.total > 0) {
      lines.push(
        p.dim(
          `    (${report.summary.total} sensitive file(s) found, all already covered by an ignore rule.)`,
        ),
      );
    }
    lines.push("");
    return lines.join("\n");
  }

  lines.push(
    `  ${p.bold(String(report.exposed.length))} sensitive file(s) readable by an AI agent and not yet fenced off:`,
  );
  lines.push("");

  const byCategory = new Map<string, typeof report.exposed>();
  for (const f of report.exposed) {
    const list = byCategory.get(f.category) ?? [];
    list.push(f);
    byCategory.set(f.category, list);
  }
  for (const category of CONTEXT_CATEGORY_ORDER) {
    const group = byCategory.get(category);
    if (!group || group.length === 0) continue;
    lines.push(`  ${p.bold(CONTEXT_CATEGORY_LABEL[category] ?? category)}`);
    for (const f of group) {
      const tracked = f.gitTracked ? p.dim(" (git-tracked)") : "";
      lines.push(`    ${p.red("✖")} ${f.normalizedPath}${tracked}  ${p.dim(`— ${f.reason}`)}`);
    }
    lines.push("");
  }

  lines.push(
    p.dim(
      "  run `node-doctor context --write` to generate .aiignore / .cursorignore / Claude Code deny rules.",
    ),
  );
  lines.push("");
  return lines.join("\n");
};

/**
 * §151 — the Observability Coverage Score: per route, "could you debug this at
 * 3am?". Leads with the codebase score bar (the observability equivalent of a
 * coverage number), then lists the routes that fall short (score < 100) with the
 * exact checks they failed, and closes with the per-check pass-rate summary. A
 * codebase at 100 gets a one-line all-clear.
 */
const OBSERVABILITY_CHECK_ORDER = [
  "error-handling",
  "logs-on-failure",
  "timed-external-calls",
  "correlation-id",
];

export const renderObservability = (
  report: import("../core/observability.ts").ObservabilityReport,
  options: { color?: boolean } = {},
): string => {
  const p = makePalette(options.color ?? true);
  const lines: string[] = [""];

  lines.push(`  ${p.bold("Observability coverage")}  ${bar(report.score, p)}  ${p.bold(`${report.score}/100`)}`);
  lines.push(p.dim(`  ${report.summary.routes} route(s) scored — could you debug this at 3am?`));
  lines.push("");

  if (report.summary.routes === 0) {
    lines.push(p.dim("  No scorable route handlers found."));
    lines.push("");
    return lines.join("\n");
  }

  const worst = report.routes.filter((r) => r.score < 100);
  if (worst.length === 0) {
    lines.push(`  ${p.green("✓")} All routes observable — every applicable check passes.`);
    lines.push("");
  } else {
    lines.push(`  ${p.bold(String(worst.length))} route(s) below full coverage:`);
    lines.push("");
    for (const r of worst) {
      const failed = OBSERVABILITY_CHECK_ORDER.filter((c) => r.checks[c] === "fail");
      const color = r.score >= 75 ? p.yellow : p.red;
      lines.push(
        `  ${color("✖")} ${r.method.padEnd(7)}${r.path.padEnd(30)} ${p.bold(String(r.score).padStart(3))}/100`,
      );
      lines.push(`       ${p.cyan(`${r.normalizedFilePath}:${r.line}`)}`);
      lines.push(`       ${p.dim("failed:")} ${failed.join(", ")}`);
    }
    lines.push("");
  }

  lines.push(`  ${p.bold("Per-check pass rate")}`);
  for (const c of OBSERVABILITY_CHECK_ORDER) {
    const rate = report.summary.checkPassRate[c] ?? 100;
    lines.push(`    ${c.padEnd(22)} ${String(rate).padStart(3)}%`);
  }
  lines.push("");
  return lines.join("\n");
};

/**
 * §143 — the Data Access Map: which routes touch which database entities, and how
 * (read / write / delete). Two views: per-route lineage (a route then the entities
 * its call graph reaches, each tagged r/w/d with the source location), and the
 * inverse entity index (an entity then the routes that touch it — the "which routes
 * write payments?" answer). Closes with a one-line summary; an empty project gets
 * a single clear message.
 */
const OP_MARK: Record<string, string> = { read: "r", write: "w", delete: "d" };
/** Render an op list as fixed-width `rwd` markers with absent ops dimmed. */
const opMarkers = (ops: readonly string[], p: Palette): string => {
  const has = new Set(ops);
  return (["read", "write", "delete"] as const)
    .map((op) => {
      const ch = OP_MARK[op]!;
      return has.has(op) ? (op === "delete" ? p.red(ch) : op === "write" ? p.yellow(ch) : p.green(ch)) : p.dim("·");
    })
    .join("");
};

export const renderReviewRouting = (
  routing: import("../core/review-routing.ts").ReviewRouting,
  options: { color?: boolean } = {},
): string => {
  const p = makePalette(options.color ?? true);
  const lines: string[] = [""];

  const badge =
    routing.level === "senior"
      ? p.red("SENIOR REVIEW")
      : routing.level === "standard"
        ? p.yellow("STANDARD REVIEW")
        : p.green("LIGHT REVIEW");
  lines.push(`  ${p.bold("Review routing")}  ${badge}`);
  lines.push("");

  lines.push(`  ${p.bold("Changed")}  ${p.dim(`${routing.changed.length} file(s)`)}`);
  for (const f of routing.changed.slice(0, 10)) lines.push(`      ${p.cyan(f)}`);
  if (routing.changed.length > 10) lines.push(p.dim(`      … ${routing.changed.length - 10} more`));
  lines.push("");

  lines.push(
    `  ${p.bold("Blast radius")}  ${routing.reachedCount} file(s) reachable · ${routing.handlerBearingFiles.length} with handler-shaped code`,
  );
  for (const f of routing.handlerBearingFiles.slice(0, 8)) lines.push(`      ${p.dim("→")} ${p.cyan(f)}`);
  if (routing.handlerBearingFiles.length > 8) {
    lines.push(p.dim(`      … ${routing.handlerBearingFiles.length - 8} more`));
  }
  lines.push("");

  if (routing.hubsTouched.length > 0) {
    lines.push(`  ${p.red("Hub modules touched")}  ${p.dim("(every change here has wide reach)")}`);
    for (const f of routing.hubsTouched) lines.push(`      ${p.red("↻")} ${p.cyan(f)}`);
    lines.push("");
  }

  if (routing.reviewers.length > 0) {
    lines.push(`  ${p.bold("Reviewers")}  ${p.dim("(owners of the change AND of what it can reach)")}`);
    for (const o of routing.reviewers) {
      const direct = routing.directOwners.includes(o) ? p.dim("  (owns a changed file)") : "";
      lines.push(`      ${o}${direct}`);
    }
    lines.push("");
  } else {
    lines.push(p.dim("  No CODEOWNERS rules matched — add a CODEOWNERS file to route reviews."));
    lines.push("");
  }

  lines.push(`  ${p.bold("Why")}`);
  for (const reason of routing.rationale) lines.push(p.dim(`      · ${reason}`));
  if (routing.unresolved.length > 0) {
    lines.push("");
    lines.push(
      p.yellow(`  ● ${routing.unresolved.length} changed file(s) are not in the import graph — their reach is unknown, not zero:`),
    );
    for (const f of routing.unresolved.slice(0, 5)) lines.push(p.dim(`      ${f}`));
  }
  lines.push("");
  return lines.join("\n");
};

/**
 * §182 — the operational-readiness report.
 *
 * The layout leads with the number, but it is deliberately impossible to read
 * the number without also reading how much was actually assessed: the "not
 * proven" and "not applicable" counts sit on the same line as the score, and
 * every dimension prints the reason for its verdict. An unscored report says so
 * in words rather than showing a hopeful 100.
 */
export const renderReadiness = (
  report: import("../core/readiness.ts").ReadinessReport,
  options: { color?: boolean } = {},
): string => {
  const p = makePalette(options.color ?? true);
  const lines: string[] = [""];

  const { score, label, summary } = report;
  if (score === null) {
    lines.push(`  ${p.bold("Operational readiness")}  ${p.yellow("not scored")}`);
    lines.push(
      p.dim("    No dimension could be assessed here — that is not the same as being ready."),
    );
  } else {
    const color = label === "ready" ? p.green : label === "needs work" ? p.yellow : p.red;
    lines.push(
      `  ${p.bold("Operational readiness")}  ${bar(score, p)}  ${p.bold(`${score}/100`)}  ${color(label)}`,
    );
    lines.push(
      p.dim(
        `    ${summary.ready} ready · ${summary.gaps} gap(s) · scored over ${summary.ready + summary.gaps} of ${report.dimensions.length} dimensions`,
      ),
    );
  }
  if (summary.notProven > 0 || summary.notApplicable > 0) {
    lines.push(
      p.dim(
        `    ${summary.notProven} not proven · ${summary.notApplicable} not applicable — neither counted for nor against`,
      ),
    );
  }
  lines.push("");

  for (const d of report.dimensions) {
    const mark =
      d.status === "ready"
        ? p.green("✔")
        : d.status === "gap"
          ? p.red("✖")
          : d.status === "not-proven"
            ? p.yellow("?")
            : p.dim("·");
    const tag =
      d.status === "not-proven"
        ? p.yellow(" [not proven]")
        : d.status === "not-applicable"
          ? p.dim(" [n/a]")
          : "";
    lines.push(`  ${mark} ${p.bold(d.title)}${tag}`);
    lines.push(`      ${p.dim(d.detail)}`);
    for (const e of d.evidence) lines.push(`      ${p.dim("→")} ${p.cyan(e)}`);
    lines.push("");
  }

  if (!summary.complete || summary.parseFailures > 0) {
    lines.push(
      p.yellow(
        `  ⚠ ${summary.parseFailures} file(s) could not be parsed — this score is incomplete.`,
      ),
    );
    lines.push("");
  }

  return lines.join("\n");
};

/**
 * §159 — the change-shape report.
 *
 * Deliberately reads as a reviewer's note, not as a lint result: no score, no
 * severity glyphs borrowed from the finding vocabulary, and every shape prints
 * WHY it matters rather than assuming the reader already knows. An unreadable
 * diff says so in words — it must never render like a clean one.
 */
/**
 * §181 — the locale-integrity report.
 *
 * A suppressed unused-key list prints the REASON rather than an empty section:
 * "we found none" and "we could not look" are different answers, and only one
 * of them means the translations are clean.
 */
/**
 * §83 — the Node upgrade report.
 *
 * The caveat prints with every redundancy, never behind a flag or a `--verbose`.
 * "You can delete node-fetch" is only true with "…unless you pipe `res.body`"
 * attached, and a reader who acts on the first half alone has been misled by a
 * true sentence.
 */
/**
 * §69 — the supply-chain report.
 *
 * Never uses the finding vocabulary: no ✖, no severity, no score. A postinstall
 * script is how `esbuild` fetches its binary — the report states what runs and
 * where it came from, and leaves the judgement to the reader. When a check did
 * not run, it says so where the result would have been, because "no install
 * scripts found" and "node_modules is not installed" are different answers and
 * only one is safe to act on.
 */
/**
 * §206 — the hallucinated-API report.
 *
 * The SKIPPED list is printed, not hidden. A package whose surface could not be
 * enumerated is the one place this analysis is blind, and a reader who takes a
 * clean result as "every call is real" without seeing what was skipped has been
 * misled by an accurate report.
 */
export const renderPackageApi = (
  report: import("../core/package-api.ts").PackageApiReport,
  options: { color?: boolean } = {},
): string => {
  const p = makePalette(options.color ?? true);
  const lines: string[] = [""];

  if (!report.installed) {
    lines.push(`  ${p.yellow("●")} Not checked — no dependency is installed under \`node_modules\`.`);
    lines.push(p.dim("    A package's real export surface is the only thing that can settle this."));
    lines.push("");
    return lines.join("\n");
  }

  lines.push(
    `  ${p.bold("Package API")}  ${p.dim(
      `${report.summary.packagesChecked} package(s) checked · ${report.summary.filesScanned} file(s)`,
    )}`,
  );
  lines.push("");

  if (report.unknownMembers.length > 0) {
    lines.push(`  ${p.red("✖")} ${p.bold(`${report.unknownMembers.length} name(s) the package does not export`)}`);
    lines.push(p.dim("      The import is `undefined` — a TypeError on the first call that reaches it."));
    lines.push("");
    for (const m of report.unknownMembers.slice(0, 25)) {
      const hint = m.suggestion ? p.dim(`  did you mean \`${m.suggestion}\`?`) : "";
      lines.push(`      ${p.cyan(`${m.normalizedFilePath}:${m.line}`)}  \`${m.package}\` has no \`${m.name}\`${hint}`);
    }
    if (report.unknownMembers.length > 25) {
      lines.push(p.dim(`      … ${report.unknownMembers.length - 25} more`));
    }
    lines.push("");
  } else {
    lines.push(p.green("  ✔ Every name used on a checked package really is exported by it."));
    lines.push("");
  }

  if (report.skipped.length > 0) {
    lines.push(p.dim(`  ${report.skipped.length} package(s) NOT checked:`));
    for (const s of report.skipped.slice(0, 12)) {
      lines.push(p.dim(`      · ${s.package} — ${s.reason}`));
    }
    if (report.skipped.length > 12) lines.push(p.dim(`      … ${report.skipped.length - 12} more`));
    lines.push("");
  }

  return lines.join("\n");
};

/**
 * §185 — the `exports` map report.
 *
 * Every finding here is a resolution that FAILS at runtime for a consumer, so
 * the report is a flat list ordered by how the map is written, not a score.
 */
/**
 * §110 — the AI-authored-code trust boundary.
 *
 * Leads with the INTERSECTION (findings on AI-assisted lines), because that is
 * the review decision; the totals are context for it, not the point.
 */
export const renderAiAttribution = (
  report: import("../core/ai-attribution.ts").AiAttributionReport,
  options: { color?: boolean } = {},
): string => {
  const p = makePalette(options.color ?? true);
  const lines: string[] = [""];

  if (!report.available) {
    lines.push(`  ${p.yellow("\u25cf")} ${p.bold("Not checked")} \u2014 ${report.unavailableReason}.`);
    lines.push(p.dim("    Attribution comes from git metadata; without a work tree there is nothing to read."));
    lines.push("");
    return lines.join("\n");
  }

  lines.push(
    `  ${p.bold("AI attribution")}  ${p.dim(
      `${report.summary.aiCommits} of ${report.summary.commitsScanned} commit(s) declared AI assistance`,
    )}`,
  );
  lines.push(p.dim("    A trailer is a claim, not proof \u2014 this is a floor on AI involvement, not a measurement."));
  lines.push("");

  if (report.summary.aiCommits === 0) {
    lines.push(p.green("  \u2714 No commit in the scanned history declares AI assistance."));
    lines.push("");
    return lines.join("\n");
  }

  if (report.historyTruncated) {
    lines.push(`  ${p.yellow("\u25cf")} Shallow checkout \u2014 line attribution suppressed.`);
    lines.push(p.dim("      `git blame` would credit every pre-graft line to the boundary commit."));
    lines.push("");
  }

  if (report.findingsOnAiLines.length > 0) {
    lines.push(
      `  ${p.red("\u2716")} ${p.bold(`${report.findingsOnAiLines.length} finding(s) on AI-assisted lines`)}`,
    );
    lines.push(p.dim("      Code no human has touched since, carrying a finding. Review these first."));
    lines.push("");
    for (const f of report.findingsOnAiLines.slice(0, 25)) {
      lines.push(
        `      ${p.cyan(`${f.normalizedFilePath}:${f.line}`)}  ${f.diagnostic}  ${p.dim(`\u2190 ${f.commit.sha} (${f.commit.signal})`)}`,
      );
    }
    if (report.findingsOnAiLines.length > 25) {
      lines.push(p.dim(`      \u2026 ${report.findingsOnAiLines.length - 25} more`));
    }
    lines.push("");
  } else if (report.summary.findingsChecked > 0) {
    lines.push(
      p.green(`  \u2714 None of the ${report.summary.findingsChecked} finding(s) land on an AI-assisted line.`),
    );
    lines.push("");
  }

  if (report.files.length > 0) {
    lines.push(p.dim(`  Line attribution across the ${report.summary.filesBlamed} file(s) carrying findings:`));
    for (const f of report.files.slice(0, 12)) {
      const share = f.blamedLines === 0 ? 0 : Math.round((f.aiLines / f.blamedLines) * 100);
      lines.push(p.dim(`      ${f.path}  ${f.aiLines}/${f.blamedLines} lines (${share}%)`));
    }
    if (report.files.length > 12) lines.push(p.dim(`      \u2026 ${report.files.length - 12} more`));
    lines.push("");
  }

  lines.push(p.dim(`  Commits that declared AI assistance (${report.aiCommits.length}):`));
  for (const c of report.aiCommits.slice(0, 10)) {
    lines.push(p.dim(`      ${c.sha}  ${c.date.slice(0, 10)}  ${c.subject.slice(0, 62)}`));
  }
  if (report.aiCommits.length > 10) lines.push(p.dim(`      \u2026 ${report.aiCommits.length - 10} more`));
  lines.push("");

  return lines.join("\n");
};

export const renderExportsCheck = (
  report: import("../core/exports-map.ts").ExportsCheckReport,
  options: { color?: boolean } = {},
): string => {
  const p = makePalette(options.color ?? true);
  const lines: string[] = [""];

  if (!report.hasExportsMap) {
    lines.push(`  ${p.yellow("\u25cf")} ${p.bold("No `exports` map")} ${p.dim(`in ${report.manifestPath}`)}`);
    lines.push(p.dim("    Nothing to check. Without one, every file in the package is importable."));
    lines.push("");
    return lines.join("\n");
  }

  lines.push(
    `  ${p.bold("Package exports")}  ${p.dim(
      `${report.summary.subpaths} subpath(s) \u00b7 ${report.summary.conditions} condition(s) \u00b7 ${report.manifestPath}`,
    )}`,
  );
  lines.push("");

  if (report.findings.length === 0) {
    lines.push(p.green("  \u2714 Every declared entry point resolves, and the conditions are ordered correctly."));
    lines.push("");
    return lines.join("\n");
  }

  lines.push(`  ${p.red("\u2716")} ${p.bold(`${report.findings.length} broken entry point(s)`)}`);
  lines.push(p.dim("      Each one is an import that throws for a consumer, and never for you."));
  lines.push("");
  for (const f of report.findings) {
    lines.push(`      ${p.cyan(f.conditionPath)}${f.target === null ? "" : p.dim(`  \u2192 ${f.target}`)}`);
    lines.push(`        ${f.message}`);
  }
  lines.push("");

  return lines.join("\n");
};

export const renderSupplyChain = (
  report: import("../core/supply-chain.ts").SupplyChainReport,
  options: { color?: boolean } = {},
): string => {
  const p = makePalette(options.color ?? true);
  const lines: string[] = [""];

  lines.push(
    `  ${p.bold("Supply chain")}  ${p.dim(
      `${report.summary.directDependencies} direct · ${report.summary.packagesInspected} installed package(s) inspected`,
    )}`,
  );
  lines.push("");

  if (report.installScriptCheck !== "checked") {
    lines.push(
      `  ${p.yellow("●")} Install scripts NOT checked — ${
        report.installScriptCheck === "not-installed"
          ? "`node_modules` is not present, and the manifest cannot tell you which installed version has a script"
          : "the installed tree could not be read"
      }.`,
    );
    lines.push(p.dim("    This is not the same as finding none."));
    lines.push("");
  } else if (report.installScripts.length === 0) {
    lines.push(p.green("  ✔ No installed package runs a script at install time."));
    lines.push("");
  } else {
    const direct = report.installScripts.filter((s) => s.direct);
    const transitive = report.installScripts.filter((s) => !s.direct);
    lines.push(
      `  ${p.bold(`${report.summary.withInstallScripts} package(s) run code when you install`)}  ${p.dim(
        `${direct.length} direct · ${transitive.length} transitive`,
      )}`,
    );
    lines.push(
      p.dim("      Each runs on every developer machine and CI runner, before any of your code does."),
    );
    lines.push("");
    for (const s of [...direct, ...transitive].slice(0, 25)) {
      const tag = s.direct ? p.yellow("direct") : p.dim("transitive");
      lines.push(`      ${p.cyan(`${s.package}@${s.version}`)}  ${p.dim(s.hook)}  ${tag}`);
      lines.push(`          ${p.dim(s.command)}`);
    }
    if (report.installScripts.length > 25) {
      lines.push(p.dim(`      … ${report.installScripts.length - 25} more`));
    }
    lines.push("");
  }

  if (report.sourceCheck !== "checked") {
    lines.push(
      `  ${p.yellow("●")} Package sources NOT checked — ${
        report.sourceCheck === "no-lockfile"
          ? "no `package-lock.json` was found"
          : "the lockfile could not be parsed"
      }.`,
    );
    lines.push("");
  } else if (report.nonRegistrySources.length === 0) {
    lines.push(p.green("  ✔ Every locked dependency resolves from the public registry."));
    lines.push("");
  } else {
    lines.push(`  ${p.bold(`${report.nonRegistrySources.length} dependenc(ies) do not come from the registry`)}`);
    lines.push("");
    for (const s of report.nonRegistrySources.slice(0, 20)) {
      lines.push(`      ${p.cyan(s.package)}`);
      lines.push(`          ${p.dim(s.resolved)}`);
      lines.push(`          ${p.dim(s.why)}`);
    }
    if (report.nonRegistrySources.length > 20) {
      lines.push(p.dim(`      … ${report.nonRegistrySources.length - 20} more`));
    }
    lines.push("");
  }

  lines.push(
    p.dim("  These are facts, not accusations — a postinstall script is also how `esbuild` fetches its binary."),
  );
  lines.push("");
  return lines.join("\n");
};

export const renderNodeUpgrade = (
  report: import("../core/node-upgrade.ts").NodeUpgradeReport,
  options: { color?: boolean } = {},
): string => {
  const p = makePalette(options.color ?? true);
  const lines: string[] = [""];

  const declared = report.declaredNodeMajor === null ? "not declared" : `engines.node ${report.declaredNodeMajor}`;
  lines.push(`  ${p.bold("Node upgrade")}  ${p.dim(`target Node ${report.target} · ${declared}`)}`);
  lines.push("");

  if (report.breaks.length > 0) {
    lines.push(`  ${p.red("✖")} ${p.bold(`${report.breaks.length} call(s) that do NOT exist on Node ${report.target}`)}`);
    lines.push(p.dim("      These throw on the first execution after the upgrade — they do not warn."));
    lines.push("");
    for (const b of report.breaks.slice(0, 20)) {
      lines.push(`      ${p.cyan(`${b.normalizedFilePath}:${b.line}`)}  \`${b.api}\`  ${p.dim(`removed in Node ${b.removedIn}`)}`);
    }
    if (report.breaks.length > 20) lines.push(p.dim(`      … ${report.breaks.length - 20} more`));
    lines.push("");
  } else {
    lines.push(p.green(`  ✔ No removed API is called among the removals this build knows about.`));
    lines.push("");
  }

  if (report.redundant.length > 0) {
    lines.push(`  ${p.bold(`${report.redundant.length} dependenc(ies) Node ${report.target} makes redundant`)}`);
    lines.push("");
    for (const r of report.redundant) {
      lines.push(`      ${p.yellow("→")} ${p.bold(r.package)}  ${p.dim(`replaced by ${r.builtin} · ${r.requires}`)}`);
      lines.push(`        ${p.dim(r.caveat)}`);
      for (const s of r.sites) lines.push(`        ${p.dim("·")} ${p.cyan(s)}`);
      lines.push("");
    }
  }

  if (report.notes.length > 0) {
    lines.push(p.dim("  Not assessed:"));
    for (const n of report.notes) lines.push(p.dim(`      · ${n}`));
    lines.push("");
  }

  return lines.join("\n");
};

export const renderI18n = (
  report: import("../core/i18n.ts").I18nReport,
  options: { color?: boolean } = {},
): string => {
  const p = makePalette(options.color ?? true);
  const lines: string[] = [""];

  if (!report.localesPresent) {
    lines.push(p.dim("  No locale files found — this project does not appear to be translated."));
    lines.push(
      p.dim("  (Locale files are JSON under a `locales/`, `i18n/`, `lang/` or `translations/` directory,"),
    );
    lines.push(p.dim("   named for a language tag, whose leaves are all strings.)"));
    lines.push("");
    return lines.join("\n");
  }

  lines.push(
    `  ${p.bold("Locale integrity")}  ${p.dim(
      `${report.localeFiles.length} file(s) · default \`${report.defaultLocale}\` · ${report.summary.keysDefined} key(s)`,
    )}`,
  );
  lines.push("");

  if (report.missingKeys.length > 0) {
    lines.push(`  ${p.red("✖")} ${p.bold("Referenced with no translation")}`);
    for (const m of report.missingKeys.slice(0, 20)) {
      const hint = m.suggestion ? p.dim(`  did you mean \`${m.suggestion}\`?`) : "";
      lines.push(`      ${p.cyan(`${m.normalizedFilePath}:${m.line}`)}  \`${m.key}\`${hint}`);
    }
    if (report.missingKeys.length > 20) {
      lines.push(p.dim(`      … ${report.missingKeys.length - 20} more`));
    }
    lines.push(p.dim("      A key with no entry renders blank — or as the key itself — to the user."));
    lines.push("");
  }

  if (report.placeholderMismatches.length > 0) {
    lines.push(`  ${p.red("✖")} ${p.bold("Placeholder never supplied")}`);
    for (const m of report.placeholderMismatches.slice(0, 20)) {
      lines.push(
        `      ${p.cyan(`${m.normalizedFilePath}:${m.line}`)}  \`${m.key}\` needs ${m.missing
          .map((n) => `\`${n}\``)
          .join(", ")}`,
      );
      lines.push(p.dim(`          "${m.translation}"`));
    }
    if (report.placeholderMismatches.length > 20) {
      lines.push(p.dim(`      … ${report.placeholderMismatches.length - 20} more`));
    }
    lines.push("");
  }

  lines.push(
    p.dim(
      "  Dead translations are deliberately not reported: a key is reachable from `<Trans i18nKey>`,",
    ),
  );
  lines.push(
    p.dim(
      "  from a .vue/.svelte template, from a prop-drilled `t`, and from `$t()` nested inside another",
    ),
  );
  lines.push(p.dim("  string — none of which this can see, and the action on a wrong claim is to delete copy."));
  lines.push("");

  if (report.summary.missing + report.summary.mismatched === 0) {
    lines.push(p.green("  ✔ Every referenced key resolves, and every placeholder is supplied."));
    lines.push("");
  }

  return lines.join("\n");
};

export const renderChangeShape = (
  report: import("../core/change-shape.ts").ChangeShapeReport,
  options: { color?: boolean } = {},
): string => {
  const p = makePalette(options.color ?? true);
  const lines: string[] = [""];

  if (!report.available) {
    lines.push(`  ${p.yellow("●")} Change shapes unavailable — ${report.unavailableReason}.`);
    lines.push(p.dim("    This is not the same as a clean diff."));
    lines.push("");
    return lines.join("\n");
  }

  lines.push(
    `  ${p.bold("Change shapes")}  ${p.dim(`${report.range} · ${report.summary.filesExamined} of ${report.summary.filesChanged} file(s) examined`)}`,
  );
  lines.push("");

  if (report.summary.untrackedFilesNotExamined > 0) {
    lines.push(
      p.yellow(
        `  ● ${report.summary.untrackedFilesNotExamined} untracked file(s) were NOT examined — a working-tree diff cannot see them.`,
      ),
    );
    lines.push("");
  }

  if (report.notes.length === 0) {
    lines.push(p.green("  ✔ No edit in this change set matched a shape worth flagging."));
    lines.push(p.dim("    (This says nothing about whether the code is correct — run a scan for that.)"));
    lines.push("");
    return lines.join("\n");
  }

  for (const note of report.notes) {
    const mark = note.priority === "review-closely" ? p.yellow("⚠") : p.dim("·");
    const where =
      note.line > 0 ? p.cyan(`${note.normalizedFilePath}:${note.line}`) : p.cyan(note.normalizedFilePath);
    lines.push(`  ${mark} ${note.message}`);
    lines.push(`      ${where}  ${p.dim(note.shape)}`);
    lines.push(`      ${p.dim(note.why)}`);
    lines.push("");
  }

  lines.push(
    p.dim(
      `  ${report.summary.reviewClosely} to review closely · ${report.summary.notable} notable. These are shapes, not defects — they raise attention, never a verdict.`,
    ),
  );
  lines.push("");
  return lines.join("\n");
};

export const renderChurn = (
  churn: import("../core/churn.ts").ChurnReport,
  ranked: Array<{ churn: number; finding: { diagnostic: string; normalizedFilePath?: string; line: number; severity: string } }>,
  options: { color?: boolean } = {},
): string => {
  const p = makePalette(options.color ?? true);
  const lines: string[] = [""];

  if (!churn.available) {
    lines.push(`  ${p.yellow("●")} Churn unavailable — ${churn.unavailableReason}.`);
    lines.push(p.dim("    Findings are shown in the analyzer's own order."));
    lines.push("");
  } else {
    lines.push(
      `  ${p.bold("Churn hotspots")}  ${p.dim(`${churn.summary.commitsScanned} commit(s) · ${churn.summary.filesTracked} file(s)`)}`,
    );
    lines.push("");
    for (const f of churn.files.slice(0, 10)) {
      lines.push(
        `      ${p.bold(String(f.score).padStart(3))}  ${p.cyan(f.normalizedFilePath)}  ${p.dim(`${f.commits} commit(s), ${f.authors} author(s)`)}`,
      );
    }
    lines.push("");
    if (churn.refactorMagnets.length > 0) {
      lines.push(`  ${p.bold("Refactor magnets")}  ${p.dim("(source churning far above this project's baseline)")}`);
      for (const f of churn.refactorMagnets) {
        lines.push(`      ${p.yellow("↻")} ${p.cyan(f.normalizedFilePath)}  ${p.dim(`score ${f.score}`)}`);
      }
      lines.push("");
    }
  }

  const withChurn = ranked.filter((r) => r.churn > 0);
  if (ranked.length === 0) {
    lines.push(p.dim("  No findings to rank."));
  } else {
    lines.push(
      `  ${p.bold("Findings by churn")}  ${p.dim(`${ranked.length} finding(s), ${withChurn.length} in changed files`)}`,
    );
    for (const r of ranked.slice(0, 15)) {
      const mark = r.finding.severity === "error" ? p.red("✖") : p.yellow("●");
      lines.push(
        `      ${mark} ${p.dim(String(r.churn).padStart(3))}  ${r.finding.diagnostic}  ${p.cyan(`${r.finding.normalizedFilePath ?? ""}:${r.finding.line}`)}`,
      );
    }
    lines.push("");
    lines.push(
      p.dim("  Churn re-orders findings; it never adds or removes one. A finding in code"),
    );
    lines.push(p.dim("  many hands edited recently is where regressions cluster."));
  }
  lines.push("");
  return lines.join("\n");
};

export const renderArchitecture = (
  report: import("../core/architecture.ts").ArchitectureReport,
  options: { color?: boolean } = {},
): string => {
  const p = makePalette(options.color ?? true);
  const { cycles, layerViolations, hubs, summary } = report;
  const lines: string[] = [""];

  lines.push(
    `  ${p.bold("Architecture")}  ${p.dim(`${summary.modules} module(s) · ${summary.edges} import edge(s)`)}`,
  );
  lines.push("");

  if (cycles.length > 0) {
    lines.push(`  ${p.red("Import cycles")}  ${p.dim("(a runtime hazard: partially-initialized imports)")}`);
    for (const cycle of cycles) {
      lines.push(`      ${p.red("↻")} ${cycle.length} modules`);
      for (const file of cycle.files) lines.push(`          ${p.cyan(file)}`);
    }
    lines.push("");
  }

  if (layerViolations.length > 0) {
    lines.push(`  ${p.yellow("Layer violations")}`);
    for (const v of layerViolations) {
      lines.push(`      ${p.yellow("→")} ${p.cyan(v.from)} ${p.dim(`(${v.fromLayer})`)}`);
      lines.push(`         imports ${p.cyan(v.to)} ${p.dim(`(${v.toLayer})`)}`);
      lines.push(`         ${p.dim(v.reason)}`);
    }
    lines.push("");
  }

  if (hubs.length > 0) {
    lines.push(`  ${p.bold("Hub modules")}  ${p.dim("(every change here has a wide blast radius)")}`);
    for (const hub of hubs) {
      lines.push(`      ${p.cyan(hub.file)}  ${p.dim(`${hub.dependents} dependents`)}`);
    }
    lines.push("");
  }

  if (cycles.length === 0 && layerViolations.length === 0) {
    lines.push(`  ${p.green("✔")} No import cycles and no layer violations.`);
    if (summary.unlayeredModules > 0) {
      lines.push(
        p.dim(
          `  ${summary.unlayeredModules} module(s) sit outside a recognized layer directory and take part in no layer claim.`,
        ),
      );
    }
    lines.push("");
  }
  return lines.join("\n");
};

export const renderOpenApi = (
  result: import("../core/openapi.ts").OpenApiResult,
  options: { color?: boolean; writtenTo?: string } = {},
): string => {
  const p = makePalette(options.color ?? true);
  const { summary, document } = result;
  const lines: string[] = [""];

  lines.push(
    `  ${p.bold("OpenAPI 3.1 spec")}  ${p.dim(`${document.info.title} @${document.info.version}`)}`,
  );
  lines.push("");
  if (options.writtenTo) {
    lines.push(`  ${p.green("✔")} written to ${p.cyan(options.writtenTo)}`);
  }
  lines.push(
    `  ${summary.operations} operation(s) across ${Object.keys(document.paths).length} path(s) · ${summary.securedOperations} secured`,
  );
  if (summary.inferredResponses > 0) {
    lines.push(
      p.dim(
        `  ${summary.inferredResponses} operation(s) documented a default 200 — no explicit status code was readable in the handler.`,
      ),
    );
  }
  if (summary.dynamicRoutesSkipped > 0) {
    lines.push(
      `  ${p.yellow("●")} ${summary.dynamicRoutesSkipped} route(s) skipped — their path is not statically known, so they cannot be documented honestly.`,
    );
  }
  lines.push("");
  return lines.join("\n");
};

export const renderApiSemver = (
  report: import("../core/api-semver.ts").ApiSemverReport,
  options: { color?: boolean } = {},
): string => {
  const p = makePalette(options.color ?? true);
  const lines: string[] = [""];

  if (!report.diff) {
    lines.push(
      `  ${p.bold("Package export surface")}  ${p.dim(`${report.summary.packages} package(s)`)}`,
    );
    lines.push("");
    for (const pkg of report.packages) {
      const tag = pkg.entry === null ? `  ${p.yellow("(entry unresolved — unanalyzed)")}` : pkg.complete ? "" : `  ${p.dim("(partial — a re-export could not be followed)")}`;
      lines.push(`  ${p.bold(pkg.name)}${pkg.version ? p.dim(" @" + pkg.version) : ""}${tag}`);
      if (pkg.entry !== null) {
        lines.push(`      ${p.dim(`${pkg.exports.length} export(s) from ${pkg.entry}`)}`);
      }
    }
    lines.push("");
    lines.push(p.dim("  Run with --baseline <file> to snapshot, then re-run to lint version bumps."));
    lines.push("");
    return lines.join("\n");
  }

  lines.push(`  ${p.bold("Package API semver")}  ${p.dim(`${report.summary.packages} package(s) vs baseline`)}`);
  lines.push("");
  for (const v of report.diff.verdicts) {
    if (v.removed.length === 0 && v.added.length === 0 && v.verdict === "ok") continue;
    const badge =
      v.verdict === "breaking-without-major"
        ? p.red("✖ breaking without a major bump")
        : v.verdict === "minor-expected"
          ? p.yellow("● additions — a minor bump is expected")
          : v.verdict === "unprovable"
            ? p.dim("○ unprovable (partial surface or missing version)")
            : p.green("✔ ok");
    lines.push(`  ${p.bold(v.package)}  ${p.dim(`${v.baseVersion ?? "?"} → ${v.currentVersion ?? "?"}`)}  ${badge}`);
    for (const n of v.removed) lines.push(`      ${p.red("− removed")}  ${n}`);
    for (const n of v.added) lines.push(`      ${p.green("+ added")}    ${n}`);
  }
  const pkgChanges = report.diff.changes.filter((c) => c.kind === "removed-package" || c.kind === "added-package");
  for (const c of pkgChanges) {
    lines.push(
      c.kind === "removed-package"
        ? `  ${p.bold(c.package)}  ${p.yellow("package removed from the workspace (breaking for its consumers)")}`
        : `  ${p.bold(c.package)}  ${p.dim("new package")}`,
    );
  }
  if (report.diff.verdicts.every((v) => v.verdict === "ok") && pkgChanges.length === 0) {
    lines.push(p.dim("  No surface changes against the baseline."));
  }
  lines.push("");
  if (report.summary.breaking > 0) {
    lines.push(`  ${p.red("✖")} ${report.summary.breaking} package(s) shipped a breaking export removal without the semver bump to match.`);
    lines.push("");
  }
  return lines.join("\n");
};

export const renderQueueTopology = (
  report: import("../core/queue-topology.ts").QueueTopologyReport,
  options: { color?: boolean } = {},
): string => {
  const p = makePalette(options.color ?? true);
  const lines: string[] = [""];

  if (report.topics.length === 0 && report.unresolvedPublishes === 0 && report.unresolvedSubscribes === 0) {
    lines.push(p.dim("  No queue/topic usage found — nothing to map."));
    lines.push("");
    return lines.join("\n");
  }

  lines.push(
    `  ${p.bold("Queue & topic topology")}  ${p.dim(
      `${report.summary.topics} topic(s) · ${report.summary.publishers} publisher site(s) · ${report.summary.consumers} consumer site(s)`,
    )}`,
  );
  lines.push("");

  for (const t of report.topics) {
    const badge =
      report.orphanTopics.includes(t.name) && t.publishers.length > 0
        ? `  ${p.red("⚠ no consumer")}`
        : report.deadConsumers.includes(t.name)
          ? `  ${p.yellow("⚠ no publisher")}`
          : report.loops.includes(t.name)
            ? `  ${p.dim("↻ same-file loop")}`
            : "";
    lines.push(`  ${p.bold(t.name)}  ${p.dim(`[${t.system}]`)}${badge}`);
    for (const s of t.publishers) {
      lines.push(`      ${p.dim("→ publish")}  ${p.cyan(`${s.normalizedFilePath}:${s.line}`)}`);
    }
    for (const s of t.consumers) {
      lines.push(`      ${p.dim("← consume")}  ${p.cyan(`${s.normalizedFilePath}:${s.line}`)}`);
    }
  }
  lines.push("");

  if (report.orphanTopics.length > 0) {
    lines.push(`  ${p.red("✖")} ${report.orphanTopics.length} orphan topic(s) — published, never consumed (messages into the void).`);
  }
  if (report.deadConsumers.length > 0) {
    lines.push(`  ${p.yellow("●")} ${report.deadConsumers.length} dead consumer topic(s) — subscribed, nothing publishes.`);
  }
  if (report.claimQuality.orphanTopics !== "full") {
    lines.push(p.dim(`  Orphan-topic claims suppressed: ${report.unresolvedSubscribes} dynamic subscribe(s) could consume anything.`));
  }
  if (report.claimQuality.deadConsumers !== "full") {
    lines.push(p.dim(`  Dead-consumer claims suppressed: ${report.unresolvedPublishes} dynamic publish(es) could feed anything.`));
  }
  lines.push("");
  return lines.join("\n");
};

export const renderSchemaDrift = (
  report: import("../core/schema-drift.ts").SchemaDriftReport,
  options: { color?: boolean } = {},
): string => {
  const p = makePalette(options.color ?? true);
  const lines: string[] = [""];

  if (!report.schemaPresent) {
    lines.push(p.dim("  No .prisma schema found — nothing to cross-check."));
    lines.push("");
    return lines.join("\n");
  }

  lines.push(
    `  ${p.bold("Schema ↔ code cross-check")}  ${p.dim(
      `${report.models} model(s), ${report.enums} enum(s) · ${report.summary.filesScanned} file(s) scanned`,
    )}`,
  );
  lines.push("");

  // Drift: code → fields the schema does not have. The actionable half.
  if (report.drift.length === 0) {
    lines.push(`  ${p.green("✓")} No schema drift — every referenced field exists.`);
  } else {
    lines.push(`  ${p.bold("Schema drift")}  ${p.dim("(code references a field the schema does not define)")}`);
    for (const d of report.drift) {
      const hint = d.suggestion ? `  ${p.dim(`— did you mean \`${d.suggestion}\`?`)}` : "";
      lines.push(
        `  ${p.red("✖")} ${p.bold(`${d.model}.${d.key}`)} ${p.dim(`in ${d.section}`)}  ${p.cyan(
          `${d.normalizedFilePath}:${d.line}:${d.column}`,
        )}${hint}`,
      );
    }
  }
  lines.push("");

  // Dead models — only when provable.
  if (report.deadModelDetection !== "full") {
    lines.push(
      p.dim(
        report.deadModelDetection === "skipped-dynamic-access"
          ? "  Dead-model detection skipped: dynamic model access (client[expr]) present."
          : "  Dead-model detection skipped: unresolved raw SQL present.",
      ),
    );
  } else if (report.deadModels.length === 0) {
    lines.push(`  ${p.green("✓")} Every model is referenced by code.`);
  } else {
    lines.push(`  ${p.bold("Dead models")}  ${p.dim("(no code path touches them)")}`);
    for (const d of report.deadModels) {
      const table = d.tableName === d.model ? "" : p.dim(` (table ${d.tableName})`);
      lines.push(`  ${p.yellow("●")} ${p.bold(d.model)}${table}  ${p.dim(`${d.fieldCount} column(s)`)}`);
    }
  }
  lines.push("");

  lines.push(
    p.dim(
      `  ${report.summary.driftFindings} drift finding(s) · ${report.summary.modelsUsed}/${report.models} model(s) used` +
        (report.deadModelDetection === "full" ? ` · ${report.summary.deadModels} dead` : ""),
    ),
  );
  lines.push("");
  return lines.join("\n");
};

export const renderDataMap = (
  map: import("../core/data-map.ts").DataAccessMap,
  options: { color?: boolean } = {},
): string => {
  const p = makePalette(options.color ?? true);
  const lines: string[] = [""];

  if (map.routes.length === 0) {
    lines.push(p.dim("  No routes found — nothing to map."));
    lines.push("");
    return lines.join("\n");
  }
  if (map.entities.length === 0) {
    lines.push(
      `  ${p.bold("Data access map")} — ${map.summary.routes} route(s), no resolvable database access.`,
    );
    if (map.summary.unresolvedQueries > 0) {
      lines.push(
        p.dim(`  (${map.summary.unresolvedQueries} query call(s) recognized but their entity could not be resolved.)`),
      );
    }
    lines.push("");
    return lines.join("\n");
  }

  // Per-route lineage.
  lines.push(`  ${p.bold("Routes → entities")}  ${p.dim("(r read · w write · d delete)")}`);
  lines.push("");
  for (const r of map.routes) {
    lines.push(`  ${p.bold(`${r.method} ${r.path}`)}  ${p.cyan(`${r.normalizedFilePath}:${r.line}`)}`);
    if (r.entities.length === 0) {
      lines.push(`      ${p.dim("(no database access)")}`);
    } else {
      for (const e of r.entities) {
        lines.push(`      ${opMarkers(e.ops, p)}  ${e.entity}`);
      }
    }
  }
  lines.push("");

  // Inverse index: entity → the routes that touch it.
  lines.push(`  ${p.bold("Entities → routes")}`);
  lines.push("");
  for (const e of map.entities) {
    lines.push(`  ${opMarkers(e.ops, p)}  ${p.bold(e.entity)}  ${p.dim(`(${e.routes.length} route(s))`)}`);
    for (const rt of e.routes) {
      lines.push(`      ${p.dim(`${rt.method} ${rt.path}`)}`);
    }
  }
  lines.push("");

  lines.push(
    p.dim(
      `  ${map.summary.routes} route(s) · ${map.summary.entities} entit${map.summary.entities === 1 ? "y" : "ies"}` +
        (map.summary.unresolvedQueries > 0
          ? ` · ${map.summary.unresolvedQueries} unresolved quer${map.summary.unresolvedQueries === 1 ? "y" : "ies"}`
          : ""),
    ),
  );
  lines.push("");
  return lines.join("\n");
};
