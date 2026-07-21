/**
 * Baseline delta — the top adoption feature (§13). Given a baseline report and a
 * current report, return only the findings the change *introduced* (and, for
 * context, those it *resolved*).
 *
 * Identity is **evidence-based**: a finding matches across the two scans by its
 * `evidenceKey` (diagnostic + message + the triggering code), so moving code to
 * a new line or a new file does NOT read as a new finding — only a genuinely new
 * defect is "introduced". Matching runs same-file-first, then cross-file, over a
 * multiset so N copies map to N copies. Reports without `evidenceKey` (older
 * schema) fall back to the positional `id`.
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

const identityKey = (f: Finding): string => f.evidenceKey ?? f.id;

export const computeDelta = (
  baseline: ReportLike | Finding[],
  current: ReportLike | Finding[],
): DeltaResult => {
  const baselineDiags = asDiagnostics(baseline);
  const currentDiags = asDiagnostics(current);

  // Multiset of unconsumed baseline findings, grouped by identity key. Within a
  // key, keep the file path so we can prefer a same-file match first.
  const pool = new Map<string, Finding[]>();
  for (const f of baselineDiags) {
    const list = pool.get(identityKey(f)) ?? [];
    list.push(f);
    pool.set(identityKey(f), list);
  }

  const consume = (key: string, sameFileAs?: string): boolean => {
    const list = pool.get(key);
    if (!list || list.length === 0) return false;
    // Prefer a baseline finding in the same file (a pure line shift), else any.
    const idx = sameFileAs === undefined ? 0 : Math.max(0, list.findIndex((f) => f.normalizedFilePath === sameFileAs));
    const at = idx === -1 ? 0 : idx;
    list.splice(at, 1);
    return true;
  };

  const introduced: Finding[] = [];
  // Pass 1: same-file matches. Pass 2: cross-file for whatever is left.
  const unmatched: Finding[] = [];
  for (const f of currentDiags) {
    const key = identityKey(f);
    const list = pool.get(key);
    if (list && list.some((b) => b.normalizedFilePath === f.normalizedFilePath)) {
      consume(key, f.normalizedFilePath);
    } else {
      unmatched.push(f);
    }
  }
  for (const f of unmatched) {
    if (!consume(identityKey(f))) introduced.push(f);
  }

  // Whatever baseline findings remain in the pool were resolved by the change.
  const resolved: Finding[] = [];
  for (const list of pool.values()) resolved.push(...list);

  return { introduced, resolved };
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
