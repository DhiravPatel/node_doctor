/**
 * §159 — Suspicious-Change-Shape Detection (`node-doctor change-shape`).
 *
 * Some diffs are risky because of their SHAPE, independently of whether the code
 * is correct. A one-line edit to an auth middleware. A `.env.example` key
 * removed — every developer who clones tomorrow is missing a variable nobody
 * told them about, and the failure surfaces at runtime. A dependency version
 * un-pinned. A migration edited in the same commit as unrelated feature work, so
 * the revert that fixes the feature also reverts the schema change.
 *
 * None of these is a bug. Each is an edit that deserves a second pair of eyes,
 * and the reviewer has no way to spot them in a 400-line diff.
 *
 * WHAT THIS IS NOT. It is not a linter and it emits no `Finding`. It reports
 * REVIEW PRIORITY, a separate vocabulary, because "this edit is unusual" and
 * "this code is wrong" are different claims and conflating them would make every
 * finding in the tool mean less. It is also distinct from §90's PR risk score,
 * which computes one aggregate number from introduced findings and a file count
 * and never sees a path, a line or a diff — this says "THIS hunk, at file:line,
 * has shape X, and here is why that shape matters".
 *
 * PRECISION MODEL. Every shape in the v1 catalog is decidable from the diff TEXT
 * alone, with no pairing ambiguity:
 *
 *   - The shapes that need to pair a removed line with the added line that
 *     replaced it run only on a 1:1 hunk — `@@ -a +b @@` with exactly one `-`
 *     and one `+`. In an N≠M hunk there is no sound pairing, and guessing one is
 *     how a "you loosened this check" claim gets attached to an unrelated line.
 *   - Shapes that would need to compare two ASTs, or to reason about regex
 *     language containment ("this character class got wider"), are NOT in the
 *     catalog. There is no honest text test for them, and comparing two full
 *     analyses is what §87's baseline delta already does properly.
 *   - Generated files, lockfiles and minified bundles are excluded, or a single
 *     bundle rebuild would dominate every report.
 *
 * "I could not read the diff" and "nothing suspicious changed" are reported
 * differently. A silently empty result would be the more dangerous of the two.
 *
 * Deterministic: fixed git flags, notes sorted by (file, line, shape), no clock.
 */

import { gitContext, gitRun, gitStdout, parseUnifiedDiff, rebaseToScanRoot } from "./git-history.ts";
import type { DiffHunk, FileDiff } from "./git-history.ts";
import { isMigrationPath } from "../diagnostics/migrations/context.ts";

/** How much extra attention a shape asks for. A third, separate vocabulary. */
export type ChangePriority = "notable" | "review-closely";

export interface ChangeNote {
  /** Stable id of the shape that matched. */
  shape: string;
  priority: ChangePriority;
  /** Scan-root-relative path. */
  normalizedFilePath: string;
  /** Line on the side that carries the evidence, or 0 for a whole-change note. */
  line: number;
  /** What was seen, in one sentence. */
  message: string;
  /** Why that shape is worth a second look. */
  why: string;
}

export interface ChangeShapeReport {
  /** False when the diff could not be read at all — never confuse with "clean". */
  available: boolean;
  /** Why it could not be read, when it could not. */
  unavailableReason: string | null;
  /** The revision range that was examined, as given to git. */
  range: string;
  notes: ChangeNote[];
  summary: {
    filesChanged: number;
    filesExamined: number;
    /**
     * Files git is not tracking, which a working-tree diff cannot see. Reported
     * so a green result cannot be mistaken for "everything was looked at".
     */
    untrackedFilesNotExamined: number;
    notable: number;
    reviewClosely: number;
  };
}

// ---------------------------------------------------------------------------
// Path predicates.
// ---------------------------------------------------------------------------

const GENERATED_DIR_RE = /(^|\/)(dist|build|out|coverage|vendor|node_modules|\.next|\.nuxt)\//;
const LOCKFILE_RE =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|composer\.lock|Gemfile\.lock|poetry\.lock|Pipfile\.lock|go\.sum)$/;
const GENERATED_FILE_RE = /\.(min\.js|min\.css|js\.map|css\.map|map|snap|bundle\.js)$/;

