import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { unifiedDiff, fixDiffForFile } from "../../src/fix/diff.ts";

const NO_EOL = "\\ No newline at end of file";

/** `line 1\nline 2\n…` — a boring file whose line numbers are self-describing. */
const numbered = (count: number): string =>
  `${Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n")}\n`;

/** Replace the 1-based `line` of `text` with `replacement`. */
const replaceLine = (text: string, line: number, replacement: string): string => {
  const rows = text.split("\n");
  rows[line - 1] = replacement;
  return rows.join("\n");
};

const hunkHeaders = (diff: string): string[] =>
  diff.split("\n").filter((l) => l.startsWith("@@"));

const bodyLines = (diff: string): string[] =>
  diff.split("\n").filter((l) => l.length > 0 && !l.startsWith("@@") && !l.startsWith("---") && !l.startsWith("+++"));

/**
 * A deliberately strict unified-diff applier. It verifies every context and
 * deleted line against the source and cross-checks each hunk's declared lengths
 * and start offsets, so a round-trip through it is a proof that the hunk math is
 * right — not merely that the text happened to come out.
 */
const applyPatch = (before: string, diff: string): string => {
  if (diff === "") return before;

  const beforeNoEol = before !== "" && !before.endsWith("\n");
  const old: string[] = [];
  if (before !== "") {
    const rows = before.split("\n");
    if (!beforeNoEol) rows.pop();
    for (const r of rows) old.push(r);
  }

  const dl = diff.split("\n");
  assert.equal(dl[dl.length - 1], "", "a patch must end with a newline");
  dl.pop();
  assert.match(dl[0], /^--- a\/[^\\]*$/, "missing or malformed --- header");
  assert.match(dl[1], /^\+\+\+ b\/[^\\]*$/, "missing or malformed +++ header");

  const out: string[] = [];
  let cursor = 0;
  let outNoEol = false;
  let i = 2;

  while (i < dl.length) {
    const header = dl[i++];
    const m = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(header);
    if (!m) throw new Error(`bad hunk header: ${JSON.stringify(header)}`);
    const oldStart = Number(m[1]);
    const oldLen = Number(m[2]);
    const newStart = Number(m[3]);
    const newLen = Number(m[4]);

    const target = oldLen > 0 ? oldStart - 1 : oldStart;
    assert.ok(target >= cursor, "hunks must be ordered and non-overlapping");
    assert.ok(target <= old.length, `hunk starts past the end of the file: ${header}`);
    while (cursor < target) {
      out.push(old[cursor++]);
      outNoEol = false;
    }
    assert.equal(
      out.length,
      newLen > 0 ? newStart - 1 : newStart,
      `newStart disagrees with the lines emitted so far: ${header}`,
    );

    let seenOld = 0;
    let seenNew = 0;
    while (seenOld < oldLen || seenNew < newLen) {
      const body = dl[i++];
      if (body === undefined) throw new Error(`hunk ended early: ${header}`);
      const sign = body[0];
      const text = body.slice(1);
      if (sign === " ") {
        assert.equal(old[cursor], text, "context line does not match the source");
        cursor++;
        seenOld++;
        out.push(text);
        seenNew++;
        outNoEol = false;
      } else if (sign === "-") {
        assert.equal(old[cursor], text, "deleted line does not match the source");
        cursor++;
        seenOld++;
      } else if (sign === "+") {
        out.push(text);
        seenNew++;
        outNoEol = false;
      } else {
        throw new Error(`bad body line: ${JSON.stringify(body)}`);
      }
      if (dl[i] === NO_EOL) {
        i++;
        if (sign !== "-") outNoEol = true;
      }
    }
    assert.equal(seenOld, oldLen, `hunk consumed the wrong number of old lines: ${header}`);
    assert.equal(seenNew, newLen, `hunk produced the wrong number of new lines: ${header}`);
  }

  if (cursor < old.length) {
    while (cursor < old.length) out.push(old[cursor++]);
    outNoEol = beforeNoEol;
  }

  if (out.length === 0) return "";
  return out.join("\n") + (outNoEol ? "" : "\n");
};

