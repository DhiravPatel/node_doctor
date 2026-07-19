/**
 * GitHub Actions workflow-command annotations. Emitting `::error file=…` lines
 * makes findings appear inline on the PR diff. Newlines and reserved characters
 * are escaped per the workflow-command spec.
 */

import type { Finding } from "../core/types.ts";
import type { ScanReport } from "../core/scan.ts";

/** Escape a workflow-command message property value. */
const escapeData = (s: string): string =>
  s.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

/** Escape a workflow-command *property* value (stricter: also `,` and `:`). */
const escapeProp = (s: string): string =>
  escapeData(s).replaceAll(",", "%2C").replaceAll(":", "%3A");

const annotationLine = (d: Finding): string => {
  const level = d.severity === "error" ? "error" : "warning";
  const message = `${d.title}: ${d.message} (node-doctor/${d.diagnostic})`;
  return `::${level} file=${escapeProp(d.normalizedFilePath)},line=${d.line},col=${d.column},title=${escapeProp(`node-doctor/${d.diagnostic}`)}::${escapeData(message)}`;
};

/** Render every finding as a GitHub annotation line. */
export const toAnnotations = (report: ScanReport): string =>
  report.findings.map(annotationLine).join("\n");
