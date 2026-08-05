/**
 * §160 — Line-Age & Churn-Weighted Risk (`node-doctor churn`).
 *
 * A bug in a line written three years ago and never touched since is a different
 * animal from a bug in a line rewritten four times last month. Static analysis
 * treats both identically because it only ever sees the current snapshot; git
 * knows the difference, and the log is already on disk.
 *
 * WHAT THIS ADDS. Two things the snapshot cannot tell you:
 *
 *   1. WHICH FINDINGS MATTER MOST. A finding in code many hands have edited
 *      recently is likelier to be real (churn is where regressions cluster) and
 *      likelier to matter (someone is actively working there). Findings get a
 *      churn-weighted rank — the same findings, ordered by where the risk
 *      actually concentrates.
 *   2. REFACTOR MAGNETS. Files whose change rate is so far above the project's
 *      own baseline that they are begging to be split. Reported as information.
 *
 * PRECISION MODEL. The RANKING cannot produce a false positive by construction:
 * `weightByChurn` returns a permutation of its input, so the worst failure mode
 * is a less useful order — never a wrong claim.
 *
 * The MAGNET list is a different matter, and an adversarial hunt proved it: with
 * a shallow checkout (`actions/checkout` clones `--depth 1` by default) every
 * file has one commit, so every file ties at score 100 and the entire source
 * tree was named "churning far above the baseline". Relative rank carries no
 * information without absolute evidence underneath it. A magnet therefore now
 * requires a real history (not shallow, at least `MAGNET_MIN_COMMITS_SCANNED`
 * commits) and real churn in that file (`MAGNET_MIN_FILE_COMMITS`); when the
 * history is too thin the claim is suppressed and the reason is reported, while
 * ranking keeps working.
 *
 * When git is absent, the directory is not a repository, or the log is empty,
 * every churn value is simply zero and the ranking degrades to the analyzer's
 * own order. A tool that refuses to run outside a git checkout would be worse
 * than one that quietly knows less.
 *
 * Deterministic: the log is read with a fixed format and a fixed window, results
 * are sorted by (score, path), and nothing reads a clock — recency is measured
 * in commits-ago rather than days, so the same repository at the same commit
 * always produces the same output.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** How far back the log is read. Bounded so a deep repository stays fast. */
export const DEFAULT_COMMIT_WINDOW = 500;

/** stdout of a git command, or null when git is missing or the command failed. */
interface GitResult {
  stdout: string | null;
  /** True only when git itself could not be spawned — distinct from a command
   *  that ran and failed, which is what "not a repository" looks like. */
  gitMissing: boolean;
}

const gitRun = async (cwd: string, args: string[]): Promise<GitResult> => {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout, gitMissing: false };
  } catch (error) {
    const err = error as { stdout?: unknown; code?: unknown };
    const partial = typeof err.stdout === "string" && err.stdout.length > 0 ? err.stdout : null;
    // ENOENT from the spawn means no git binary. A non-zero exit means git ran
    // and said no — reporting that as "git is not installed" sends the reader
    // to fix the wrong thing.
    return { stdout: partial, gitMissing: err.code === "ENOENT" };
  }
};

const gitStdout = async (cwd: string, args: string[]): Promise<string | null> =>
  (await gitRun(cwd, args)).stdout;

export interface FileChurn {
  normalizedFilePath: string;
  /** Commits touching this file inside the window. */
  commits: number;
  /** Distinct authors who touched it — a proxy for how many people must agree. */
  authors: number;
  /** Commits-ago of the most recent change (0 = the newest commit in the window). */
  lastTouchedCommitsAgo: number;
  /**
   * 0–100. Combines volume (how often), spread (how many people) and recency
   * (how lately), each normalized against this project's own distribution — an
   * absolute threshold would be meaningless across repositories of different
   * ages and team sizes.
   */
  score: number;
}

export interface ChurnReport {
  /** True when a git history was actually read. False → every score is 0. */
  available: boolean;
  /**
   * True when the checkout is shallow or the window saw too few commits to
   * distinguish a hotspot from an ordinary file. Scores and ranking remain
   * useful; MAGNET CLAIMS ARE SUPPRESSED, because with one commit every file
   * has identical volume and recency and would all score 100.
   *
   * This matters in practice: `actions/checkout` clones with `--depth 1` by
   * default, which is exactly this case.
   */
  historyTruncated: boolean;
  /** Why the history could not be read, when it could not. */
  unavailableReason: string | null;
  files: FileChurn[];
  /** Files whose churn is far above this project's own baseline. */
  refactorMagnets: FileChurn[];
  summary: {
    commitsScanned: number;
    filesTracked: number;
  };
}