describe("unifiedDiff", () => {
  test("emits a numerically correct hunk header for a mid-file change", () => {
    const before = numbered(10);
    const after = replaceLine(before, 5, "line 5 changed");
    const diff = unifiedDiff("src/a.ts", before, after);

    assert.equal(diff.split("\n")[0], "--- a/src/a.ts");
    assert.equal(diff.split("\n")[1], "+++ b/src/a.ts");
    assert.deepEqual(hunkHeaders(diff), ["@@ -2,7 +2,7 @@"]);
    assert.ok(diff.includes("\n-line 5\n"));
    assert.ok(diff.includes("\n+line 5 changed\n"));
    assert.equal(applyPatch(before, diff), after);
  });

  test("an insertion-only change has no deleted lines", () => {
    const before = numbered(10);
    const rows = before.split("\n");
    rows.splice(5, 0, "inserted");
    const after = rows.join("\n");

    const diff = unifiedDiff("a.ts", before, after);
    assert.deepEqual(hunkHeaders(diff), ["@@ -3,6 +3,7 @@"]);
    assert.equal(bodyLines(diff).filter((l) => l.startsWith("-")).length, 0);
    assert.deepEqual(
      bodyLines(diff).filter((l) => l.startsWith("+")),
      ["+inserted"],
    );
    assert.equal(applyPatch(before, diff), after);
  });

  test("a deletion-only change has no added lines", () => {
    const before = numbered(10);
    const rows = before.split("\n");
    rows.splice(4, 1); // drop "line 5"
    const after = rows.join("\n");

    const diff = unifiedDiff("a.ts", before, after);
    assert.deepEqual(hunkHeaders(diff), ["@@ -2,7 +2,6 @@"]);
    assert.equal(bodyLines(diff).filter((l) => l.startsWith("+")).length, 0);
    assert.deepEqual(
      bodyLines(diff).filter((l) => l.startsWith("-")),
      ["-line 5"],
    );
    assert.equal(applyPatch(before, diff), after);
  });

  test("a change on the first line clamps the leading context", () => {
    const before = numbered(10);
    const after = replaceLine(before, 1, "first");
    const diff = unifiedDiff("a.ts", before, after);

    assert.deepEqual(hunkHeaders(diff), ["@@ -1,4 +1,4 @@"]);
    assert.equal(applyPatch(before, diff), after);
  });

  test("a change on the last line clamps the trailing context", () => {
    const before = numbered(10);
    const after = replaceLine(before, 10, "last");
    const diff = unifiedDiff("a.ts", before, after);

    assert.deepEqual(hunkHeaders(diff), ["@@ -7,4 +7,4 @@"]);
    assert.equal(applyPatch(before, diff), after);
  });

  test("identical input produces no diff at all — not even headers", () => {
    assert.equal(unifiedDiff("a.ts", "", ""), "");
    assert.equal(unifiedDiff("a.ts", numbered(10), numbered(10)), "");
    assert.equal(unifiedDiff("a.ts", "no trailing newline", "no trailing newline"), "");
  });

  test("marks a missing trailing newline on both sides", () => {
    const before = "alpha\nbeta\ngamma";
    const after = "alpha\nbeta\nzeta";
    const diff = unifiedDiff("a.ts", before, after);

    assert.deepEqual(hunkHeaders(diff), ["@@ -1,3 +1,3 @@"]);
    assert.equal(diff.split("\n").filter((l) => l === NO_EOL).length, 2);
    assert.ok(diff.includes(`-gamma\n${NO_EOL}\n`));
    assert.ok(diff.includes(`+zeta\n${NO_EOL}\n`));
    assert.equal(applyPatch(before, diff), after);
  });

  test("dropping the trailing newline is itself a change", () => {
    const before = "alpha\nbeta\ngamma\n";
    const after = "alpha\nbeta\ngamma";
    const diff = unifiedDiff("a.ts", before, after);

    assert.notEqual(diff, "");
    assert.deepEqual(hunkHeaders(diff), ["@@ -1,3 +1,3 @@"]);
    assert.deepEqual(bodyLines(diff).slice(-3), ["-gamma", "+gamma", NO_EOL]);
    assert.equal(applyPatch(before, diff), after);
  });

  test("nearby changes coalesce into one hunk, distant ones into two", () => {
    const before = numbered(20);

    const near = replaceLine(replaceLine(before, 5, "five!"), 9, "nine!");
    const nearDiff = unifiedDiff("a.ts", before, near);
    assert.equal(hunkHeaders(nearDiff).length, 1, "3 unchanged lines apart must merge");
    assert.equal(applyPatch(before, nearDiff), near);

    const far = replaceLine(replaceLine(before, 5, "five!"), 15, "fifteen!");
    const farDiff = unifiedDiff("a.ts", before, far);
    assert.deepEqual(hunkHeaders(farDiff), ["@@ -2,7 +2,7 @@", "@@ -12,7 +12,7 @@"]);
    assert.equal(applyPatch(before, farDiff), far);
  });

  test("context: 0 emits only the changed lines", () => {
    const before = numbered(10);
    const after = replaceLine(before, 5, "five!");
    const diff = unifiedDiff("a.ts", before, after, { context: 0 });

    assert.deepEqual(hunkHeaders(diff), ["@@ -5,1 +5,1 @@"]);
    assert.deepEqual(bodyLines(diff), ["-line 5", "+five!"]);
    assert.equal(applyPatch(before, diff), after);
  });

  test("insertion into an empty file uses a zero-length old side", () => {
    const after = "alpha\nbeta\n";
    const diff = unifiedDiff("a.ts", "", after);

    assert.deepEqual(hunkHeaders(diff), ["@@ -0,0 +1,2 @@"]);
    assert.equal(applyPatch("", diff), after);
  });

  test("deleting every line uses a zero-length new side", () => {
    const before = "alpha\nbeta\n";
    const diff = unifiedDiff("a.ts", before, "");

    assert.deepEqual(hunkHeaders(diff), ["@@ -1,2 +0,0 @@"]);
    assert.equal(applyPatch(before, diff), "");
  });

  test("every shape round-trips through a strict applier", () => {
    const ten = numbered(10);
    const cases: Array<[string, string, string]> = [
      ["mid-file replace", ten, replaceLine(ten, 6, "six!")],
      ["first line", ten, replaceLine(ten, 1, "one!")],
      ["last line", ten, replaceLine(ten, 10, "ten!")],
      ["prepend", ten, `head\n${ten}`],
      ["append", ten, `${ten}tail\n`],
      ["truncate to one line", ten, "line 1\n"],
      ["grow from one line", "line 1\n", ten],
      ["swap everything", ten, numbered(10).toUpperCase()],
      ["no eol both sides", "a\nb\nc", "a\nB\nc"],
      ["no eol, append", "a\nb\nc", "a\nb\nc\nd\n"],
      ["gain a trailing newline", "a\nb", "a\nb\n"],
      ["empty to empty-ish", "", "\n"],
      ["blank lines", "a\n\n\nb\n", "a\n\nb\n"],
      ["duplicate lines", "x\nx\nx\n", "x\ny\nx\nx\n"],
      ["many scattered edits", numbered(40), replaceLine(replaceLine(replaceLine(numbered(40), 3, "A"), 20, "B"), 39, "C")],
    ];

    for (const [name, before, after] of cases) {
      for (const context of [0, 1, 3, 5]) {
        const diff = unifiedDiff("a.ts", before, after, { context });
        assert.equal(applyPatch(before, diff), after, `${name} (context ${context})`);
      }
    }
  });

  test("normalizes the patch path and is byte-stable across runs", () => {
    const before = numbered(6);
    const after = replaceLine(before, 3, "three!");

    const win = unifiedDiff("src\\fix\\a.ts", before, after);
    assert.ok(win.startsWith("--- a/src/fix/a.ts\n+++ b/src/fix/a.ts\n"));
    assert.ok(unifiedDiff("./a.ts", before, after).startsWith("--- a/a.ts\n"));

    assert.equal(unifiedDiff("a.ts", before, after), unifiedDiff("a.ts", before, after));
  });

  test("an absolute path is rebased on the root, not just stripped of its slash", () => {
    const before = numbered(6);
    const after = replaceLine(before, 3, "three!");

    const diff = unifiedDiff("/Users/alice/work/app/src/a.ts", before, after, {
      rootDirectory: "/Users/alice/work/app",
    });
    assert.ok(diff.startsWith("--- a/src/a.ts\n+++ b/src/a.ts\n"), diff.split("\n")[0]);
    // The whole point: no machine-specific directory survives into the content.
    assert.ok(!diff.includes("alice"), "the home directory leaked into the patch");
    assert.ok(!diff.includes("Users/"), "an absolute path leaked into the patch");

    // Two developers with the same repo at different checkout paths must produce
    // byte-identical patches — that is the determinism invariant.
    const other = unifiedDiff("/srv/ci/build/12345/src/a.ts", before, after, {
      rootDirectory: "/srv/ci/build/12345",
    });
    assert.equal(other, diff);
  });

  test("an absolute path under the cwd needs no explicit root", () => {
    const before = numbered(4);
    const after = replaceLine(before, 2, "two!");
    const diff = unifiedDiff(`${process.cwd()}/src/fix/diff.ts`, before, after);
    assert.ok(diff.startsWith("--- a/src/fix/diff.ts\n"), diff.split("\n")[0]);
  });

  test("a nonsensical context width falls back instead of emitting NaN headers", () => {
    const before = numbered(6);
    const after = replaceLine(before, 3, "three!");

    const nan = unifiedDiff("a.ts", before, after, { context: Number.NaN });
    assert.equal(nan, unifiedDiff("a.ts", before, after), "NaN must fall back to the default");
    for (const header of hunkHeaders(nan)) {
      assert.match(header, /^@@ -\d+,\d+ \+\d+,\d+ @@$/, `invalid header: ${header}`);
    }
    assert.equal(applyPatch(before, nan), after);

    // Negatives clamp to zero context; Infinity means "the whole file".
    assert.equal(
      unifiedDiff("a.ts", before, after, { context: -5 }),
      unifiedDiff("a.ts", before, after, { context: 0 }),
    );
    const all = unifiedDiff("a.ts", before, after, { context: Number.POSITIVE_INFINITY });
    assert.deepEqual(hunkHeaders(all), ["@@ -1,6 +1,6 @@"]);
    assert.equal(applyPatch(before, all), after);
  });

  test("carriage returns are content, not line terminators", () => {
    const before = "alpha\r\nbeta\r\ngamma\r\n";
    const after = "alpha\r\nBETA\r\ngamma\r\n";
    const diff = unifiedDiff("a.ts", before, after);

    assert.deepEqual(hunkHeaders(diff), ["@@ -1,3 +1,3 @@"]);
    assert.ok(diff.includes("-beta\r\n"), "the CR must ride along with the deleted line");
    assert.ok(diff.includes("+BETA\r\n"));
    assert.equal(applyPatch(before, diff), after);
  });

  test("source lines that look like patch syntax stay unambiguous", () => {
    // A file containing the no-newline marker, a hunk header and diff signs must
    // not be able to forge patch structure — every body line carries a sign.
    const before = ["@@ -1,1 +1,1 @@", NO_EOL, "--- a/evil.ts", "-gotcha", "keep"].join("\n") + "\n";
    const after = replaceLine(before, 4, "-changed");
    const diff = unifiedDiff("a.ts", before, after);

    assert.deepEqual(hunkHeaders(diff), ["@@ -1,5 +1,5 @@"], "a body line was read as a header");
    assert.equal(diff.split("\n").filter((l) => l === NO_EOL).length, 0, "a literal marker was emitted bare");
    assert.equal(applyPatch(before, diff), after);
  });

  test("a file too large for the LCS table still yields a valid patch", () => {
    // Past MAX_LCS_CELLS the diff degrades to delete-all/insert-all. Coarse is
    // acceptable; wrong is not — the patch must still reconstruct the file.
    const before = `head\n${Array.from({ length: 2100 }, (_, i) => `old ${i}`).join("\n")}\ntail\n`;
    const after = `head\n${Array.from({ length: 2100 }, (_, i) => `new ${i}`).join("\n")}\ntail\n`;

    const diff = unifiedDiff("big.ts", before, after);
    assert.equal(hunkHeaders(diff).length, 1);
    assert.deepEqual(hunkHeaders(diff), ["@@ -1,2102 +1,2102 @@"]);
    assert.equal(applyPatch(before, diff), after);
  });
});

