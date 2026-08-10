/**
 * Shared git plumbing: running git safely, and parsing a unified diff.
 *
 * Three features already shell out to git independently — §160 churn, §163
 * review routing, and the history secret scan — and each rolled its own
 * invocation. This is the module the implementation plan asked for: one place
 * that knows how to run git, how to tell "git is missing" from "this is not a
 * repository", and how to turn `git diff` output into structured hunks.
 *
 * TWO DISTINCTIONS THIS MODULE EXISTS TO PRESERVE.
 *
 *   1. `git is not installed` and `this is not a repository` are different
 *      answers, and sending a reader to install git when git already ran and
 *      said no is the wrong fix. `gitRun` reports which happened.
 *   2. `I could not read the diff` and `the diff is clean` must never look the
 *      same. Every caller gets `null`/`gitMissing` rather than an empty array on
 *      failure, so it cannot accidentally render a failure as a pass.
 *
 * PATHS. `git diff` prints paths relative to the REPOSITORY ROOT, while findings
 * are relative to the SCAN ROOT. Scanning a subdirectory therefore joins nothing
 * unless the keys are rebased — a silently empty join that looks exactly like
 * "nothing changed". `showPrefix` asks git itself (rather than computing it from
 * paths, which on macOS would compare a `/var` cwd against a `/private/var`
 * toplevel and rebase everything to nothing).
 *
 * Deterministic: fixed flags, no clock, no locale-dependent output — `color.ui`
 * and `core.quotePath` are pinned off so a user's global git config cannot
 * change what this reads.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** The result of running git: stdout, plus whether git itself could be spawned. */
export interface GitResult {
  stdout: string | null;
  /**
   * True only when the git binary could not be spawned — distinct from a
   * command that ran and exited non-zero, which is what "not a repository"
   * looks like.
   */
  gitMissing: boolean;
  /**
   * True when git produced more output than the buffer could hold. The partial
   * stdout is NOT returned: a truncated diff parses cleanly and looks exactly
   * like a smaller, complete one, so every file past the cut would be silently
   * reported as unchanged.
   */
  truncated: boolean;
}

/**
 * Flags pinned on every invocation so a user's git config cannot change output.
 * `diff.mnemonicPrefix` rewrites `a/`→`i/`,`w/`,`c/` and `diff.noprefix` removes
 * the prefix entirely — either silently corrupts every path this module parses.
 */
const PINNED = [
  "-c",
  "core.quotePath=false",
  "-c",
  "color.ui=false",
  "-c",
  "diff.mnemonicPrefix=false",
  "-c",
  "diff.noprefix=false",
  "-c",
  "diff.srcPrefix=a/",
  "-c",
  "diff.dstPrefix=b/",
  "-c",
  "diff.external=",
];

export const gitRun = async (cwd: string, args: readonly string[]): Promise<GitResult> => {
  try {
    const { stdout } = await execFileAsync("git", [...PINNED, ...args], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout, gitMissing: false, truncated: false };
  } catch (error) {
    const err = error as { stdout?: unknown; code?: unknown };
    if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      return { stdout: null, gitMissing: false, truncated: true };
    }
    const partial = typeof err.stdout === "string" && err.stdout.length > 0 ? err.stdout : null;
    return { stdout: partial, gitMissing: err.code === "ENOENT", truncated: false };
  }
};

export const gitStdout = async (cwd: string, args: readonly string[]): Promise<string | null> =>
  (await gitRun(cwd, args)).stdout;

/** Why a git-backed report could not be produced. Null means it could. */
export type GitUnavailable = "git is not available on PATH" | "not a git work tree";

/**
 * Confirm `cwd` is inside a work tree, and return the path prefix from the
 * repository root to it (trailing-slashed, empty at the root).
 */
