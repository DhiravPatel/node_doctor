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

/**
 * Bumped only when the on-disk shape changes incompatibly.
 *   v1 → v2: added `resolvedHistory` (§161). A v1 file still loads — it simply
 *   carries no history yet — so upgrading the tool never invalidates a committed
 *   ratchet, and the first tightening after the upgrade starts recording.
 */
export const RATCHET_SCHEMA_VERSION = 2;

/**
 * How many resolutions the file remembers. The ratchet is committed, so the
 * history cannot grow without bound; the newest entries are the ones that matter
 * (a finding fixed years ago and reintroduced is still caught, but only while it
 * stays inside this window).
 */
export const MAX_RESOLVED_HISTORY = 500;

/** One finding that was observed as fixed, and when. */
export interface ResolvedEntry {
  /** The finding's position-independent `evidenceKey`. */
  key: string;
  /**
   * ISO-8601 date the finding was last seen resolved, or "" when the caller did
   * not supply a clock. The comparison itself never reads a clock — the CLI owns
   * time — so `compareToRatchet` stays a pure function of its inputs.
   */
  resolvedAt: string;
  /** The tool version that observed the fix, for forensics on a stale entry. */
  toolVersion: string;
}

export interface RatchetFile {
  schemaVersion: number;
  toolVersion: string;
  /**
   * The ruleset the baseline was measured with. A finding that is absent because
   * FEWER RULES RAN was never fixed — recording it as resolved poisons the
   * history and makes every later full scan report a false regression. Comparing
   * this against the current scan's hash is what makes "absent" mean "fixed".
   */
  rulesetHash: string;
  score: number;
  counts: { error: number; warn: number };
  /** Accepted debt: the evidenceKey of every finding present when the ratchet was set. */
  accepted: string[];
  /**
   * §161 — findings this project has previously fixed. A finding whose key is in
   * here and which is present again has REGRESSED: the fix was reverted, lost in
   * a merge, or reintroduced by a copy-paste.
   */
  resolvedHistory: ResolvedEntry[];
}

/** A finding that was fixed once and has come back. */
export interface RegressedFinding {
  finding: Finding;
  /** When it was previously observed as fixed ("" if that run had no clock). */
  previouslyResolvedAt: string;
  /** The tool version that recorded the fix. */
  previouslyResolvedBy: string;
}

