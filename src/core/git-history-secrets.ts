/**
 * Git-history secret scanning: the credentials the working-tree scan cannot see.
 *
 * `src/diagnostics/secrets/*` flags a secret that is in the tree *right now*. But
 * a key that was committed and later "removed" is still in every clone, still in
 * every fork, and still valid — deleting the line is not remediation, rotating the
 * credential is. This module walks `git log`, looks only at **added** lines, and
 * reports what entered history, flagging the ones that are already gone from HEAD
 * (the actionable "you thought you fixed this" case).
 *
 * Two invariants shape every line below:
 *
 * 1. **The secret value is never emitted.** A finding carries the variable name or
 *    a provider descriptor — never a character of the credential. A report or a CI
 *    log that echoed the key back would make this tool the vulnerability. Values
 *    exist here only as SHA-256 fingerprints, used for de-duplication and for the
 *    HEAD check, and are never returned or logged.
 * 2. **Bounded and deterministic.** History is unbounded, so the walk is capped by
 *    `maxCommits` and by `maxBytes` of diff; generated paths (lockfiles, bundles,
 *    `node_modules`) are skipped; and every git invocation pins the diff-shaping
 *    config (`--no-renames`, explicit prefixes, no ext-diff) so the same repo
 *    yields byte-identical output regardless of the user's `.gitconfig`.
 *
 * Detection reuses `secret-patterns.ts` wholesale — no new patterns — so history
 * and the working tree agree on what a secret is.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  PROVIDER_KEY_INLINE_RE,
  PEM_PRIVATE_KEY_RE,
  secretInAssignment,
  cleanValue,
} from "./secret-patterns.ts";

const execFileAsync = promisify(execFile);

export type HistorySecretKind = "provider-key" | "private-key" | "env-secret";

export interface HistorySecret {
  /** Short sha of the commit that introduced the secret. */
  commit: string;
  /** Repo-relative, forward-slash path the secret was added to. */
  file: string;
  kind: HistorySecretKind;
  /** The KEY/label only — NEVER the secret value. */
  label: string;
  /** True when the secret is gone from the working tree (still in history). */
  removedFromHead: boolean;
}

export interface ScanHistoryOptions {
  /** Commits to walk, newest first (default 500). */
  maxCommits?: number;
  /** Cap on diff bytes read from git (default ~5 MB). */
  maxBytes?: number;
  /** Passed to `git log --since=<value>` (e.g. "1 year ago"). */
  since?: string;
}

const DEFAULT_MAX_COMMITS = 500;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
/** Longest line we bother inspecting — beyond this it is minified/generated. */
const MAX_LINE_LENGTH = 4000;
/** Per-file cap when re-reading the working tree for the HEAD check. */
const HEAD_FILE_MAX_BYTES = 512 * 1024;
const MAX_LABEL_LENGTH = 64;

// --- path filters ----------------------------------------------------------

/** Directories whose contents are generated, vendored, or installed. */
const GENERATED_DIR_RE =
  /(^|\/)(node_modules|dist|build|out|coverage|vendor|bower_components|__snapshots__|\.next|\.nuxt|\.yarn|\.pnp|\.git)\//;

/** Lockfiles: enormous, machine-written, and never where a human puts a key. */
const LOCKFILE_RE =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|composer\.lock|Gemfile\.lock|poetry\.lock|Pipfile\.lock|go\.sum)$/;

/** Bundled / minified / map output. */
const GENERATED_FILE_RE = /\.(min\.js|min\.css|js\.map|css\.map|map|snap|bundle\.js)$/;

const isGeneratedPath = (file: string): boolean =>
  GENERATED_DIR_RE.test(file) || LOCKFILE_RE.test(file) || GENERATED_FILE_RE.test(file);

/** `.env`, `.env.local`, `config/.env.production`, … */
const ENV_FILE_RE = /(^|\/)\.env(\.|$)/;
/** Placeholder files that are *meant* to be committed. */
const EXAMPLE_FILE_RE = /\.(example|sample|template|tmpl|dist)$/i;

/**
 * Tokens that *look* like a provider key but are published documentation
 * examples — AWS ships `AKIAIOSFODNN7EXAMPLE` in its own docs, and GitHub's
 * scanner ignores it too. History is full of docs and fixtures, so without this
 * a scan of any well-documented repo is mostly noise.
 */