describe("fixDiffForFile", () => {
  test("renders the node: protocol codemod as an applyable patch", () => {
    const src = [
      "import fs from \"fs\";",
      "import { join } from \"path\";",
      "",
      "export const read = (p) => fs.readFileSync(join(p, \"x\"));",
      "",
    ].join("\n");

    const { diff, applied } = fixDiffForFile("src/read.ts", src);
    assert.equal(applied, 2);
    assert.ok(diff.startsWith("--- a/src/read.ts\n+++ b/src/read.ts\n"));
    assert.deepEqual(hunkHeaders(diff), ["@@ -1,4 +1,4 @@"]);
    assert.deepEqual(
      bodyLines(diff).filter((l) => l.startsWith("-") || l.startsWith("+")),
      [
        "-import fs from \"fs\";",
        "-import { join } from \"path\";",
        "+import fs from \"node:fs\";",
        "+import { join } from \"node:path\";",
      ],
    );

    const expected = src
      .replace("\"fs\"", "\"node:fs\"")
      .replace("\"path\"", "\"node:path\"");
    assert.equal(applyPatch(src, diff), expected);
  });

  test("a clean file yields no patch and no edits", () => {
    const src = "import fs from \"node:fs\";\nimport express from \"express\";\n";
    assert.deepEqual(fixDiffForFile("a.ts", src), { diff: "", applied: 0 });
  });

  test("an unparsable file yields no patch", () => {
    assert.deepEqual(fixDiffForFile("a.ts", "import fs from \"fs\" const (;"), { diff: "", applied: 0 });
  });

  test("honours the ruleIds filter", () => {
    const src = "const os = require(\"os\");\n";

    const selected = fixDiffForFile("a.ts", src, new Set(["prefer-node-protocol-imports"]));
    assert.equal(selected.applied, 1);
    assert.ok(selected.diff.includes("+const os = require(\"node:os\");"));
    assert.equal(applyPatch(src, selected.diff), "const os = require(\"node:os\");\n");

    assert.deepEqual(fixDiffForFile("a.ts", src, new Set(["some-other-rule"])), { diff: "", applied: 0 });
  });

  test("forwards diff options, so an absolute path never reaches the patch", () => {
    const src = "import fs from \"fs\";\nconst x = 1;\n";
    const { diff } = fixDiffForFile("/Users/alice/work/app/src/read.ts", src, undefined, {
      rootDirectory: "/Users/alice/work/app",
      context: 0,
    });

    assert.ok(diff.startsWith("--- a/src/read.ts\n+++ b/src/read.ts\n"), diff.split("\n")[0]);
    assert.ok(!diff.includes("alice"), "the home directory leaked into the patch");
    assert.deepEqual(hunkHeaders(diff), ["@@ -1,1 +1,1 @@"], "context: 0 was not forwarded");
  });

  test("a patch for a large file only covers the changed region", () => {
    const filler = Array.from({ length: 60 }, (_, i) => `const v${i} = ${i};`).join("\n");
    const src = `${filler}\nimport fs from "fs";\n`;

    const { diff, applied } = fixDiffForFile("a.ts", src);
    assert.equal(applied, 1);
    assert.deepEqual(hunkHeaders(diff), ["@@ -58,4 +58,4 @@"]);
    assert.ok(diff.split("\n").length < 12, "the patch must not restate the whole file");
    assert.equal(applyPatch(src, diff), `${filler}\nimport fs from "node:fs";\n`);
  });
});