/** A file whose diff says nothing about intent — excluded from every shape. */
const isGeneratedPath = (file: string): boolean =>
  GENERATED_DIR_RE.test(file) || LOCKFILE_RE.test(file) || GENERATED_FILE_RE.test(file);

const ENV_EXAMPLE_RE = /(^|\/)\.env[^/]*\.(example|sample|template|tmpl|dist)$|(^|\/)\.env\.example$/i;
const PACKAGE_JSON_RE = /(^|\/)package\.json$/;
const SOURCE_RE = /\.(js|mjs|cjs|jsx|ts|mts|cts|tsx)$/i;

/**
 * Names that mark a file as part of the authentication or authorization path.
 *
 * Deliberately SHORT. The first version included `policy`, `session`, `guard`,
 * `admin`, `role`, `permit` and `can`, and an adversarial hunt flagged twelve of
 * eighteen ordinary paths — a retry *policy*, a Vue route *guard*, a
 * *session*-storage helper, an *admin* dashboard. A review signal that fires on
 * ordinary edits is worse than no signal, because the next reviewer learns to
 * skip it. Only tokens with no common non-security meaning survive.
 */
const AUTH_PATH_HINT =
  /(^|[/._-])(auth|authn|authz|authenticate|authentication|authorize|authorization|require-?auth|ensure-?auth|is-?authenticated|rbac|jwt|passport|oauth|oidc|saml)([/._-]|$)/i;

// ---------------------------------------------------------------------------
// Shape 1 — a `.env.example` key removed.
// ---------------------------------------------------------------------------

const ENV_KEY_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
/** `# STRIPE_KEY=` — commented out, but still documented for the next reader. */
const ENV_COMMENTED_KEY_RE = /^\s*#\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** Keys added anywhere in the change set, so a rename or a file split is not a removal. */
const envKeysAddedAnywhere = (files: Array<{ file: FileDiff; path: string }>): Set<string> => {
  const added = new Set<string>();
  for (const { file, path } of files) {
    if (!ENV_EXAMPLE_RE.test(path)) continue;
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind !== "add") continue;
        const key = ENV_KEY_RE.exec(line.text)?.[1] ?? ENV_COMMENTED_KEY_RE.exec(line.text)?.[1];
        if (key) added.add(key);
      }
    }
  }
  return added;
};

const envKeysRemoved = (
  file: FileDiff,
  path: string,
  addedAnywhere: ReadonlySet<string>,
  notes: ChangeNote[],
): void => {
  if (!ENV_EXAMPLE_RE.test(path)) return;
  const removed = new Map<string, number>();
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind !== "del") continue;
      const key = ENV_KEY_RE.exec(line.text)?.[1];
      if (key && !removed.has(key)) removed.set(key, line.line);
    }
  }
  for (const [key, line] of [...removed].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    // Added back anywhere in the change set — a rename, a file split, or a
    // deliberate comment-out that keeps the key documented. None is a removal.
    if (addedAnywhere.has(key)) continue;
    notes.push({
      shape: "env-example-key-removed",
      priority: "review-closely",
      normalizedFilePath: path,
      line,
      message: `\`${key}\` was removed from ${path}.`,
      why: "Every developer who clones after this has one fewer variable in their template, with nothing to tell them. If the code still reads it, the failure appears at runtime — usually as an undefined that propagates somewhere unhelpful.",
    });
  }
};

// ---------------------------------------------------------------------------
// Shape 2 — a dependency version un-pinned.
// ---------------------------------------------------------------------------

/** Version specs that resolve to "whatever is newest at install time". */
const FLOATING_SPECS = new Set(["*", "x", "X", "latest", "next", "canary", "beta", "alpha", "rc", "dev"]);
const GIT_SPEC_RE = /^(git\+|git:|github:|gitlab:|bitbucket:|gist:|https?:\/\/|git:\/\/)/;

