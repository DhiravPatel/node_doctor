/**
 * Fix-as-diff — render an autofix as a patch instead of as prose.
 *
 * An agent can apply a unified diff far more reliably than it can re-derive an
 * edit from a sentence like "add the `node:` prefix": the patch names the exact
 * lines, in the exact order, and fails loudly when the file has drifted. So for
 * the mechanically-safe codemods in `./index.ts` we emit the change as something
 * `git apply` — or a twenty-line applier inside an agent — can consume directly.
 *
 * The diff is produced by hand (zero deps) from a line-level LCS: the common
 * prefix and suffix are trimmed first, so the quadratic table only ever sees the
 * region that actually changed. Output is a byte-for-byte function of its inputs
 * — no timestamps in the file headers, no absolute paths — because a patch that
 * churned between identical runs would poison the snapshot tests and the
 * baseline delta.
 */

import { basename, isAbsolute, relative, sep } from "node:path";
import { fixSource } from "./index.ts";

/** The marker git emits when a side's final line is not newline-terminated. */
const NO_EOL = "\\ No newline at end of file";

/**
 * Above this many LCS cells the diff degrades to "delete everything, insert
 * everything" rather than allocating a huge table. Still a valid patch, just not
 * a minimal one — a pathological input should be coarse, never fatal.
 */
const MAX_LCS_CELLS = 4_000_000;

/** One physical line of one side of the diff. */
interface Line {
  text: string;
  /** True when this line ends the file without a trailing newline. */
  noEol: boolean;
}

interface Op {
  sign: " " | "-" | "+";
  line: Line;
}

/**
 * Lines match only when their terminator matches too. Without the `noEol` half,
 * `"a\n"` → `"a"` (a real, applyable change) would render as an empty patch.
 */
const same = (a: Line, b: Line): boolean => a.text === b.text && a.noEol === b.noEol;

/**
 * Split into lines the way a patch counts them: a trailing newline *terminates*
 * the last line rather than starting an empty one, so `"a\n"` is one line and
 * `""` is none at all.
 */
const toLines = (text: string): Line[] => {
  if (text === "") return [];
  const noEol = !text.endsWith("\n");
  const raw = text.split("\n");
  if (!noEol) raw.pop();
  const last = raw.length - 1;
  return raw.map((t, i) => ({ text: t, noEol: noEol && i === last }));
};

/** Longest-common-subsequence diff over two already-trimmed line runs. */
const lcsOps = (a: Line[], b: Line[]): Op[] => {
  const n = a.length;
  const m = b.length;
  const ops: Op[] = [];
  if (n === 0 && m === 0) return ops;
  if (n === 0 || m === 0 || (n + 1) * (m + 1) > MAX_LCS_CELLS) {
    for (const line of a) ops.push({ sign: "-", line });
    for (const line of b) ops.push({ sign: "+", line });
    return ops;
  }

  // dp[i][j] = LCS length of a[i..] vs b[j..]. Filled backwards so the forward
  // walk below can decide each step with two lookups.
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = same(a[i], b[j])
        ? dp[(i + 1) * w + (j + 1)] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
    }
  }

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (same(a[i], b[j])) {
      ops.push({ sign: " ", line: b[j] });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
      // Deletions win ties, so a replacement reads as `-old` then `+new`.
      ops.push({ sign: "-", line: a[i] });
      i++;
    } else {
      ops.push({ sign: "+", line: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ sign: "-", line: a[i++] });
  while (j < m) ops.push({ sign: "+", line: b[j++] });
  return ops;
};

/** The full op stream, with the untouched head and tail trimmed off first. */
const diffOps = (a: Line[], b: Line[]): Op[] => {
  const n = a.length;
  const m = b.length;
  let lo = 0;
  while (lo < n && lo < m && same(a[lo], b[lo])) lo++;
  let hiA = n;
  let hiB = m;
  while (hiA > lo && hiB > lo && same(a[hiA - 1], b[hiB - 1])) {
    hiA--;
    hiB--;
  }

  const ops: Op[] = [];
  for (let k = 0; k < lo; k++) ops.push({ sign: " ", line: b[k] });
  for (const op of lcsOps(a.slice(lo, hiA), b.slice(lo, hiB))) ops.push(op);
  for (let k = hiB; k < m; k++) ops.push({ sign: " ", line: b[k] });
  return ops;
};

/**
 * Patch paths are always forward-slashed and project-relative. `/Users/alice/…`
 * inside generated content would make the patch machine-specific and break the
 * determinism invariant, so an absolute path is rebased onto the project root
 * the same way `scan.ts` builds `normalizedFilePath` — `relative(root, file)`,
 * separators normalized. Callers that already hold a `Finding.normalizedFilePath`
 * can pass it straight through; it is relative already and survives untouched.
 *
 * Merely stripping the leading `/` (the obvious shortcut) is *not* enough: it
 * turns `/Users/alice/app/a.ts` into `Users/alice/app/a.ts`, which still carries
 * the machine's directory names into the output.
 */
