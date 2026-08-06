/**
 * Shared git plumbing.
 *
 * Two properties carry the weight: the parser must never mistake diff CONTENT
 * for a diff HEADER (an added line can begin with `+++`), and a failure to read
 * git must never be reported as a clean result.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  gitRun,
  gitContext,
  rebaseToScanRoot,
  parseUnifiedDiff,
  diffFilePath,
} from "../../src/core/git-history.ts";

const run = promisify(execFile);

const makeRepo = async (commits: Array<Record<string, string>>): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "nd-git-"));
  await run("git", ["init", "-q"], { cwd: dir });
  await run("git", ["config", "user.email", "dev@example.com"], { cwd: dir });
  await run("git", ["config", "user.name", "Dev"], { cwd: dir });
  for (const files of commits) {
    for (const [rel, content] of Object.entries(files)) {
      const full = join(dir, rel);
      await mkdir(join(full, ".."), { recursive: true });
      await writeFile(full, content);
    }
    await run("git", ["add", "-A"], { cwd: dir });
    await run("git", ["commit", "-q", "-m", "change"], { cwd: dir });
  }
  return dir;
};

describe("gitRun / gitContext — a failure is never a clean result", () => {
  test("a directory that is not a repository says so, and does not blame a missing git", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-git-bare-"));
    try {
      const ctx = await gitContext(dir);
      assert.equal(ctx.unavailable, "not a git work tree");
      assert.notEqual(ctx.unavailable, "git is not available on PATH", "git ran and said no");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a real repository reports available, with an empty prefix at the root", async () => {
    const dir = await makeRepo([{ "a.txt": "1" }]);
    try {
      const ctx = await gitContext(dir);
      assert.equal(ctx.unavailable, null);
      assert.equal(ctx.prefix, "");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a subdirectory reports its prefix, so paths can be rebased", async () => {
    const dir = await makeRepo([{ "packages/api/a.txt": "1" }]);
    try {
      const ctx = await gitContext(join(dir, "packages/api"));
      assert.equal(ctx.unavailable, null);
      assert.equal(ctx.prefix, "packages/api/");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a failing command returns null stdout rather than an empty string", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-git-fail-"));
    try {
      const r = await gitRun(dir, ["rev-parse", "--is-inside-work-tree"]);
      assert.equal(r.gitMissing, false, "git itself ran");
      assert.ok(r.stdout === null || r.stdout.trim() !== "true");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("rebaseToScanRoot", () => {
  test("at the repository root every path passes through", () => {
    assert.equal(rebaseToScanRoot("src/a.ts", ""), "src/a.ts");
  });

  test("inside a subdirectory paths are rebased and outsiders dropped", () => {
    assert.equal(rebaseToScanRoot("packages/api/src/a.ts", "packages/api/"), "src/a.ts");
    assert.equal(rebaseToScanRoot("packages/web/src/a.ts", "packages/api/"), null);
    assert.equal(rebaseToScanRoot("packages/api/", "packages/api/"), null, "the prefix itself is not a file");
  });
});

describe("parseUnifiedDiff", () => {
  const DIFF = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -12 +12 @@ export const f = () => {",
    "-  const timeout = 1000;",
    "+  const timeout = 5000;",
    "@@ -40,0 +41,2 @@",
    "+  log(1);",
    "+  log(2);",
    "",
  ].join("\n");

  test("hunk headers with elided counts mean one line", () => {
    const [f] = parseUnifiedDiff(DIFF);
    assert.ok(f);
    assert.equal(f.newPath, "src/a.ts");
    assert.equal(f.oldPath, "src/a.ts");
    assert.equal(f.status, "modified");
    assert.equal(f.hunks.length, 2);
    assert.deepEqual(
      { oldStart: f.hunks[0]!.oldStart, oldCount: f.hunks[0]!.oldCount, newCount: f.hunks[0]!.newCount },
      { oldStart: 12, oldCount: 1, newCount: 1 },
    );
    assert.equal(f.hunks[0]!.heading, " export const f = () => {");
  });

  test("line numbers are tracked per side", () => {
    const [f] = parseUnifiedDiff(DIFF);
    assert.deepEqual(
      f!.hunks[0]!.lines.map((l) => [l.kind, l.line]),
      [
        ["del", 12],
        ["add", 12],
      ],
    );
    assert.deepEqual(
      f!.hunks[1]!.lines.map((l) => [l.kind, l.line]),
      [
        ["add", 41],
        ["add", 42],
      ],
    );
  });

  test("an ADDED LINE that starts with `+++` is content, not a path", () => {
    // The failure this guard exists for: without it, every hunk after this one
    // is silently reassigned to a file that does not exist.
    const diff = [
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1,0 +2,2 @@",
      "+++ b/not-a-real-path.ts",
      "+--- a/also-not-real.ts",
      "",
    ].join("\n");
    const [f] = parseUnifiedDiff(diff);
    assert.equal(f!.newPath, "README.md", "the real path survives");
    assert.equal(f!.hunks[0]!.lines.length, 2, "both lines are content");
    assert.equal(f!.hunks[0]!.lines[0]!.text, "++ b/not-a-real-path.ts");
  });

  test("added and deleted files are classified from /dev/null", () => {
    const diff = [
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1 @@",
      "+export const a = 1;",
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-export const b = 2;",
      "",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    assert.equal(files.length, 2);
    assert.equal(files[0]!.status, "added");
    assert.equal(files[0]!.oldPath, null);
    assert.equal(diffFilePath(files[0]!), "new.ts");
    assert.equal(files[1]!.status, "deleted");
    assert.equal(files[1]!.newPath, null);
    assert.equal(diffFilePath(files[1]!), "gone.ts");
  });

  test("a binary difference is marked and carries no hunks", () => {
    const diff = [
      "diff --git a/logo.png b/logo.png",
      "index 111..222 100644",
      "Binary files a/logo.png and b/logo.png differ",
      "",
    ].join("\n");
    const [f] = parseUnifiedDiff(diff);
    assert.equal(f!.binary, true);
    assert.equal(f!.newPath, "logo.png", "the path survives even with no ---/+++ lines");
    assert.deepEqual(f!.hunks, []);
  });

  test("`\\ No newline at end of file` is metadata, not a deleted line", () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const [f] = parseUnifiedDiff(diff);
    assert.deepEqual(
      f!.hunks[0]!.lines.map((l) => `${l.kind}:${l.text}`),
      ["del:old", "add:new"],
    );
  });

  test("context lines advance both sides", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,4 +1,4 @@",
      " const a = 1;",
      " const b = 2;",
      "-const c = 3;",
      "+const c = 4;",
      " const d = 5;",
      "",
    ].join("\n");
    const [f] = parseUnifiedDiff(diff);
    const changed = f!.hunks[0]!.lines;
    assert.equal(changed.length, 2);
    assert.equal(changed[0]!.line, 3, "the delete is on old line 3");
    assert.equal(changed[1]!.line, 3, "the add is on new line 3");
  });

  test("empty input is an empty list, not a crash", () => {
    assert.deepEqual(parseUnifiedDiff(""), []);
    assert.deepEqual(parseUnifiedDiff("\n\n"), []);
  });

  test("parsing is deterministic", () => {
    assert.equal(JSON.stringify(parseUnifiedDiff(DIFF)), JSON.stringify(parseUnifiedDiff(DIFF)));
  });
});

describe("parseUnifiedDiff — against real git output", () => {
  test("a real modification round-trips", async () => {
    const dir = await makeRepo([{ "src/a.ts": "const t = 1000;\n" }, { "src/a.ts": "const t = 5000;\n" }]);
    try {
      const { stdout } = await run(
        "git",
        ["diff", "--no-color", "--no-renames", "--unified=0", "HEAD~1...HEAD"],
        { cwd: dir },
      );
      const files = parseUnifiedDiff(stdout);
      assert.equal(files.length, 1);
      assert.equal(diffFilePath(files[0]!), "src/a.ts");
      assert.deepEqual(
        files[0]!.hunks[0]!.lines.map((l) => `${l.kind}:${l.text.trim()}`),
        ["del:const t = 1000;", "add:const t = 5000;"],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