export const gitContext = async (
  cwd: string,
): Promise<{ unavailable: GitUnavailable | null; prefix: string }> => {
  const probe = await gitRun(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (probe.gitMissing) return { unavailable: "git is not available on PATH", prefix: "" };
  // False inside a bare repository and inside `.git/` itself — there is no work
  // tree to diff, which is a different fact from "this is not a repository".
  if (probe.stdout === null || probe.stdout.trim() !== "true") {
    return { unavailable: "not a git work tree", prefix: "" };
  }
  const prefix = ((await gitStdout(cwd, ["rev-parse", "--show-prefix"])) ?? "").trim();
  return { unavailable: null, prefix };
};

/**
 * Rebase a repository-root-relative path onto the scan root, or null when it
 * falls outside — a sibling package's change is not this scan's business.
 */
export const rebaseToScanRoot = (repoRelativePath: string, prefix: string): string | null => {
  if (prefix === "") return repoRelativePath;
  if (!repoRelativePath.startsWith(prefix)) return null;
  const rebased = repoRelativePath.slice(prefix.length);
  return rebased === "" ? null : rebased;
};

// ---------------------------------------------------------------------------
// Unified diff parsing.
// ---------------------------------------------------------------------------

export type DiffLineKind = "add" | "del";

export interface DiffLine {
  kind: DiffLineKind;
  /** The line's content, without the leading `+`/`-`. */
  text: string;
  /** Line number on the new side for an add, the old side for a delete. */
  line: number;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Text after the closing `@@` — git's guess at the enclosing function. */
  heading: string;
  lines: DiffLine[];
}

export interface FileDiff {
  /**
   * True for a COMBINED diff (`diff --cc` / `diff --combined`), produced for an
   * unresolved merge or a merge commit. Its line format is not the unified one —
   * every line carries N status columns — so the hunks are deliberately not
   * parsed. Silently returning zero hunks for a merge conflict would report an
   * unresolved tree as a clean change set.
   */
  combined: boolean;
  /** Path on the old side, or null for an added file. */
  oldPath: string | null;
  /** Path on the new side, or null for a deleted file. */
  newPath: string | null;
  status: "added" | "deleted" | "modified";
  /** True when git reported a binary difference — there are no hunks to read. */
  binary: boolean;
  hunks: DiffHunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Strip git's `a/` / `b/` prefix; `/dev/null` becomes null. */
const diffPath = (raw: string): string | null => {
  const path = raw.trim();
  if (path === "/dev/null") return null;
  return path.replace(/^[ab]\//, "");
};

/**
 * Parse `git diff` output into per-file hunks.
 *
 * The subtle part is the header guard. A `+++ b/file` line means "this is the
 * new-side path" only while we are still INSIDE a diff header — before the
 * first `@@`. After that, an added content line can itself begin with `+++`
 * (a Markdown rule, a comment banner, a diff quoted inside a test fixture), and
 * treating it as a path silently reassigns every following hunk to a file that
 * does not exist.
 */
export const parseUnifiedDiff = (stdout: string): FileDiff[] => {
  const files: FileDiff[] = [];
  let file: FileDiff | null = null;
  let hunk: DiffHunk | null = null;
  let inHeader = false;
  let oldLine = 0;
  let newLine = 0;

  const push = (): void => {
    if (file) files.push(file);
  };

  for (const raw of stdout.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      push();
      file = {
        combined: false,
        oldPath: null,
        newPath: null,
        status: "modified",
        binary: false,
        hunks: [],
      };
      hunk = null;
      inHeader = true;
      // `diff --git a/x b/x` — recover the path here, so a file whose body has
      // no `---`/`+++` lines (a pure mode change, an empty file added) still
      // knows what it is about.
      const paths = /^diff --git (.+?) (.+)$/.exec(raw);
      if (paths) {
        file.oldPath = diffPath(paths[1]!);
        file.newPath = diffPath(paths[2]!);
      }
      continue;
    }
    if (raw.startsWith("diff --cc ") || raw.startsWith("diff --combined ")) {
      push();
      const path = raw.slice(raw.startsWith("diff --cc ") ? 10 : 16).trim();
      file = {
        combined: true,
        oldPath: path,
        newPath: path,
        status: "modified",
        binary: false,
        hunks: [],
      };
      hunk = null;
      inHeader = true;
      continue;
    }
    if (!file) continue;

    if (inHeader) {
      if (raw.startsWith("--- ")) {
        file.oldPath = diffPath(raw.slice(4));
        continue;
      }
      if (raw.startsWith("+++ ")) {
        file.newPath = diffPath(raw.slice(4));
        continue;
      }
      if (raw.startsWith("new file mode")) {
        file.status = "added";
        continue;
      }
      if (raw.startsWith("deleted file mode")) {
        file.status = "deleted";
        continue;
      }
      if (raw.startsWith("Binary files ") || raw.startsWith("GIT binary patch")) {
        file.binary = true;
        continue;
      }
    }

    // A combined diff's body is not unified-format; do not pretend to read it.
    if (file.combined) continue;

    const header = HUNK_HEADER.exec(raw);
    if (header) {
      inHeader = false;
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      hunk = {
        oldStart: oldLine,
        // An elided count means exactly one line.
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: newLine,
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        heading: header[5] ?? "",
        lines: [],
      };
      file.hunks.push(hunk);
      continue;
    }

    if (!hunk) continue;

    // `\ No newline at end of file` is metadata, not content.
    if (raw.startsWith("\\")) continue;

    if (raw.startsWith("+")) {
      hunk.lines.push({ kind: "add", text: raw.slice(1), line: newLine });
      newLine += 1;
      continue;
    }
    if (raw.startsWith("-")) {
      hunk.lines.push({ kind: "del", text: raw.slice(1), line: oldLine });
      oldLine += 1;
      continue;
    }
    // A context line advances both sides. With `--unified=0` there are none.
    oldLine += 1;
    newLine += 1;
  }
  push();

  // Derive add/delete status when the mode lines were absent (some git versions
  // omit them for a pure rename or a mode change).
  for (const f of files) {
    if (f.oldPath === null && f.newPath !== null) f.status = "added";
    else if (f.newPath === null && f.oldPath !== null) f.status = "deleted";
  }
  return files;
};

/** The path a change is *about*: the new side, falling back to the old. */
export const diffFilePath = (file: FileDiff): string | null => file.newPath ?? file.oldPath;

/** One commit, as `git blame --porcelain` describes it. */
export interface BlameCommit {
  sha: string;
  author: string;
  /** ISO-8601, derived from the porcelain `author-time` epoch. */
  date: string;
  subject: string;
}

export interface BlameResult {
  /** Per line (0-indexed), the sha that last touched it. */
  lineShas: string[];
  /** Every commit the blame mentions, by full sha. */
  commits: Map<string, BlameCommit>;
}

/** A line git has not committed yet blames to the all-zero sha. */
export const UNCOMMITTED_SHA = "0".repeat(40);

/**
 * Blame one file, in a single pass.
 *
 * `--porcelain` because its header lines are stable across git versions, and
 * because it carries the author, the timestamp and the subject inline — so one
 * call answers everything, with no follow-up `git log`.
 *
 * The shape has one trap worth stating: porcelain emits **one header per FILE
 * LINE**, and only the first header of each group carries a trailing `<count>`
 * field. Honouring that count double-counts every group — measured on a
 * 330-line file, it reported 50,195 lines.
 */
export const blameFile = async (cwd: string, repoRelativePath: string): Promise<BlameResult | null> => {
  const stdout = await gitStdout(cwd, [
    "blame",
    "--porcelain",
    "--no-abbrev",
    "-w", // a whitespace-only reformat should not re-attribute the line
    "--",
    repoRelativePath,
  ]);
  if (stdout === null) return null;

  const lineShas: string[] = [];
  const commits = new Map<string, BlameCommit>();
  let current: string | null = null;

  for (const line of stdout.split("\n")) {
    const header = /^([0-9a-f]{40})\s+\d+\s+\d+(?:\s+\d+)?$/.exec(line);
    if (header) {
      current = header[1] as string;
      lineShas.push(current);
      if (!commits.has(current)) {
        commits.set(current, { sha: current.slice(0, 7), author: "", date: "", subject: "" });
      }
      continue;
    }
    if (current === null) continue;
    const commit = commits.get(current);
    if (!commit) continue;
    if (line.startsWith("author ")) commit.author = line.slice(7).trim();
    else if (line.startsWith("author-time ")) {
      const epoch = Number(line.slice(12).trim());
      if (Number.isFinite(epoch)) commit.date = new Date(epoch * 1000).toISOString();
    } else if (line.startsWith("summary ")) commit.subject = line.slice(8).trim();
  }

  return { lineShas, commits };
};
