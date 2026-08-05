/**
 * §160 — Line-Age & Churn-Weighted Risk.
 *
 * The defining property of this module is that it CANNOT produce a false
 * positive: it never creates or removes a finding, only re-orders them. Most of
 * these tests exist to pin that property, plus the graceful degradation when
 * there is no git history to read.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { buildChurnReport, weightByChurn } from "../../src/core/churn.ts";

const run = promisify(execFile);

/** A throwaway repo with a controlled commit history. */
const makeRepo = async (
  commits: Array<Record<string, string>>,
): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "nd-churn-"));
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

const finding = (normalizedFilePath: string, line = 1) => ({ normalizedFilePath, line });

describe("buildChurnReport — reads history", () => {
  test("counts commits per file, newest-first recency", async () => {
    const dir = await makeRepo([
      { "src/hot.ts": "export const a = 1;" },
      { "src/hot.ts": "export const a = 2;", "src/cold.ts": "export const b = 1;" },
      { "src/hot.ts": "export const a = 3;" },
    ]);
    try {
      const r = await buildChurnReport(dir);
      assert.equal(r.available, true);
      assert.equal(r.summary.commitsScanned, 3);

      const hot = r.files.find((f) => f.normalizedFilePath === "src/hot.ts")!;
      const cold = r.files.find((f) => f.normalizedFilePath === "src/cold.ts")!;
      assert.equal(hot.commits, 3);
      assert.equal(cold.commits, 1);
      assert.ok(hot.score > cold.score, "more commits, more recent → higher score");
      assert.equal(hot.lastTouchedCommitsAgo, 0, "changed in the newest commit");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("files are sorted by score, highest first", async () => {
    const dir = await makeRepo([
      { "src/a.ts": "1", "src/b.ts": "1" },
      { "src/a.ts": "2" },
      { "src/a.ts": "3" },
    ]);
    try {
      const r = await buildChurnReport(dir);
      for (let i = 1; i < r.files.length; i++) {
        assert.ok(r.files[i - 1]!.score >= r.files[i]!.score, "non-increasing score order");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("docs, lockfiles and generated artifacts are never refactor magnets", async () => {
    // These churn by design; calling them "begging to be split" is pure noise.
    const commits = Array.from({ length: 14 }, (_, i) => ({
      "CHANGELOG.md": `entry ${i}`,
      "package-lock.json": `{"v":${i}}`,
      "src/core/registry.ts": `export const N = ${i};`,
    }));
    const dir = await makeRepo(commits);
    try {
      const r = await buildChurnReport(dir);
      const magnets = r.refactorMagnets.map((f) => f.normalizedFilePath);
      assert.deepEqual(magnets, [], "nothing here is a hand-maintained source hotspot");
      // …but they are still tracked, so findings in them could still be weighted.
      assert.ok(r.files.some((f) => f.normalizedFilePath === "CHANGELOG.md"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a genuinely churning source file IS a magnet", async () => {
    // Above the evidence floor: magnets need real history behind them (see the
    // shallow-clone regression below for why).
    const commits = Array.from({ length: 14 }, (_, i) => ({ "src/god.ts": `export const N = ${i};` }));
    const dir = await makeRepo(commits);
    try {
      const r = await buildChurnReport(dir);
      assert.deepEqual(
        r.refactorMagnets.map((f) => f.normalizedFilePath),
        ["src/god.ts"],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("buildChurnReport — scanning a subdirectory of the repo", () => {
  // `git log --name-only` always prints paths from the repository ROOT, while
  // findings carry paths relative to the SCAN root. Point the scan at a
  // subdirectory and the two key spaces stop overlapping: every lookup misses,
  // every churn weight silently becomes 0, and the whole feature turns into a
  // no-op that still reports itself as available.
  test("paths are rebased onto the scan root, not left repo-relative", async () => {
    const dir = await makeRepo([
      { "packages/api/src/hot.ts": "1", "docs/readme.md": "a" },
      { "packages/api/src/hot.ts": "2" },
      { "packages/api/src/cold.ts": "1" },
    ]);
    try {
      const r = await buildChurnReport(join(dir, "packages/api"));
      assert.equal(r.available, true);
      assert.deepEqual(
        r.files.map((f) => f.normalizedFilePath).sort(),
        ["src/cold.ts", "src/hot.ts"],
        "keys are relative to the scanned directory",
      );

      // The property that actually matters: weighting now finds the file.
      const out = weightByChurn([finding("src/cold.ts"), finding("src/hot.ts")], r);
      assert.equal(out[0]!.finding.normalizedFilePath, "src/hot.ts");
      assert.ok(out[0]!.churn > 0, "a file with real history is not weighted as unknown");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("history outside the scanned subdirectory is excluded, not mis-keyed", async () => {
    const dir = await makeRepo([
      { "packages/api/a.ts": "1", "packages/web/b.ts": "1" },
      { "packages/web/b.ts": "2" },
    ]);
    try {
      const r = await buildChurnReport(join(dir, "packages/api"));
      assert.deepEqual(r.files.map((f) => f.normalizedFilePath), ["a.ts"]);
      assert.ok(
        !r.files.some((f) => f.normalizedFilePath.includes("b.ts")),
        "another package's churn is not attributed to this one",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("scanning the repository root still yields root-relative keys", async () => {
    const dir = await makeRepo([{ "src/a.ts": "1" }, { "src/a.ts": "2" }]);
    try {
      const r = await buildChurnReport(dir);
      assert.deepEqual(r.files.map((f) => f.normalizedFilePath), ["src/a.ts"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("buildChurnReport — degrades rather than refusing", () => {
  test("a directory that is not a repository reports unavailable, not an error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-churn-bare-"));
    try {
      const r = await buildChurnReport(dir);
      assert.equal(r.available, false);
      assert.equal(typeof r.unavailableReason, "string");
      assert.deepEqual(r.files, []);
      assert.deepEqual(r.refactorMagnets, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a repository with no commits is unavailable, not a crash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-churn-empty-"));
    try {
      await run("git", ["init", "-q"], { cwd: dir });
      const r = await buildChurnReport(dir);
      assert.equal(r.available, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("weightByChurn — the no-false-positive property", () => {
  test("the output is a PERMUTATION of the input: nothing added, nothing removed", async () => {
    const dir = await makeRepo([{ "src/a.ts": "1" }, { "src/a.ts": "2" }, { "src/b.ts": "1" }]);
    try {
      const r = await buildChurnReport(dir);
      const input = [finding("src/b.ts"), finding("src/a.ts"), finding("src/unknown.ts")];
      const out = weightByChurn(input, r);
      assert.equal(out.length, input.length, "count is preserved");
      assert.deepEqual(
        out.map((x) => x.finding).sort((a, b) => (a.normalizedFilePath < b.normalizedFilePath ? -1 : 1)),
        [...input].sort((a, b) => (a.normalizedFilePath < b.normalizedFilePath ? -1 : 1)),
        "the same findings come back, only reordered",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("higher-churn files rank first; unknown files get 0 and sink", async () => {
    const dir = await makeRepo([{ "src/a.ts": "1" }, { "src/a.ts": "2" }, { "src/a.ts": "3" }]);
    try {
      const r = await buildChurnReport(dir);
      const out = weightByChurn([finding("src/never-committed.ts"), finding("src/a.ts")], r);
      assert.equal(out[0]!.finding.normalizedFilePath, "src/a.ts");
      assert.ok(out[0]!.churn > 0);
      assert.equal(out[1]!.churn, 0, "a file with no history is neither promoted nor punished");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("with no history at all, the analyzer's own order is preserved exactly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-churn-none-"));
    try {
      const r = await buildChurnReport(dir);
      const input = [finding("z.ts"), finding("a.ts"), finding("m.ts")];
      const out = weightByChurn(input, r);
      assert.deepEqual(
        out.map((x) => x.finding.normalizedFilePath),
        ["z.ts", "a.ts", "m.ts"],
        "every churn is 0, so the stable sort is a no-op",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ties keep the analyzer's ordering (stable within a churn score)", async () => {
    const dir = await makeRepo([{ "src/a.ts": "1", "src/b.ts": "1" }]);
    try {
      const r = await buildChurnReport(dir);
      const out = weightByChurn([finding("src/b.ts", 9), finding("src/b.ts", 1)], r);
      assert.deepEqual(out.map((x) => x.finding.line), [9, 1], "original order survives a tie");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("buildChurnReport — determinism", () => {
  test("the same repository at the same commit yields identical output", async () => {
    const dir = await makeRepo([{ "src/a.ts": "1" }, { "src/a.ts": "2" }, { "src/b.ts": "1" }]);
    try {
      const a = await buildChurnReport(dir);
      const b = await buildChurnReport(dir);
      assert.equal(JSON.stringify(a), JSON.stringify(b), "no clock is read; recency is commits-ago");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("§160 — a thin or shallow history must not fabricate magnets", () => {
  test("a shallow clone (the `actions/checkout` default) reports NO magnets", async () => {
    const origin = await makeRepo(
      Array.from({ length: 20 }, (_, i) => ({
        "src/hot.ts": `export const N = ${i};`,
        [`src/stable${i % 5}.ts`]: `export const S = 1;`,
      })),
    );
    const shallow = await mkdtemp(join(tmpdir(), "nd-churn-shallow-"));
    try {
      await run("git", ["clone", "--depth", "1", "-q", `file://${origin}`, shallow]);
      const r = await buildChurnReport(shallow);
      assert.equal(r.available, true, "the ranking is still usable");
      assert.equal(r.historyTruncated, true, "…but the history is known to be truncated");
      assert.deepEqual(
        r.refactorMagnets,
        [],
        "with one commit every file ties at score 100 — naming them all magnets is fabrication",
      );
      assert.ok(r.unavailableReason?.includes("shallow"), "the reader is told why");
      assert.ok(r.files.length > 0, "scores still exist for ranking");
    } finally {
      await rm(origin, { recursive: true, force: true });
      await rm(shallow, { recursive: true, force: true });
    }
  });

  test("a brand-new repo with one commit reports no magnets", async () => {
    const dir = await makeRepo([{ "src/a.ts": "1", "src/b.ts": "1", "src/c.ts": "1" }]);
    try {
      const r = await buildChurnReport(dir);
      assert.equal(r.historyTruncated, true);
      assert.deepEqual(r.refactorMagnets, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a file with only a couple of commits is never a magnet, however it ranks", async () => {
    // 12 commits of history (over the floor), but the "hot" file has only 2.
    const commits = Array.from({ length: 12 }, (_, i) => ({ [`src/f${i}.ts`]: `export const N = ${i};` }));
    commits.push({ "src/barely.ts": "1" }, { "src/barely.ts": "2" });
    const dir = await makeRepo(commits);
    try {
      const r = await buildChurnReport(dir);
      assert.equal(r.historyTruncated, false, "there is enough history to judge");
      assert.ok(
        !r.refactorMagnets.some((f) => f.normalizedFilePath === "src/barely.ts"),
        "two commits is not design pressure, whatever the relative score says",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("`not a git repository` is not reported as `git is missing`", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-churn-nogit-"));
    try {
      const r = await buildChurnReport(dir);
      assert.equal(r.available, false);
      assert.match(
        r.unavailableReason!,
        /not a git repository/,
        "git ran and said no — sending the reader to install git is the wrong fix",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