export interface RatchetComparison {
  /** Findings with no unconsumed accepted entry — the debt this change added. */
  introduced: Finding[];
  /**
   * §161 — the subset of `introduced` that this project had already fixed. Not a
   * separate failure mode: a regressed finding is introduced debt and fails the
   * ratchet on that basis alone. This is the *explanation*, which is the part
   * that changes behaviour ("you fixed this in March; it's back").
   */
  regressed: RegressedFinding[];
  /** Accepted entries no longer present — the debt this change paid off. */
  resolved: number;
  /** The evidence keys behind `resolved`, sorted. The caller stamps them with a
   *  clock and folds them into the next ratchet's history. */
  resolvedKeys: string[];
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
  /**
   * False when this scan was not strong enough evidence to record fixes — a
   * different ruleset ran, or the scan did not complete. The comparison still
   * reports pass/fail; it simply refuses to write history it cannot stand behind.
   */
  recordedResolutions: boolean;
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

/**
 * Merge newly-resolved keys into a history, newest-wins per key, capped at
 * `MAX_RESOLVED_HISTORY`. Pure: the caller supplies `at` (and may supply "" when
 * it has no clock), so the same inputs always produce the same history.
 *
 * Ordering: dedupe by key, keep the most recent, then sort by key so the
 * committed file is byte-identical however it was assembled.
 */
export const recordResolutions = (
  history: readonly ResolvedEntry[],
  resolvedKeys: readonly string[],
  at: string,
  version: string = toolVersion(),
): ResolvedEntry[] => {
  const added = new Set(resolvedKeys);
  const byKey = new Map<string, ResolvedEntry>();
  for (const entry of history) byKey.set(entry.key, entry);
  for (const key of resolvedKeys) byKey.set(key, { key, resolvedAt: at, toolVersion: version });

  // Entries recorded in THIS call are never evicted: an undated resolution
  // (`at === ""`) would otherwise sort oldest and be dropped by the very call
  // that created it, silently losing the fact we just learned.
  const fresh: ResolvedEntry[] = [];
  const prior: ResolvedEntry[] = [];
  for (const entry of byKey.values()) (added.has(entry.key) ? fresh : prior).push(entry);

  const byRecency = (a: ResolvedEntry, b: ResolvedEntry): number =>
    a.resolvedAt < b.resolvedAt ? 1 : a.resolvedAt > b.resolvedAt ? -1 : a.key < b.key ? -1 : 1;

  return [...fresh.sort(byRecency), ...prior.sort(byRecency)]
    .slice(0, MAX_RESOLVED_HISTORY)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
};

/**
 * Freeze a report as today's accepted debt. `accepted` is sorted for determinism.
 *
 * `priorHistory` is carried forward: re-baselining replaces the ACCEPTED SET, but
 * the record of what this project has previously fixed is independent knowledge
 * and must survive `ratchet init` — dropping it would silently disarm §161.
 */
export const buildRatchet = (
  report: ScanReport,
  priorHistory: readonly ResolvedEntry[] = [],
): RatchetFile => ({
  schemaVersion: RATCHET_SCHEMA_VERSION,
  toolVersion: toolVersion(),
  rulesetHash: report.provenance.rulesetHash,
  score: report.score.score,
  counts: countBySeverity(report.findings),
  accepted: report.findings.map(identityKey).sort(),
  resolvedHistory: recordResolutions(priorHistory, [], ""),
});

/**
 * Judge a scan against a stored ratchet, and offer the tightened successor.
 *
 * `options.now` is the clock the caller owns: when supplied, newly-resolved
 * findings are stamped with it in the tightened ratchet's history. Omitting it
 * keeps the function pure for tests and still carries the existing history
 * forward — a resolution recorded with no date is simply undated, never lost.
 */
export const compareToRatchet = (
  report: ScanReport,
  ratchet: RatchetFile,
  options: { now?: string } = {},
): RatchetComparison => {
  // Unconsumed accepted debt, as a multiset keyed by evidence.
  const pool = new Map<string, number>();
  for (const key of ratchet.accepted) pool.set(key, (pool.get(key) ?? 0) + 1);

  // §161 — what this project has fixed before, for the regression check below.
  const previouslyResolved = new Map<string, ResolvedEntry>();
  for (const entry of ratchet.resolvedHistory) previouslyResolved.set(entry.key, entry);

  // Findings arrive already sorted, so `introduced` is deterministic.
  const introduced: Finding[] = [];
  const regressed: RegressedFinding[] = [];
  for (const f of report.findings) {
    const key = identityKey(f);
    const remaining = pool.get(key) ?? 0;
    if (remaining > 0) {
      pool.set(key, remaining - 1);
      continue;
    }
    introduced.push(f);
    // A boomerang: introduced now, but this exact evidence was fixed before.
    const prior = previouslyResolved.get(key);
    if (prior) {
      regressed.push({
        finding: f,
        previouslyResolvedAt: prior.resolvedAt,
        previouslyResolvedBy: prior.toolVersion,
      });
    }
  }

  // A key is only genuinely gone when NO copy of it is present now. With 3
  // accepted and 2 present, one pool entry is left over — but the evidence is
  // still in the code, so recording it as fixed would fabricate a later
  // regression the moment the third copy returns.
  const presentKeys = new Set(report.findings.map(identityKey));

  const resolvedKeys: string[] = [];
  for (const [key, remaining] of pool) {
    for (let i = 0; i < remaining; i++) resolvedKeys.push(key);
  }
  resolvedKeys.sort();
  const resolved = resolvedKeys.length;

  /**
   * Is this scan strong enough evidence that the missing findings were FIXED?
   *
   * A finding also disappears when fewer rules ran (`--ignore-tag`, a config
   * change, a narrower diagnostic set) or when the scanner could not read the
   * file at all. Both look identical to a fix in `report.findings`, and both
   * previously poisoned the committed history into permanent false "previously
   * fixed, and back" claims. So a resolution is recorded only from a scan that
   * ran the SAME ruleset and completed cleanly.
   */
  const comparableRuleset = ratchet.rulesetHash === "" || ratchet.rulesetHash === report.provenance.rulesetHash;
  const completeScan = report.project.complete;
  const canRecordResolutions = comparableRuleset && completeScan;

  // A finding silenced by an inline `node-doctor-disable` directive is absent
  // from `findings` for exactly the same reason a fixed one is — but it was not
  // repaired, it was acknowledged. Recording it as fixed would report a false
  // regression the day someone removes the directive.
  const suppressedNow = new Set(report.project.suppressedKeys ?? []);

  const scoreDelta = report.score.score - ratchet.score;
  const passed = introduced.length === 0 && scoreDelta >= 0;

  // Strictly better: nothing new, no score regression, and real debt paid off.
  // `Math.max` states the floor invariant locally rather than relying on the
  // caller's reading of `scoreDelta >= 0`. The history is carried forward and
  // extended — it is the whole point of the file, and must survive tightening.
  const tightened: RatchetFile | null =
    passed && resolved > 0 && canRecordResolutions
      ? {
          ...buildRatchet(report),
          score: Math.max(report.score.score, ratchet.score),
          resolvedHistory: recordResolutions(
            ratchet.resolvedHistory,
            // Dedupe (N copies resolved is one fact), and record only keys with
            // no surviving copy in the current scan.
            [...new Set(resolvedKeys)].filter((k) => !presentKeys.has(k) && !suppressedNow.has(k)),
            options.now ?? "",
          ),
        }
      : null;

  return {
    introduced,
    regressed,
    resolved,
    resolvedKeys,
    scoreDelta,
    passed,
    tightened,
    recordedResolutions: canRecordResolutions,
  };
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
  if (r.rulesetHash !== undefined && typeof r.rulesetHash !== "string") return false;
  if (!Array.isArray(r.accepted) || r.accepted.some((k) => typeof k !== "string")) return false;
  // `resolvedHistory` is absent in a v1 file — that is valid, not corrupt. When
  // present it must be well-formed; a mangled history would fabricate a
  // "regression" claim, which is exactly the kind of wrong statement this tool
  // must never make, so a bad entry rejects the whole file.
  if (r.resolvedHistory !== undefined) {
    if (!Array.isArray(r.resolvedHistory)) return false;
    for (const e of r.resolvedHistory) {
      if (!e || typeof e !== "object" || Array.isArray(e)) return false;
      const entry = e as Partial<ResolvedEntry>;
      if (typeof entry.key !== "string" || entry.key.length === 0) return false;
      if (typeof entry.resolvedAt !== "string") return false;
      if (typeof entry.toolVersion !== "string") return false;
    }
  }
  return true;
};

/** Normalize a loaded history: dedupe by key, sorted, capped. */
const normalizeHistory = (entries: readonly ResolvedEntry[] | undefined): ResolvedEntry[] =>
  entries === undefined ? [] : recordResolutions(entries, [], "");

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
    // A v1 file is upgraded in memory; it is only rewritten when the ratchet
    // tightens, so merely running against an old file never churns the diff.
    schemaVersion: RATCHET_SCHEMA_VERSION,
    toolVersion: parsed.toolVersion,
    // Absent in v1: "" means "unknown ruleset", which never blocks a comparison.
    rulesetHash: typeof parsed.rulesetHash === "string" ? parsed.rulesetHash : "",
    score: parsed.score,
    counts: { error: parsed.counts.error, warn: parsed.counts.warn },
    accepted: parsed.accepted.slice().sort(),
    resolvedHistory: normalizeHistory(parsed.resolvedHistory),
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
    rulesetHash: ratchet.rulesetHash ?? "",
    score: ratchet.score,
    counts: { error: ratchet.counts.error, warn: ratchet.counts.warn },
    accepted: ratchet.accepted.slice().sort(),
    resolvedHistory: normalizeHistory(ratchet.resolvedHistory),
  };
  const dir = dirname(path);
  if (dir && dir !== path) await mkdir(dir, { recursive: true });
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
};
