/**
 * §42 — finding blame, filed as Vision and unblocked the same way §110 was: the
 * infrastructure arrived later for other reasons.
 *
 * The precision story is one distinction. `git blame` reports the commit that
 * LAST TOUCHED a line, which is not the commit that introduced the finding — a
 * reformat or a refactor re-attributes it. So an age is a lower bound, every
 * surface says "last touched", and a shallow checkout suppresses the report
 * rather than dating every finding to the graft commit.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { parseArgs } from "../../src/cli/args.ts";
import { buildFindingBlameReport } from "../../src/core/finding-blame.ts";

const run = promisify(execFile);
const git = (cwd: string, args: string[], when?: string) =>
  run("git", ["-c", "user.name=T", "-c", "user.email=t@e.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: when ? { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } : process.env,
  });

const OLD = "2026-06-01T00:00:00Z";
const NEW = "2026-08-01T00:00:00Z";
const NOW = Date.parse("2026-08-09T00:00:00Z");

/** Line 1 is two months old; line 2 landed eight days ago. */
const makeRepo = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "nd-blame-"));
  await git(dir, ["init", "-q", "-b", "main"]);
  await writeFile(join(dir, "a.js"), "const old = 1;\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-q", "-m", "the old line"], OLD);
  await appendFile(join(dir, "a.js"), "const fresh = 2;\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-q", "-m", "the fresh line"], NEW);
  return dir;
};

const finding = (line: number) => ({ diagnostic: `d${line}`, normalizedFilePath: "a.js", line, severity: "warn" });

describe("finding-blame — age", () => {
  test("each finding gets the age of the line's last touch", async () => {
    const dir = await makeRepo();
    try {
      const r = await buildFindingBlameReport(dir, { now: NOW, findings: [finding(1), finding(2)] });
      assert.equal(r.available, true);
      assert.equal(r.summary.attributed, 2);
      // Oldest first, so the tail of the list is what changed recently.
      assert.equal(r.findings[0]!.line, 1);
      assert.equal(r.findings[0]!.ageDays, 69);
      assert.equal(r.findings[1]!.line, 2);
      assert.equal(r.findings[1]!.ageDays, 8);
      assert.equal(r.summary.oldestAgeDays, 69);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("`recent` is the window that matters for triage", async () => {
    const dir = await makeRepo();
    try {
      const r = await buildFindingBlameReport(dir, { now: NOW, recentDays: 30, findings: [finding(1), finding(2)] });
      assert.equal(r.summary.recent, 1);
      assert.equal(r.recent[0]!.line, 2);

      const wide = await buildFindingBlameReport(dir, { now: NOW, recentDays: 90, findings: [finding(1), finding(2)] });
      assert.equal(wide.summary.recent, 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the author and subject come from the same blame pass, with no follow-up log", async () => {
    const dir = await makeRepo();
    try {
      const r = await buildFindingBlameReport(dir, { now: NOW, findings: [finding(2)] });
      assert.equal(r.findings[0]!.commit!.author, "T");
      assert.equal(r.findings[0]!.commit!.subject, "the fresh line");
      assert.equal(r.findings[0]!.commit!.sha.length, 7);
      assert.deepEqual(r.authors, [{ author: "T", findings: 1 }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("finding-blame — abstains rather than guessing", () => {
  test("an uncommitted line is reported as such, not dated", async () => {
    const dir = await makeRepo();
    try {
      await appendFile(join(dir, "a.js"), "const local = 3;\n");
      const r = await buildFindingBlameReport(dir, { now: NOW, findings: [finding(3)] });
      assert.equal(r.findings[0]!.uncommitted, true);
      assert.equal(r.findings[0]!.ageDays, null);
      assert.equal(r.findings[0]!.commit, null);
      assert.equal(r.summary.uncommitted, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a file git cannot blame yields an unattributed finding, not a wrong one", async () => {
    const dir = await makeRepo();
    try {
      const r = await buildFindingBlameReport(dir, {
        now: NOW,
        findings: [{ diagnostic: "x", normalizedFilePath: "nope.js", line: 1, severity: "warn" }],
      });
      assert.equal(r.summary.attributed, 0);
      assert.equal(r.findings[0]!.ageDays, null);
      assert.equal(r.findings[0]!.uncommitted, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a SHALLOW checkout suppresses the report rather than dating everything to the graft", async () => {
    // `actions/checkout` clones with `--depth 1` by default, so this is the
    // common case in CI, not an exotic one.
    const source = await makeRepo();
    const shallow = await mkdtemp(join(tmpdir(), "nd-blame-shallow-"));
    try {
      await run("git", ["clone", "-q", "--depth", "1", `file://${source}`, shallow]);
      const r = await buildFindingBlameReport(shallow, { now: NOW, findings: [finding(1)] });
      assert.equal(r.available, false);
      assert.equal(r.historyTruncated, true);
      assert.match(r.unavailableReason!, /shallow/);
      assert.deepEqual(r.findings, []);
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(shallow, { recursive: true, force: true });
    }
  });

  test("outside a work tree it says so", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-blame-plain-"));
    try {
      const r = await buildFindingBlameReport(dir, { now: NOW, findings: [finding(1)] });
      assert.equal(r.available, false);
      assert.equal(r.unavailableReason, "not a git work tree");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("finding-blame — determinism and wiring", () => {
  test("identical input yields byte-identical output", async () => {
    const dir = await makeRepo();
    try {
      const args = { now: NOW, findings: [finding(1), finding(2)] };
      assert.equal(
        JSON.stringify(await buildFindingBlameReport(dir, args)),
        JSON.stringify(await buildFindingBlameReport(dir, args)),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the command and its aliases parse", () => {
    assert.equal(parseArgs(["blame"]).command, "blame");
    assert.equal(parseArgs(["finding-age"]).command, "blame");
    assert.equal(parseArgs(["age"]).command, "blame");
  });
});