const DOC_EXAMPLE_RE = /(EXAMPLE|SAMPLE|PLACEHOLDER|REDACTED|XXXX|YOUR[_-]?KEY|NOT[_-]?A[_-]?REAL)/i;

/**
 * A PEM *header* in prose (a JSDoc example, a rule description) is not a key.
 * Require a following line that actually looks like base64 key material.
 */
const PEM_BODY_RE = /^[A-Za-z0-9+/=]{32,}$/;

const isEnvFile = (file: string): boolean => ENV_FILE_RE.test(file) && !EXAMPLE_FILE_RE.test(file);

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// --- labels (never the value) ----------------------------------------------

/** A stable provider descriptor derived from the prefix — contains no key material. */
const providerLabel = (token: string): string => {
  if (token.startsWith("sk_live_") || token.startsWith("rk_live_")) return "Stripe live key";
  if (token.startsWith("AKIA")) return "AWS access key id";
  if (token.startsWith("github_pat_")) return "GitHub fine-grained token";
  if (token.startsWith("ghp_") || token.startsWith("gho_")) return "GitHub token";
  if (token.startsWith("xox")) return "Slack token";
  if (token.startsWith("AIza")) return "Google API key";
  if (token.startsWith("glpat-")) return "GitLab token";
  return "provider API key";
};

/** `-----BEGIN RSA PRIVATE KEY-----` → `RSA PRIVATE KEY`. */
const pemLabel = (header: string): string => header.replace(/-/g, "").trim() || "PRIVATE KEY";

/**
 * The identifier immediately to the left of `index` — `FOO=`, `foo: `, `const foo = "`.
 * Returns null when the secret is bare (no assignment), which is why callers must
 * always have a value-free fallback label.
 */
const nameBefore = (line: string, index: number): string | null => {
  const head = line.slice(0, index);
  const m = /([A-Za-z_$][A-Za-z0-9_$.-]{0,63})["']?\s*[:=]\s*["'`]?\s*$/.exec(head);
  return m ? m[1]! : null;
};

/**
 * Last line of defence: a label must never be, contain, or be contained by the
 * credential. Anything suspicious collapses to the value-free fallback.
 */
const safeLabel = (candidate: string | null, value: string, fallback: string): string => {
  if (!candidate) return fallback;
  const label = candidate.trim().slice(0, MAX_LABEL_LENGTH);
  if (label.length === 0) return fallback;
  if (PROVIDER_KEY_INLINE_RE.test(label) || PEM_PRIVATE_KEY_RE.test(label)) return fallback;
  if (value.includes(label) || label.includes(value)) return fallback;
  return label;
};

// --- detection --------------------------------------------------------------

/** Fingerprints exist only to de-duplicate and to test HEAD; they never escape. */
const fingerprint = (...parts: string[]): string =>
  createHash("sha256").update(parts.map((p) => `${p.length}:${p}`).join("|")).digest("hex").slice(0, 24);

interface Candidate {
  kind: HistorySecretKind;
  label: string;
  fingerprint: string;
}

/**
 * Every secret in a run of lines — used both for a commit's added lines and for
 * the current working-tree copy of a file, so the two are compared like for like.
 */
const findSecretsInLines = (lines: string[], file: string): Candidate[] => {
  const out: Candidate[] = [];
  const envish = isEnvFile(file);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length === 0 || line.length > MAX_LINE_LENGTH) continue;

    const pem = PEM_PRIVATE_KEY_RE.exec(line);
    if (pem) {
      // Only a header followed by real base64 body is a key; a header quoted in
      // documentation or a test fixture is not.
      const next = lines.slice(i + 1, i + 4).map((l) => l.trim());
      if (!next.some((l) => PEM_BODY_RE.test(l))) continue;
      // The header alone is not unique; a couple of body lines distinguish two
      // different keys. Sampled for the fingerprint only — never emitted.
      const body = lines.slice(i + 1, i + 3).join("\n");
      out.push({
        kind: "private-key",
        label: pemLabel(pem[0]),
        fingerprint: fingerprint("pem", pem[0], body),
      });
      continue;
    }

    const provider = PROVIDER_KEY_INLINE_RE.exec(line);
    if (provider) {
      const token = provider[1]!;
      if (DOC_EXAMPLE_RE.test(token)) continue; // published doc example, not a credential
      out.push({
        kind: "provider-key",
        label: safeLabel(nameBefore(line, provider.index), token, providerLabel(token)),
        fingerprint: fingerprint("key", token),
      });
      continue;
    }

    if (!envish) continue;

    // Name-driven detection is only precise enough inside env files; elsewhere a
    // `password = ...` line is as likely to be a fixture as a credential.
    const trimmed = line.trimStart();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export[ \t]+/, "");
    if (!ENV_KEY_RE.test(key)) continue;
    const value = cleanValue(line.slice(eq + 1));
    if (value.length === 0 || value.startsWith("$")) continue; // empty or an env-var reference
    if (!secretInAssignment(key, value)) continue;
    out.push({
      kind: "env-secret",
      label: safeLabel(key, value, "env secret"),
      fingerprint: fingerprint("env", key, value),
    });
  }
  return out;
};