/** A file is a magnet when its score sits this far above the project median. */
const MAGNET_SCORE_FLOOR = 70;

/**
 * Absolute evidence a magnet claim requires, on top of the relative score.
 * Scores are ratios against the project maximum, so in a one-commit history
 * EVERY file ties at 100 — relative rank is meaningless without a floor of real
 * observations underneath it.
 */
const MAGNET_MIN_COMMITS_SCANNED = 10;
const MAGNET_MIN_FILE_COMMITS = 3;
const MAX_MAGNETS = 10;

/** Only source files can be "begging to be split". */
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;

/**
 * Files that change constantly BY DESIGN, so their churn says nothing about
 * design pressure: docs, lockfiles, and anything a generator owns. Left in
 * `files` (they cost nothing there) but never called a refactor magnet — a
 * "you should split CHANGELOG.md" finding would be pure noise.
 */
const CHURN_BY_DESIGN =
  /(^|\/)(CHANGELOG|README|FEATURE|LAUNCH|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)|(^|\/)(dist|build|coverage)\/|\.(md|json|ya?ml|snap|lock)$/i;

/** A generated file names its generator in the first lines; the path alone is
 *  not always enough (a hand-written `registry.ts` would be a real magnet). */
const GENERATED_PATH = /(^|\/)(registry|generated|__generated__|\.gen)\.|(^|\/)(schema|web\/src\/data)\//i;

interface RawChurn {
  commits: number;
  authors: Set<string>;
  lastIndex: number;
}

/**
 * Per-file churn from `git log --name-only`. One process, one pass — the format
 * is a NUL-delimited header per commit followed by the files it touched.
 */
