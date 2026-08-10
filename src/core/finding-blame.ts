/**
 * §42 — finding blame: how old is each finding, and who last touched the line?
 *
 * The catalog filed blame analysis as **Vision**. Like §110's attribution, the
 * blocker was infrastructure rather than undecidability, and it lifted: §159/
 * §160/§163 brought `git-history.ts`, §110 added a porcelain blame parser, and
 * that is the whole dependency. No network, no model, byte-identical output.
 *
 * WHY AGE IS THE USEFUL AXIS. A finding list answers "what is wrong". It does
 * not answer the question every team actually asks first, which is **"is this
 * new?"** A hardcoded credential introduced last Tuesday is an incident; the
 * same finding untouched for three years is debt, and the two deserve opposite
 * responses. `churn` (§160) ranks by where change concentrates and `drift`
 * (§104) explains why a report moved; neither tells you the age of a specific
 * finding, which is the input to triage.
 *
 * WHAT IT MEASURES, EXACTLY — and the distinction is the whole precision story.
 * `git blame` reports the commit that **last touched** a line. That is not the
 * same as the commit that INTRODUCED the finding, and this report never claims
 * it is:
 *
 *   - a reformat, a rename, or an unrelated edit on the same line re-attributes
 *     it, so a genuinely old finding can look new;
 *   - `-w` is passed, so a whitespace-only change does not re-attribute — but
 *     that only covers the cheapest case;
 *   - a finding on a line moved wholesale by a refactor dates from the refactor.
 *
 * So every surface says "last touched", and the age is a **lower bound** on how
 * long the finding has existed. Reporting it as "introduced" would be inventing
 * a precision `git blame` does not have — the same error §110 avoids by saying
 * "declared" rather than "written by".
 *
 * A shallow checkout suppresses the whole thing rather than reporting a
 * boundary-commit date for every line, because `actions/checkout` clones with
 * `--depth 1` by default and a report that dated every finding to the same
 * afternoon would be worse than no report.
 */

import { gitContext, gitStdout, blameFile, UNCOMMITTED_SHA } from "./git-history.ts";
import type { BlameCommit } from "./git-history.ts";
import type { NodeDoctorConfig } from "./config.ts";

/** A finding, reduced to what blame needs. */
export interface BlameableFinding {
  diagnostic: string;
  normalizedFilePath: string;
  line: number;
  severity: string;
  message?: string;
}

export interface BlamedFinding extends BlameableFinding {
  /**
   * The commit that last touched this line, or null when git could not
   * attribute it — an uncommitted edit, or a file outside the repository.
   */
  commit: BlameCommit | null;
  /** Whole days since that commit, or null when unattributed. */
  ageDays: number | null;
  /** True when the line has local, uncommitted changes. */
  uncommitted: boolean;
}

export interface AuthorSummary {
  author: string;
  findings: number;
}

export interface FindingBlameReport {
  available: boolean;
  unavailableReason: string | null;
  /** True on a shallow checkout; ages are then suppressed, not guessed. */
  historyTruncated: boolean;
  /** Every finding, oldest last-touch first, so the tail is what is new. */
  findings: BlamedFinding[];
  /** Findings whose line was last touched within `recentDays`. */
  recent: BlamedFinding[];
  /** Who last touched the most finding-bearing lines. Not blame in the moral sense. */
  authors: AuthorSummary[];
  summary: {
    findingsChecked: number;
    attributed: number;
    uncommitted: number;
    recentDays: number;
    recent: number;
    medianAgeDays: number | null;
    oldestAgeDays: number | null;
  };
}

/** Is this checkout shallow? Blame would then date everything to the graft. */
const isShallow = async (cwd: string): Promise<boolean> =>
  (await gitStdout(cwd, ["rev-parse", "--is-shallow-repository"]))?.trim() === "true";

const DAY_MS = 86_400_000;

