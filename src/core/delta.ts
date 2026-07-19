/**
 * Baseline delta — the top adoption feature (§13). Given a baseline report and a
 * current report, return only the findings the change *introduced* (and, for
 * context, those it *resolved*). Identity is the deterministic finding `id`,
 * so an unchanged finding matches across the two scans.
 */

import type { Finding } from "./types.ts";

export interface DeltaResult {
  introduced: Finding[];
  resolved: Finding[];
}

interface ReportLike {
  findings: Finding[];
}

const asDiagnostics = (input: ReportLike | Finding[]): Finding[] =>
  Array.isArray(input) ? input : input.findings;

/**
 * Diff two reports (or two finding arrays).
 *  - `introduced`: in current, not in baseline.
 *  - `resolved`: in baseline, not in current.
 */
export const computeDelta = (
  baseline: ReportLike | Finding[],
  current: ReportLike | Finding[],
): DeltaResult => {
  const baselineDiags = asDiagnostics(baseline);
  const currentDiags = asDiagnostics(current);

  const baselineIds = new Set(baselineDiags.map((d) => d.id));
  const currentIds = new Set(currentDiags.map((d) => d.id));

  return {
    introduced: currentDiags.filter((d) => !baselineIds.has(d.id)),
    resolved: baselineDiags.filter((d) => !currentIds.has(d.id)),
  };
};

/** Does a delta contain any finding at/above the blocking level? */
export const deltaHasBlocking = (
  introduced: Finding[],
  blocking: "error" | "warning" | "none",
): boolean => {
  if (blocking === "none") return false;
  if (blocking === "warning") return introduced.length > 0;
  return introduced.some((d) => d.severity === "error");
};