// --- git --------------------------------------------------------------------

/** Diff-shaping flags are pinned so a user's `.gitconfig` cannot change our output. */
const logArgs = (maxCommits: number, since: string | undefined): string[] => [
  "-c",
  "core.quotePath=false",
  "-c",
  "color.ui=false",
  "log",
  "--no-color",
  "--no-merges",
  `--max-count=${maxCommits}`,
  "--format=%x00%h",
  "--no-renames",
  "--no-ext-diff",
  "--no-textconv",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--unified=0",
  "--diff-filter=AM",
  ...(since ? [`--since=${since}`] : []),
  "-p",
];

/**
 * stdout of a git command, or null when git is missing / the command failed.
 * A `maxBuffer` overrun is *not* a failure — the truncated output is exactly the
 * bounded slice of history we asked for, so it is returned as-is.
 */
const gitStdout = async (cwd: string, args: string[], maxBuffer: number): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer, windowsHide: true });
    return stdout;
  } catch (error) {
    const partial = (error as { stdout?: unknown }).stdout;
    return typeof partial === "string" && partial.length > 0 ? partial : null;
  }
};

interface FileBlock {
  commitIndex: number;
  commit: string;
  file: string;
  /** Added lines, grouped per hunk so lookahead never joins unrelated regions. */
  hunks: string[][];
}

/**
 * Parse `git log -p` output into per-(commit, file) blocks of **added** lines.
 *
 * `+++ b/<path>` is only honoured while inside a diff header (before the first
 * `@@`); an added content line can itself start with `+++`, and mistaking one for
 * a header would silently mis-attribute every later finding.
 */
const parseLog = (stdout: string): FileBlock[] => {
  const blocks: FileBlock[] = [];
  let commit = "";
  let commitIndex = -1;
  let inHeader = false;
  let current: FileBlock | null = null;
  let hunk: string[] | null = null;

  for (const line of stdout.split("\n")) {
    if (line.charCodeAt(0) === 0) {
      commit = line.slice(1).trim();
      commitIndex += 1;
      current = null;
      hunk = null;
      inHeader = false;
      continue;
    }
    if (commit === "") continue;

    if (line.startsWith("diff --git ")) {
      current = null;
      hunk = null;
      inHeader = true;
      continue;
    }
    if (inHeader) {
      if (line.startsWith("+++ ")) {
        const path = line.slice(4);
        if (path === "/dev/null") {
          current = null;
        } else {
          const file = path.startsWith("b/") ? path.slice(2) : path;
          current = isGeneratedPath(file) ? null : { commitIndex, commit, file, hunks: [] };
          if (current) blocks.push(current);
        }
      }
      if (line.startsWith("@@")) {
        inHeader = false;
        hunk = null;
      }
      if (!line.startsWith("@@")) continue;
    }

    if (line.startsWith("@@")) {
      hunk = null;
      continue;
    }
    if (current && line.startsWith("+")) {
      if (!hunk) {
        hunk = [];
        current.hunks.push(hunk);
      }
      hunk.push(line.slice(1));
    } else if (!line.startsWith("-") && !line.startsWith(" ") && !line.startsWith("\\")) {
      // Anything else (blank separator, "Binary files … differ") ends the run.
      hunk = null;
    }
  }
  return blocks;
};