type SpecKind = "pinned-or-ranged" | "floating" | "git";

const classifySpec = (raw: string): SpecKind => {
  const spec = raw.trim();
  if (spec.startsWith("file:") || spec.startsWith("link:") || spec.startsWith("workspace:")) {
    return "pinned-or-ranged";
  }
  if (GIT_SPEC_RE.test(spec) || spec.endsWith(".git")) return "git";
  if (spec === "" || FLOATING_SPECS.has(spec)) return "floating";
  return "pinned-or-ranged";
};

const DEP_LINE_RE = /^\s*"([^"]+)"\s*:\s*"([^"]*)"\s*,?\s*$/;

/** The four maps whose values are dependency specs. */
const DEPENDENCY_MAPS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

/**
 * Names that are actually dependencies in this manifest.
 *
 * A `package.json` diff line is just `"key": "value"`, and without knowing which
 * MAP it sits in the shape fired on `"repository"`, on `"homepage"`, on an
 * `engines` entry, and — worst — on an npm script (`"test": "*"`). The manifest
 * is read once so the section is a fact rather than a guess; when it cannot be
 * read, the shape abstains entirely.
 */
const dependencyNames = (manifestText: string | null): Set<string> | null => {
  if (manifestText === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const names = new Set<string>();
  for (const map of DEPENDENCY_MAPS) {
    const entry = (parsed as Record<string, unknown>)[map];
    if (entry === null || typeof entry !== "object") continue;
    for (const name of Object.keys(entry as Record<string, unknown>)) names.add(name);
  }
  return names;
};

const dependencyUnpinned = (
  file: FileDiff,
  path: string,
  manifestDeps: Set<string> | null,
  notes: ChangeNote[],
): void => {
  if (!PACKAGE_JSON_RE.test(path)) return;
  // No manifest, no proof of which section a line lives in — say nothing.
  if (manifestDeps === null) return;

  for (const hunk of file.hunks) {
    const removed = hunk.lines.filter((l) => l.kind === "del");
    const added = hunk.lines.filter((l) => l.kind === "add");
    // Pair positionally, and only when the counts match: `del[i]` and `add[i]`
    // are the same entry exactly when they name the same dependency.
    if (removed.length === 0 || removed.length !== added.length) continue;

    for (let i = 0; i < removed.length; i++) {
      const before = DEP_LINE_RE.exec(removed[i]!.text);
      const after = DEP_LINE_RE.exec(added[i]!.text);
      if (!before || !after) continue;
      if (before[1] !== after[1]) continue; // a different key entirely
      if (!manifestDeps.has(before[1]!)) continue; // not a dependency at all

      const wasKind = classifySpec(before[2]!);
      const nowKind = classifySpec(after[2]!);
      if (wasKind !== "pinned-or-ranged" || nowKind === "pinned-or-ranged") continue;

      notes.push({
        shape: "dependency-unpinned",
        priority: "review-closely",
        normalizedFilePath: path,
        line: added[i]!.line,
        message: `\`${before[1]}\` went from \`${before[2]}\` to \`${after[2]}\`.`,
        why:
          nowKind === "git"
            ? "A git spec resolves against a moving ref, so two installs of the same commit can produce different code — and the registry's tarball integrity check no longer applies."
            : "A floating spec resolves to whatever is newest at install time, so the build is no longer reproducible and a compromised release lands without a code change.",
      });
    }
  }
};

// ---------------------------------------------------------------------------
// Shape 4 — a very small edit to the auth path.
// ---------------------------------------------------------------------------

/**
 * Is this changed line real code? A doc typo, a blank line and a moved import
 * are not the kind of one-line auth edit worth stopping a reviewer for, and
 * without this filter the shape fires on every comment fix in an auth file.
 */
const isSubstantiveLine = (text: string): boolean => {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) return false;
  if (/^import\b/.test(trimmed) || /^export\s+(?:\*|\{)/.test(trimmed)) return false;
  return true;
};

/** Total changed lines across a file, and how many of them are real code. */
const changedLineCounts = (file: FileDiff): { total: number; substantive: number; firstLine: number } => {
  let total = 0;
  let substantive = 0;
  let firstLine = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      total += 1;
      if (isSubstantiveLine(line.text)) {
        substantive += 1;
        if (firstLine === 0) firstLine = line.line;
      }
    }
  }
  return { total, substantive, firstLine };
};

/** Changes this small to the auth path are worth a deliberate second read. */
const SMALL_AUTH_EDIT_MAX_LINES = 3;

const smallAuthEdit = (file: FileDiff, path: string, notes: ChangeNote[]): void => {
  if (!SOURCE_RE.test(path)) return;
  // The path is the only gate. Git's `@@` heading is its GUESS at the enclosing
  // function, derived from a line-shape heuristic, and using it made any file
  // with a nearby `canSubmit` or `roleOf` claim to be on the auth path.
  if (!AUTH_PATH_HINT.test(path)) return;
  if (file.status !== "modified") return;

  const counts = changedLineCounts(file);
  if (counts.substantive === 0) return;
  if (counts.total > SMALL_AUTH_EDIT_MAX_LINES) return;

  notes.push({
    shape: "small-auth-edit",
    priority: "review-closely",
    normalizedFilePath: path,
    line: counts.firstLine,
    message: `${counts.total} line(s) changed on the authentication/authorization path.`,
    why: "A small edit here is the shape most changes to a security boundary take, and the one a reviewer skimming a large diff is likeliest to wave through. Read the whole condition, not the diff.",
  });
};

// ---------------------------------------------------------------------------
// Shape 3 — a migration mixed with feature work. Whole-change-set, no hunks.
// ---------------------------------------------------------------------------

/** A test or fixture file — changing it alongside a migration IS the migration's work. */
const TEST_PATH_RE =
  /(^|\/)(tests?|spec|specs|e2e|__tests__|__mocks__|__fixtures__|fixtures)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;

const migrationMixedWithFeature = (paths: string[], notes: ChangeNote[]): void => {
  const migrations = paths.filter((p) => isMigrationPath(p)).sort();
  if (migrations.length === 0) return;
  // A migration and its own test are one change, not two. Only production
  // source counts as the "feature work" this shape is about.
  const feature = paths.filter((p) => SOURCE_RE.test(p) && !isMigrationPath(p) && !TEST_PATH_RE.test(p)).sort();
  if (feature.length === 0) return;

  notes.push({
    shape: "migration-with-feature-work",
    priority: "notable",
    normalizedFilePath: migrations[0]!,
    line: 0,
    message: `${migrations.length} migration file(s) changed alongside ${feature.length} source file(s).`,
    why: "The two have different revert semantics. Reverting the commit takes the schema change with it, and a schema change is usually the half that cannot simply be undone once it has run in production. Splitting them keeps the rollback honest.",
  });
};

// ---------------------------------------------------------------------------
// Report assembly.
// ---------------------------------------------------------------------------

const PRIORITY_RANK: Record<ChangePriority, number> = { "review-closely": 0, notable: 1 };

const sortNotes = (notes: ChangeNote[]): ChangeNote[] =>
  notes
    .slice()
    .sort(
      (a, b) =>
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
        (a.normalizedFilePath < b.normalizedFilePath ? -1 : a.normalizedFilePath > b.normalizedFilePath ? 1 : 0) ||
        a.line - b.line ||
        (a.shape < b.shape ? -1 : a.shape > b.shape ? 1 : 0),
    );

export interface ChangeShapeOptions {
  /** A base ref (`main`) → `<base>...HEAD`. Omit for the working tree. */
  base?: string;
  /** Examine the staged change set instead. */
  staged?: boolean;
}

/**
 * The diff invocation. Flags are pinned so a user's git config cannot change
 * what is read; `--unified=0` is what makes 1:1 pairing decidable; and
 * `--diff-filter` is deliberately ABSENT because a removed `.env.example` key
 * and a deleted migration are both pure deletions.
 */
const diffArgs = (options: ChangeShapeOptions): { args: string[]; range: string } => {
  const base = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=0"];
  if (options.staged) return { args: [...base, "--cached"], range: "--staged" };
  if (options.base) {
    const range = `${options.base}...HEAD`;
    return { args: [...base, range], range };
  }
  return { args: base, range: "working tree" };
};

export const buildChangeShapeReport = async (
  rootDirectory: string,
  options: ChangeShapeOptions = {},
): Promise<ChangeShapeReport> => {
  const { args, range } = diffArgs(options);
  const empty = (reason: string): ChangeShapeReport => ({
    available: false,
    unavailableReason: reason,
    range,
    notes: [],
    summary: { filesChanged: 0, filesExamined: 0, untrackedFilesNotExamined: 0, notable: 0, reviewClosely: 0 },
  });

  const context = await gitContext(rootDirectory);
  if (context.unavailable) return empty(context.unavailable);

  const result = await gitRun(rootDirectory, args);
  if (result.truncated) {
    // A truncated diff parses cleanly and looks exactly like a smaller,
    // complete one. Reporting it would call every file past the cut clean.
    return empty(`the diff for ${range} is too large to read in full — no shape can be reported honestly`);
  }
  if (result.stdout === null) {
    return empty(`git could not produce a diff for ${range} — is the base ref reachable?`);
  }

  const files = parseUnifiedDiff(result.stdout);

  // An unresolved merge produces a combined diff, whose body is not unified
  // format. Reporting zero shapes for a conflicted tree would be a clean bill
  // of health for a tree that does not even build.
  if (files.some((f) => f.combined)) {
    return empty(
      "this tree has an unresolved merge (git produced a combined diff) — resolve it before reading change shapes",
    );
  }

  const notes: ChangeNote[] = [];
  const examined: Array<{ file: FileDiff; path: string }> = [];

  for (const file of files) {
    const repoPath = file.newPath ?? file.oldPath;
    if (repoPath === null) continue;
    const path = rebaseToScanRoot(repoPath, context.prefix);
    if (path === null) continue; // outside the scanned directory
    if (isGeneratedPath(path)) continue;
    if (file.binary) continue;
    examined.push({ file, path });
  }

  // The manifest is read once so `dependency-unpinned` knows which entries are
  // dependencies rather than scripts, engines or metadata.
  const manifestRev = options.staged ? "" : "HEAD";
  const manifestCache = new Map<string, Set<string> | null>();
  for (const { path } of examined) {
    if (!PACKAGE_JSON_RE.test(path) || manifestCache.has(path)) continue;
    const repoPath = context.prefix + path;
    const text = await gitStdout(rootDirectory, ["show", `${manifestRev}:${repoPath}`]);
    manifestCache.set(path, dependencyNames(text));
  }

  const addedEnvKeys = envKeysAddedAnywhere(examined);
  for (const { file, path } of examined) {
    envKeysRemoved(file, path, addedEnvKeys, notes);
    dependencyUnpinned(file, path, manifestCache.get(path) ?? null, notes);
    smallAuthEdit(file, path, notes);
  }

  const examinedPaths = examined.map((e) => e.path);
  migrationMixedWithFeature(examinedPaths, notes);

  // Working-tree mode never sees an untracked file. Reporting "N of N examined"
  // with a green check while a whole new module sits unread is a clean verdict
  // for something that was not looked at.
  let untracked = 0;
  if (!options.base && !options.staged) {
    const listed = await gitStdout(rootDirectory, ["ls-files", "--others", "--exclude-standard"]);
    untracked = (listed ?? "").split("\n").filter((l) => l.trim() !== "").length;
  }

  const sorted = sortNotes(notes);
  return {
    available: true,
    unavailableReason: null,
    range,
    notes: sorted,
    summary: {
      filesChanged: files.length,
      filesExamined: examinedPaths.length,
      /** New files git is not tracking yet — present, and deliberately unread. */
      untrackedFilesNotExamined: untracked,
      notable: sorted.filter((n) => n.priority === "notable").length,
      reviewClosely: sorted.filter((n) => n.priority === "review-closely").length,
    },
  };
};
