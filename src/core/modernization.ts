/**
 * Modernization score (§85).
 *
 * The health score answers "is this code correct?". This answers a different
 * question — "how far behind current practice is it?" — because they diverge: a
 * codebase can be entirely correct and still be built on `new Buffer`, callbacks,
 * and a Node version that left support two years ago. Tracking it separately
 * gives a team a number that goes *up* as they modernize, which the health score
 * won't show once it is already at 100.
 *
 * Computed from the same findings as everything else, so it costs no extra pass.
 */

import type { Finding } from "./types.ts";

/** Diagnostics that indicate legacy practice rather than a defect. */
const MODERNIZATION_TAGS = new Set(["modernization", "deprecation"]);

export interface ModernizationReport {
  /** 0–100, where 100 means nothing legacy was detected. */
  score: number;
  label: "current" | "aging" | "legacy";
  /** Legacy signals found, most frequent first. */
  signals: Array<{ diagnostic: string; count: number; title: string }>;
  /** Node major from `engines`, when declared. */
  declaredNodeMajor: number | null;
  notes: string[];
}

/** Node majors still receiving security updates matter more than the newest. */
const OLDEST_SUPPORTED_NODE = 20;

export const buildModernizationReport = (
  findings: Finding[],
  capabilities: readonly string[],
  totalLines: number,
  /** False when files failed to parse — never assert "clean" over an unread tree (§5.6). */
  complete = true,
): ModernizationReport => {
  const legacy = findings.filter((f) => f.tags.some((t) => MODERNIZATION_TAGS.has(t)));

  const byDiagnostic = new Map<string, { count: number; title: string }>();
  for (const f of legacy) {
    const entry = byDiagnostic.get(f.diagnostic) ?? { count: 0, title: f.title };
    entry.count += 1;
    byDiagnostic.set(f.diagnostic, entry);
  }
  const signals = [...byDiagnostic.entries()]
    .map(([diagnostic, v]) => ({ diagnostic, count: v.count, title: v.title }))
    .sort((a, b) => b.count - a.count || (a.diagnostic < b.diagnostic ? -1 : 1));

  const notes: string[] = [];

  // Density, so a large codebase is not punished for being large.
  const perKLoc = totalLines > 0 ? (legacy.length / totalLines) * 1000 : 0;
  let score = Math.max(0, 100 - perKLoc * 12);

  const nodeCap = capabilities.find((c) => c.startsWith("node:"));
  const declaredNodeMajor = nodeCap ? Number(nodeCap.slice("node:".length)) : null;
  if (declaredNodeMajor !== null && Number.isFinite(declaredNodeMajor)) {
    if (declaredNodeMajor < OLDEST_SUPPORTED_NODE) {
      // An unsupported runtime is a bigger modernization debt than any single API.
      score -= 25;
      notes.push(
        `engines.node targets Node ${declaredNodeMajor}, which is past end-of-life — upgrade to ${OLDEST_SUPPORTED_NODE}+ for security updates.`,
      );
    }
  } else {
    notes.push("No `engines.node` declared — pin a supported Node major so the runtime is explicit.");
  }

  if (legacy.length === 0 && notes.length === 0) {
    notes.push(
      complete
        ? "No legacy APIs or patterns detected."
        : "No legacy APIs detected in the files that parsed — coverage is incomplete.",
    );
  }

  const rounded = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score: rounded,
    label: rounded >= 85 ? "current" : rounded >= 60 ? "aging" : "legacy",
    signals,
    declaredNodeMajor: Number.isFinite(declaredNodeMajor as number) ? declaredNodeMajor : null,
    notes,
  };
};