export const buildFindingBlameReport = async (
  rootDirectory: string,
  options: {
    config?: NodeDoctorConfig;
    findings?: readonly BlameableFinding[];
    /** How recent counts as recent. Default 30 days. */
    recentDays?: number;
    /**
     * "Now", as an epoch millisecond value. Injected rather than read from the
     * clock so a report is reproducible and a test is not time-dependent; the
     * CLI supplies it.
     */
    now?: number;
  } = {},
): Promise<FindingBlameReport> => {
  const findings = options.findings ?? [];
  const recentDays = options.recentDays ?? 30;

  const empty = (reason: string | null, truncated = false): FindingBlameReport => ({
    available: reason === null && !truncated,
    unavailableReason: reason,
    historyTruncated: truncated,
    findings: [],
    recent: [],
    authors: [],
    summary: {
      findingsChecked: findings.length,
      attributed: 0,
      uncommitted: 0,
      recentDays,
      recent: 0,
      medianAgeDays: null,
      oldestAgeDays: null,
    },
  });

  const context = await gitContext(rootDirectory);
  if (context.unavailable !== null) return empty(context.unavailable);
  if (await isShallow(rootDirectory)) return empty("the checkout is shallow, so every line dates from the graft commit", true);

  const now = options.now ?? Date.now();

  // Group by file so each file is blamed exactly once, however many findings
  // it carries — blame is the expensive part.
  const byFile = new Map<string, BlameableFinding[]>();
  for (const finding of findings) {
    const list = byFile.get(finding.normalizedFilePath);
    if (list) list.push(finding);
    else byFile.set(finding.normalizedFilePath, [finding]);
  }

  const blamed: BlamedFinding[] = [];
  for (const path of [...byFile.keys()].sort()) {
    // `normalizedFilePath` is scan-root-relative; git wants repo-relative.
    const repoRelative = context.prefix ? `${context.prefix}${path}` : path;
    const blame = await blameFile(rootDirectory, repoRelative);
    for (const finding of byFile.get(path) ?? []) {
      if (blame === null) {
        blamed.push({ ...finding, commit: null, ageDays: null, uncommitted: false });
        continue;
      }
      const sha = blame.lineShas[finding.line - 1];
      if (sha === undefined) {
        blamed.push({ ...finding, commit: null, ageDays: null, uncommitted: false });
        continue;
      }
      if (sha === UNCOMMITTED_SHA) {
        blamed.push({ ...finding, commit: null, ageDays: null, uncommitted: true });
        continue;
      }
      const commit = blame.commits.get(sha) ?? null;
      const stamp = commit?.date ? Date.parse(commit.date) : Number.NaN;
      const ageDays = Number.isFinite(stamp) ? Math.max(0, Math.floor((now - stamp) / DAY_MS)) : null;
      blamed.push({ ...finding, commit, ageDays, uncommitted: false });
    }
  }

  // Oldest first, so the tail of the list is what changed recently. Ties break
  // on path then line, so the order is total and the output reproducible.
  blamed.sort(
    (a, b) =>
      (b.ageDays ?? -1) - (a.ageDays ?? -1) ||
      (a.normalizedFilePath < b.normalizedFilePath ? -1 : a.normalizedFilePath > b.normalizedFilePath ? 1 : 0) ||
      a.line - b.line ||
      (a.diagnostic < b.diagnostic ? -1 : a.diagnostic > b.diagnostic ? 1 : 0),
  );

  const ages = blamed.map((f) => f.ageDays).filter((a): a is number => a !== null).sort((x, y) => x - y);
  const medianAgeDays = ages.length === 0 ? null : (ages[Math.floor((ages.length - 1) / 2)] as number);

  const byAuthor = new Map<string, number>();
  for (const f of blamed) {
    if (!f.commit?.author) continue;
    byAuthor.set(f.commit.author, (byAuthor.get(f.commit.author) ?? 0) + 1);
  }
  const authors = [...byAuthor.entries()]
    .map(([author, count]) => ({ author, findings: count }))
    .sort((a, b) => b.findings - a.findings || (a.author < b.author ? -1 : 1));

  const recent = blamed.filter((f) => f.ageDays !== null && f.ageDays <= recentDays);

  return {
    available: true,
    unavailableReason: null,
    historyTruncated: false,
    findings: blamed,
    recent,
    authors,
    summary: {
      findingsChecked: findings.length,
      attributed: blamed.filter((f) => f.commit !== null).length,
      uncommitted: blamed.filter((f) => f.uncommitted).length,
      recentDays,
      recent: recent.length,
      medianAgeDays,
      oldestAgeDays: ages.length === 0 ? null : (ages[ages.length - 1] as number),
    },
  };
};