// --- HEAD lookup ------------------------------------------------------------

/** Fingerprints of the secrets still present in a working-tree file (cached). */
const headFingerprints = async (
  toplevel: string,
  file: string,
  cache: Map<string, Set<string>>,
): Promise<Set<string>> => {
  const cached = cache.get(file);
  if (cached) return cached;

  const found = new Set<string>();
  try {
    const content = await readFile(join(toplevel, file), "utf8");
    if (Buffer.byteLength(content) <= HEAD_FILE_MAX_BYTES) {
      for (const c of findSecretsInLines(content.split("\n"), file)) found.add(c.fingerprint);
    }
  } catch {
    /* deleted, moved, or unreadable — treated as "not in the working tree" */
  }
  cache.set(file, found);
  return found;
};

// --- public API -------------------------------------------------------------

/**
 * Secrets added anywhere in the repository's recent history.
 *
 * Ordering is the `git log` walk (newest commit first), then file, then label.
 * Each distinct credential appears once, attributed to the **oldest** commit in
 * the window that added it — the commit that put it in history.
 *
 * Returns `[]` rather than throwing when `rootDirectory` is not a git repo, git
 * is unavailable, or the repo has no commits. History scanning is advisory; it
 * must never be the reason a scan fails.
 */
export const scanGitHistoryForSecrets = async (
  rootDirectory: string,
  options: ScanHistoryOptions = {},
): Promise<HistorySecret[]> => {
  const maxCommits = Math.floor(options.maxCommits ?? DEFAULT_MAX_COMMITS);
  const maxBytes = Math.floor(options.maxBytes ?? DEFAULT_MAX_BYTES);
  if (!(maxCommits > 0) || !(maxBytes > 0)) return [];

  const toplevelRaw = await gitStdout(rootDirectory, ["rev-parse", "--show-toplevel"], 64 * 1024);
  if (toplevelRaw === null) return [];
  const toplevel = toplevelRaw.trim();
  if (toplevel.length === 0) return [];

  const stdout = await gitStdout(rootDirectory, logArgs(maxCommits, options.since), maxBytes);
  if (stdout === null) return [];

  // fingerprint → the oldest sighting, plus every path it was ever added to.
  interface Sighting {
    commitIndex: number;
    commit: string;
    file: string;
    kind: HistorySecretKind;
    label: string;
    paths: Set<string>;
  }
  const byFingerprint = new Map<string, Sighting>();

  for (const block of parseLog(stdout)) {
    for (const hunk of block.hunks) {
      for (const candidate of findSecretsInLines(hunk, block.file)) {
        const existing = byFingerprint.get(candidate.fingerprint);
        if (!existing) {
          byFingerprint.set(candidate.fingerprint, {
            commitIndex: block.commitIndex,
            commit: block.commit,
            file: block.file,
            kind: candidate.kind,
            label: candidate.label,
            paths: new Set([block.file]),
          });
          continue;
        }
        existing.paths.add(block.file);
        // The log walks newest → oldest, so a later sighting is an earlier commit.
        if (block.commitIndex > existing.commitIndex) {
          existing.commitIndex = block.commitIndex;
          existing.commit = block.commit;
          existing.file = block.file;
          existing.label = candidate.label;
        }
      }
    }
  }

  const cache = new Map<string, Set<string>>();
  const results: Array<HistorySecret & { commitIndex: number }> = [];
  for (const [fp, s] of byFingerprint) {
    let stillPresent = false;
    // Check every path the secret ever lived at, so a move does not read as
    // "removed" when the credential is in fact still sitting in the tree.
    for (const path of [...s.paths].sort()) {
      if ((await headFingerprints(toplevel, path, cache)).has(fp)) {
        stillPresent = true;
        break;
      }
    }
    results.push({
      commit: s.commit,
      file: s.file,
      kind: s.kind,
      label: s.label,
      removedFromHead: !stillPresent,
      commitIndex: s.commitIndex,
    });
  }

  results.sort(
    (a, b) =>
      a.commitIndex - b.commitIndex ||
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      (a.label < b.label ? -1 : a.label > b.label ? 1 : 0) ||
      (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
  );
  return results.map(({ commit, file, kind, label, removedFromHead }) => ({
    commit,
    file,
    kind,
    label,
    removedFromHead,
  }));
};
