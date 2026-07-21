/**
 * Markdown reporters — a full-report summary and a baseline-delta summary. Used
 * for `--md-out`, `$GITHUB_STEP_SUMMARY`, and PR comments. Pure and deterministic.
 */

import type { Finding } from "../core/types.ts";
import type { ScanReport } from "../core/scan.ts";

/** Stable marker so a CI job can find and upsert its own PR comment. */
export const SUMMARY_MARKER = "<!-- node-doctor:summary -->";

const SEVERITY_ICON: Record<string, string> = { error: "🔴", warn: "🟡" };
const scoreEmoji = (score: number): string => (score >= 75 ? "🟢" : score >= 50 ? "🟡" : "🔴");

const escapeCell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();

const findingRows = (findings: Finding[], limit = 50): string => {
  const rows = findings
    .slice(0, limit)
    .map(
      (f) =>
        `| ${SEVERITY_ICON[f.severity] ?? ""} ${f.severity} | \`${f.diagnostic}\` | \`${escapeCell(f.normalizedFilePath)}:${f.line}\` | ${escapeCell(f.message)} |`,
    )
    .join("\n");
  const more = findings.length > limit ? `\n\n…and ${findings.length - limit} more.` : "";
  return `| Severity | Diagnostic | Location | Message |\n| --- | --- | --- | --- |\n${rows}${more}`;
};

/** A full report as Markdown (for `--md-out` / a step summary). */
export const renderReportMarkdown = (report: ScanReport): string => {
  const { project, findings, score } = report;
  const errors = findings.filter((f) => f.severity === "error").length;
  const lines: string[] = [];
  lines.push(`## node.doctor — ${project.name}`);
  lines.push("");
  lines.push(`**${scoreEmoji(score.score)} ${score.score}/100** (${score.label}) · ${errors} error(s) · ${findings.length - errors} warning(s) · ${project.analyzedFileCount} files`);
  lines.push("");
  if (!project.complete) {
    lines.push(`> ⚠️ ${project.parseFailures.length} file(s) could not be parsed — results are incomplete.`);
    lines.push("");
  }
  if (findings.length === 0) {
    lines.push(project.complete ? "✅ No findings." : "No findings in the files that parsed.");
  } else {
    lines.push(findingRows(findings));
  }
  lines.push("");
  return lines.join("\n");
};

export interface DeltaMarkdownOptions {
  projectName?: string;
  headScore?: { score: number; label: string };
}

/** A baseline-delta as Markdown (for a PR comment / step summary). */
export const renderDeltaMarkdown = (
  introduced: Finding[],
  resolved: Finding[],
  options: DeltaMarkdownOptions = {},
): string => {
  const lines: string[] = [SUMMARY_MARKER];
  lines.push(`## node.doctor${options.projectName ? ` — ${options.projectName}` : ""}`);
  lines.push("");
  if (options.headScore) {
    lines.push(`Health score: **${scoreEmoji(options.headScore.score)} ${options.headScore.score}/100** (${options.headScore.label})`);
    lines.push("");
  }

  if (introduced.length === 0) {
    lines.push("✅ **No new findings introduced by this change.**");
  } else {
    const errs = introduced.filter((f) => f.severity === "error").length;
    lines.push(`### ⚠️ ${introduced.length} new finding(s) introduced — ${errs} error(s), ${introduced.length - errs} warning(s)`);
    lines.push("");
    lines.push(findingRows(introduced));
  }

  if (resolved.length > 0) {
    lines.push("");
    lines.push(`✅ ${resolved.length} finding(s) resolved by this change.`);
  }
  lines.push("");
  lines.push("<sub>Reports only findings this change introduced (evidence-based baseline delta). Run `npx node-doctor@latest .` locally.</sub>");
  lines.push("");
  return lines.join("\n");
};
