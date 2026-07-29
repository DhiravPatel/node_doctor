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

  const routes = report.routeBearingFiles.length;
  lines.push(
    `  ${p.bold(String(report.reachedCount))} file(s) transitively depend on this change` +
      (routes > 0 ? `, including ${p.bold(String(routes))} that register routes:` : ":"),
  );
  lines.push("");
  for (const d of report.dependents) {
    const marker = d.hasHandlers ? p.yellow("[route]") : "       ";
    lines.push(`  ${marker} ${p.dim(`d${d.depth}`)} ${d.normalizedFilePath}`);
  }
  lines.push("");
  if (routes > 0) {
    lines.push(p.dim(`  Review the ${routes} route-bearing file(s) first — their responses can change.`));
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