const patchPath = (filePath: string, rootDirectory: string | undefined): string => {
  const rebased = isAbsolute(filePath)
    ? relative(rootDirectory ?? process.cwd(), filePath) || basename(filePath)
    : filePath;
  return rebased.split(sep).join("/").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
};

export interface UnifiedDiffOptions {
  /** Unchanged lines kept on each side of a change (default 3). */
  context?: number;
  /**
   * Project root used to relativize an absolute `filePath`. Defaults to
   * `process.cwd()`; supply it explicitly whenever the scan root is not the
   * working directory, or the patch header will not match the repo layout.
   */
  rootDirectory?: string;
}

/**
 * Render `before` → `after` as a unified diff with `a/`+`b/` headers. Returns
 * `""` when the two texts are identical — an empty patch, not an empty hunk.
 */
export const unifiedDiff = (
  filePath: string,
  before: string,
  after: string,
  options: UnifiedDiffOptions = {},
): string => {
  if (before === after) return "";
  // NaN would propagate through every comparison and arrive in the headers as
  // `@@ -undefined,NaN @@` — a silently invalid patch, which is worse than a
  // coarse one. Infinity is fine and means "whole file"; negatives clamp to 0.
  const requested = options.context ?? 3;
  const context = Number.isNaN(requested) ? 3 : Math.max(0, Math.trunc(requested));

  const ops = diffOps(toLines(before), toLines(after));

  const changed: number[] = [];
  for (let idx = 0; idx < ops.length; idx++) {
    if (ops[idx].sign !== " ") changed.push(idx);
  }
  if (changed.length === 0) return "";

  // Line numbers come from how many lines each side has consumed *before* an op,
  // which also gives the right answer for a zero-length side (`@@ -0,0 +1,3 @@`).
  const oldBefore = new Array<number>(ops.length + 1);
  const newBefore = new Array<number>(ops.length + 1);
  let oldSeen = 0;
  let newSeen = 0;
  for (let idx = 0; idx < ops.length; idx++) {
    oldBefore[idx] = oldSeen;
    newBefore[idx] = newSeen;
    if (ops[idx].sign !== "+") oldSeen++;
    if (ops[idx].sign !== "-") newSeen++;
  }
  oldBefore[ops.length] = oldSeen;
  newBefore[ops.length] = newSeen;

  // Two changes separated by at most 2*context unchanged lines share one hunk:
  // their context blocks would otherwise touch and repeat the same lines twice.
  const groups: Array<[number, number]> = [];
  let gStart = changed[0];
  let gEnd = changed[0];
  for (let c = 1; c < changed.length; c++) {
    const idx = changed[c];
    if (idx - gEnd - 1 <= context * 2) {
      gEnd = idx;
    } else {
      groups.push([gStart, gEnd]);
      gStart = idx;
      gEnd = idx;
    }
  }
  groups.push([gStart, gEnd]);

  const path = patchPath(filePath, options.rootDirectory);
  const out: string[] = [`--- a/${path}`, `+++ b/${path}`];

  for (const [start, end] of groups) {
    const from = Math.max(0, start - context);
    const to = Math.min(ops.length - 1, end + context);

    const oldLen = oldBefore[to + 1] - oldBefore[from];
    const newLen = newBefore[to + 1] - newBefore[from];
    const oldStart = oldLen > 0 ? oldBefore[from] + 1 : oldBefore[from];
    const newStart = newLen > 0 ? newBefore[from] + 1 : newBefore[from];
    out.push(`@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`);

    for (let idx = from; idx <= to; idx++) {
      const op = ops[idx];
      out.push(`${op.sign}${op.line.text}`);
      if (op.line.noEol) out.push(NO_EOL);
    }
  }

  return `${out.join("\n")}\n`;
};

export interface FixDiff {
  /** A unified diff, or `""` when nothing changed. */
  diff: string;
  /** How many edits the fixers applied. */
  applied: number;
}

/**
 * Run the safe autofixers over one file's source and hand the result back as a
 * patch rather than as replacement text — the form an agent can apply without
 * having to rewrite the whole file (and the form a human can review).
 */
export const fixDiffForFile = (
  filePath: string,
  sourceText: string,
  ruleIds?: Set<string>,
  options: UnifiedDiffOptions = {},
): FixDiff => {
  const { fixed, applied } = fixSource(filePath, sourceText, ruleIds);
  if (applied === 0) return { diff: "", applied: 0 };
  const diff = unifiedDiff(filePath, sourceText, fixed, options);
  // A fixer that reported edits but moved no bytes must not advertise a patch it
  // cannot supply — `diff` and `applied` always agree about whether work happened.
  return diff === "" ? { diff: "", applied: 0 } : { diff, applied };
};