export const buildChurnReport = async (
  rootDirectory: string,
  options: { window?: number } = {},
): Promise<ChurnReport> => {
  const window = options.window ?? DEFAULT_COMMIT_WINDOW;
  const empty = (reason: string): ChurnReport => ({
    available: false,
    historyTruncated: false,
    unavailableReason: reason,
    files: [],
    refactorMagnets: [],
    summary: { commitsScanned: 0, filesTracked: 0 },
  });

  const probe = await gitRun(rootDirectory, ["rev-parse", "--is-inside-work-tree"]);
  if (probe.gitMissing) return empty("git is not available on PATH");
  if (probe.stdout === null || probe.stdout.trim() !== "true") return empty("not a git repository");

  // A shallow checkout has no history to reason about, however many files it
  // contains. `actions/checkout` produces one by default.
  const shallow = (await gitStdout(rootDirectory, ["rev-parse", "--is-shallow-repository"]))?.trim() === "true";

  // `git log --name-only` prints paths relative to the REPOSITORY ROOT, while
  // findings are relative to the SCAN ROOT. Scanning a subdirectory
  // (`node-doctor churn packages/api`) therefore joins nothing unless the keys
  // are rebased onto the scan root — and a silently empty join looks exactly
  // like "this code never changes".
  //
  // `--show-prefix` is git's own answer to "where am I inside this repo?" —
  // asking git avoids computing it from paths, which on macOS would compare a
  // `/var/…` cwd against a `/private/var/…` toplevel and rebase everything to
  // nothing. It prints a trailing-slashed path, or empty at the repository root.
  const prefix = ((await gitStdout(rootDirectory, ["rev-parse", "--show-prefix"])) ?? "").trim();

  const stdout = await gitStdout(rootDirectory, [
    "log",
    `--max-count=${window}`,
    "--name-only",
    "--no-merges",
    "--no-renames",
    // \x00 marks a commit header; the author follows, then a blank line, then files.
    "--format=%x00%ae",
  ]);
  if (stdout === null || stdout.trim() === "") return empty("no commit history");

  const churn = new Map<string, RawChurn>();
  let commitIndex = -1;
  let author = "";
  let commitsScanned = 0;

  for (const rawLine of stdout.split("\n")) {
    if (rawLine.startsWith("\x00")) {
      commitIndex += 1;
      commitsScanned += 1;
      author = rawLine.slice(1).trim();
      continue;
    }
    const raw = rawLine.trim();
    if (raw === "") continue;
    // Rebase onto the scan root, and drop anything outside it: a sibling
    // package's churn is not this scan's business.
    let file = raw;
    if (prefix !== "") {
      if (!raw.startsWith(prefix)) continue;
      file = raw.slice(prefix.length);
      if (file === "") continue;
    }
    let entry = churn.get(file);
    if (!entry) {
      entry = { commits: 0, authors: new Set(), lastIndex: commitIndex };
      churn.set(file, entry);
    }
    entry.commits += 1;
    if (author) entry.authors.add(author);
    // The log is newest-first, so the FIRST sighting is the most recent change.
    if (entry.lastIndex > commitIndex) entry.lastIndex = commitIndex;
  }

  if (churn.size === 0) return empty("no file changes in the scanned window");

  // Normalize each axis against this project's own maximum: an absolute
  // "10 commits is a lot" is meaningless across repositories of different ages.
  let maxCommits = 0;
  let maxAuthors = 0;
  for (const entry of churn.values()) {
    if (entry.commits > maxCommits) maxCommits = entry.commits;
    if (entry.authors.size > maxAuthors) maxAuthors = entry.authors.size;
  }

  const files: FileChurn[] = [...churn.entries()].map(([normalizedFilePath, entry]) => {
    const volume = maxCommits > 0 ? entry.commits / maxCommits : 0;
    const spread = maxAuthors > 0 ? entry.authors.size / maxAuthors : 0;
    // Recency in commits-ago, not days: the same repo at the same commit must
    // score identically forever, and a wall clock would break that.
    const recency = commitsScanned > 1 ? 1 - entry.lastIndex / (commitsScanned - 1) : 1;
    const score = Math.round(100 * (0.5 * volume + 0.2 * spread + 0.3 * recency));
    return {
      normalizedFilePath,
      commits: entry.commits,
      authors: entry.authors.size,
      lastTouchedCommitsAgo: entry.lastIndex,
      score,
    };
  });

  files.sort((a, b) =>
    b.score - a.score ||
    b.commits - a.commits ||
    (a.normalizedFilePath < b.normalizedFilePath ? -1 : 1),
  );

  // A magnet must be SOURCE the team actually maintains by hand. Docs, lockfiles
  // and generated artifacts churn by design and would otherwise fill the list.
  // With too little history, relative scores carry no information: suppress the
  // claim rather than fabricate one. Ranking still works — it is only ordering.
  const historyTruncated = shallow || commitsScanned < MAGNET_MIN_COMMITS_SCANNED;

  const refactorMagnets = (historyTruncated ? [] : files)
    .filter(
      (f) =>
        f.score >= MAGNET_SCORE_FLOOR &&
        f.commits >= MAGNET_MIN_FILE_COMMITS &&
        SOURCE_FILE.test(f.normalizedFilePath) &&
        !CHURN_BY_DESIGN.test(f.normalizedFilePath) &&
        !GENERATED_PATH.test(f.normalizedFilePath),
    )
    .slice(0, MAX_MAGNETS);

  return {
    available: true,
    historyTruncated,
    unavailableReason: historyTruncated
      ? shallow
        ? "shallow checkout — refactor magnets need full history"
        : `only ${commitsScanned} commit(s) of history — refactor magnets need at least ${MAGNET_MIN_COMMITS_SCANNED}`
      : null,
    files,
    refactorMagnets,
    summary: { commitsScanned, filesTracked: files.length },
  };
};

/** A finding annotated with the churn of the file it lives in. */
export interface ChurnWeighted<T> {
  finding: T;
  churn: number;
}

/**
 * Re-order findings by the churn of their file, highest first, keeping the
 * analyzer's own order within a file. This ADDS NOTHING and REMOVES NOTHING —
 * the returned array is a permutation of the input, which is what makes churn
 * weighting incapable of producing a wrong claim.
 */
export const weightByChurn = <T extends { normalizedFilePath?: string }>(
  findings: readonly T[],
  report: ChurnReport,
): Array<ChurnWeighted<T>> => {
  const byPath = new Map(report.files.map((f) => [f.normalizedFilePath, f.score]));
  return findings
    .map((finding, index) => ({
      finding,
      churn: byPath.get(finding.normalizedFilePath ?? "") ?? 0,
      index,
    }))
    // A stable sort on (churn desc, original order) — the analyzer already
    // ordered findings meaningfully, so churn only breaks ties across files.
    .sort((a, b) => b.churn - a.churn || a.index - b.index)
    .map(({ finding, churn }) => ({ finding, churn }));
};
