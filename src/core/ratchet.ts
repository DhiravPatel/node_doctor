/**
 * Baseline ratchet (§87) — the adoption path for a codebase that cannot fix its
 * debt today. A team pins the current findings as an *accepted baseline*, and
 * from then on the build fails on findings the change actually introduced — plus
 * a score that fell below the pinned floor, which is the other half of the
 * ratchet: neither the finding set nor the score may move backwards.
 *
 * What makes it a ratchet rather than a mute button: the threshold may move only
 * in the improving direction. When a scan is strictly better than the baseline —
 * nothing new, score not lower, and something genuinely fixed — this module hands
 * back a *tightened* ratchet with the resolved entries dropped and the score floor
 * raised. Debt that is paid off can never be silently re-incurred.
 *
 * Identity is evidence-based, exactly as in the baseline delta (§13): a finding is
 * matched by its position-independent `evidenceKey`, so reformatting, a line shift,
 * or moving code to another file never reads as new debt. Matching runs over a
 * multiset, so N accepted copies absolve exactly N present copies — the (N+1)th is
 * introduced.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Finding } from "./types.ts";
import type { ScanReport } from "./scan.ts";
import { toolVersion } from "./version.ts";

/** The sidecar the ratchet lives in, at the project root. */
export const RATCHET_FILENAME = ".node-doctor-ratchet.json";

/** Bumped only when the on-disk shape changes incompatibly. */
export const RATCHET_SCHEMA_VERSION = 1;

export interface RatchetFile {
  schemaVersion: number;
  toolVersion: string;
  score: number;
  counts: { error: number; warn: number };
  /** Accepted debt: the evidenceKey of every finding present when the ratchet was set. */
  accepted: string[];
}

export interface RatchetComparison {
  /** Findings with no unconsumed accepted entry — the debt this change added. */
  introduced: Finding[];
  /** Accepted entries no longer present — the debt this change paid off. */
  resolved: number;
  /** Current score minus the ratchet's score floor. Negative means regression. */
  scoreDelta: number;
  /** False when anything was introduced, or the score fell below the floor. */
  passed: boolean;
  /**
   * The tighter ratchet the caller should write when the scan is strictly better.
   * Null otherwise — the ratchet never loosens, so a passing-but-unchanged scan
   * (and every failing scan) leaves the stored baseline exactly as it was.
   */
  tightened: RatchetFile | null;
}

/**
 * Position-independent identity, mirroring `computeDelta`. Reports written by an
 * older schema carry no `evidenceKey`; those fall back to the positional id.
 */
const identityKey = (f: Finding): string => f.evidenceKey ?? f.id;

const countBySeverity = (findings: readonly Finding[]): { error: number; warn: number } => {
  let error = 0;
  let warn = 0;
  for (const f of findings) {
    if (f.severity === "error") error += 1;
    else warn += 1;
  }
  return { error, warn };
};

/** Freeze a report as today's accepted debt. `accepted` is sorted for determinism. */
export const buildRatchet = (report: ScanReport): RatchetFile => ({
  schemaVersion: RATCHET_SCHEMA_VERSION,
  toolVersion: toolVersion(),
  score: report.score.score,
  counts: countBySeverity(report.findings),
  accepted: report.findings.map(identityKey).sort(),
});

/** Judge a scan against a stored ratchet, and offer the tightened successor. */
export const compareToRatchet = (report: ScanReport, ratchet: RatchetFile): RatchetComparison => {
  // Unconsumed accepted debt, as a multiset keyed by evidence.
  const pool = new Map<string, number>();
  for (const key of ratchet.accepted) pool.set(key, (pool.get(key) ?? 0) + 1);

  // Findings arrive already sorted, so `introduced` is deterministic.
  const introduced: Finding[] = [];
  for (const f of report.findings) {
    const key = identityKey(f);
    const remaining = pool.get(key) ?? 0;
    if (remaining > 0) pool.set(key, remaining - 1);
    else introduced.push(f);
  }

  let resolved = 0;
  for (const remaining of pool.values()) resolved += remaining;

  const scoreDelta = report.score.score - ratchet.score;
  const passed = introduced.length === 0 && scoreDelta >= 0;

  // Strictly better: nothing new, no score regression, and real debt paid off.
  // `Math.max` states the floor invariant locally rather than relying on the
  // caller's reading of `scoreDelta >= 0`.
  const tightened: RatchetFile | null =
    passed && resolved > 0
      ? { ...buildRatchet(report), score: Math.max(report.score.score, ratchet.score) }
      : null;

  return { introduced, resolved, scoreDelta, passed, tightened };
};

const isPopulation = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0;

/** Shape guard — a hand-edited or newer-schema file is rejected, not half-trusted. */
const isRatchetFile = (value: unknown): value is RatchetFile => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Partial<RatchetFile>;
  if (!Number.isInteger(r.schemaVersion)) return false;
  if (r.schemaVersion! < 1 || r.schemaVersion! > RATCHET_SCHEMA_VERSION) return false;
  if (typeof r.toolVersion !== "string") return false;
  if (typeof r.score !== "number" || !Number.isFinite(r.score)) return false;
  if (!r.counts || typeof r.counts !== "object" || Array.isArray(r.counts)) return false;
  // Counts are populations, so a fraction or a negative is not a "close enough"
  // value to round — it is proof the file was hand-edited or machine-mangled.
  if (!isPopulation(r.counts.error) || !isPopulation(r.counts.warn)) return false;
  if (!Array.isArray(r.accepted) || r.accepted.some((k) => typeof k !== "string")) return false;
  return true;
};

/**
 * Load a ratchet. Returns null when the file is absent, unreadable, not JSON, or
 * not a ratchet — "no ratchet configured" and "corrupt ratchet" are the same
 * decision for the caller (scan normally), and neither should crash a build.
 */
export const readRatchet = async (path: string): Promise<RatchetFile | null> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
  if (!isRatchetFile(parsed)) return null;
  return {
    schemaVersion: parsed.schemaVersion,
    toolVersion: parsed.toolVersion,
    score: parsed.score,
    counts: { error: parsed.counts.error, warn: parsed.counts.warn },
    accepted: parsed.accepted.slice().sort(),
  };
};

/**
 * Persist a ratchet. Keys are written in a fixed order and `accepted` re-sorted,
 * so the same ratchet is byte-identical however it was assembled — the file is
 * committed, and a noisy diff would make review worthless.
 */
export const writeRatchet = async (path: string, ratchet: RatchetFile): Promise<void> => {
  const body: RatchetFile = {
    schemaVersion: ratchet.schemaVersion,
    toolVersion: ratchet.toolVersion,
    score: ratchet.score,
    counts: { error: ratchet.counts.error, warn: ratchet.counts.warn },
    accepted: ratchet.accepted.slice().sort(),
  };
  const dir = dirname(path);
  if (dir && dir !== path) await mkdir(dir, { recursive: true });
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
};
