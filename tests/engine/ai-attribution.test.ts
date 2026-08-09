/**
 * §110 — AI-authored-code trust boundary.
 *
 * The catalog filed this as Vision, blocked on "git-metadata attribution". That
 * blocker came off when §159/§160/§163 brought `git-history.ts`, and this is the
 * whole dependency: no model, no network, byte-identical across runs.
 *
 * What it measures is commits that DECLARE AI assistance. A trailer is a claim,
 * not proof — the tests below pin that distinction rather than papering over it.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { parseArgs } from "../../src/cli/args.ts";
import { buildAiAttributionReport, aiSignalOf } from "../../src/core/ai-attribution.ts";

const run = promisify(execFile);
const git = (cwd: string, args: string[]) =>
  run("git", ["-c", "user.name=T", "-c", "user.email=t@e.com", "-c", "commit.gpgsign=false", ...args], { cwd });

/** A repository with one human commit and one that declares AI assistance. */
const makeRepo = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "nd-attr-"));
  await git(dir, ["init", "-q", "-b", "main"]);
  await writeFile(join(dir, "a.js"), "const human = 1;\nconst alsoHuman = 2;\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-q", "-m", "human work"]);
  await appendFile(join(dir, "a.js"), "const fromAgent = 3;\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-q", "-m", "agent work\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>"]);
  return dir;
};

describe("ai-attribution — the signal", () => {
  test("a trailer naming a known agent", () => {
    assert.match(aiSignalOf("x\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>")!, /Claude/);
    assert.match(aiSignalOf("x\n\nCo-authored-by: Copilot <copilot@github.com>")!, /Copilot/);
    assert.match(aiSignalOf("x\n\nCo-Authored-By: Cursor Agent <agent@cursor.sh>")!, /Cursor/);
  });

  test("a generated-with marker some tools write instead", () => {
    assert.match(aiSignalOf("x\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)")!, /Claude Code/);
  });

  test("a HUMAN co-author is not a signal", () => {
    assert.equal(aiSignalOf("x\n\nCo-Authored-By: Jane Dev <jane@example.com>"), null);
    assert.equal(aiSignalOf("x\n\nSigned-off-by: Jane <j@e.com>"), null);
  });

  test("prose mentioning an agent is not a trailer", () => {
    // The signal has to be written as a trailer, not appear in the sentence.
    assert.equal(aiSignalOf("fix the claude integration path"), null);
    assert.equal(aiSignalOf("refactor copilot-suggested naming"), null);
  });
});

describe("ai-attribution — against a real repository", () => {
  test("it separates the AI commit from the human one, and attributes lines", async () => {
    const dir = await makeRepo();
    try {
      const report = await buildAiAttributionReport(dir, {
        findings: [{ diagnostic: "d", normalizedFilePath: "a.js", line: 3, severity: "warn" }],
      });
      assert.equal(report.available, true);
      assert.equal(report.summary.commitsScanned, 2);
      assert.equal(report.summary.aiCommits, 1);
      assert.match(report.aiCommits[0]!.signal, /Claude/);

      // Line 3 is the agent's; lines 1-2 are the human's.
      assert.equal(report.summary.blamedLines, 3);
      assert.equal(report.summary.aiLines, 1);
      assert.equal(report.summary.findingsOnAiLines, 1);
      assert.equal(report.findingsOnAiLines[0]!.line, 3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a finding on a HUMAN line is not attributed to the agent", async () => {
    const dir = await makeRepo();
    try {
      const report = await buildAiAttributionReport(dir, {
        findings: [{ diagnostic: "d", normalizedFilePath: "a.js", line: 1, severity: "warn" }],
      });
      assert.equal(report.summary.findingsChecked, 1);
      assert.equal(report.summary.findingsOnAiLines, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("blame counts exactly one sha per line", async () => {
    // Porcelain's group header carries a `<count>` field that must be IGNORED;
    // honouring it double-counts every group, which is how the first version
    // reported 50,195 lines for a 330-line file.
    const dir = await makeRepo();
    try {
      await appendFile(join(dir, "a.js"), "const x = 4;\nconst y = 5;\nconst z = 6;\n");
      await git(dir, ["add", "."]);
      await git(dir, ["commit", "-q", "-m", "more agent work\n\nCo-Authored-By: Claude <noreply@anthropic.com>"]);
      const report = await buildAiAttributionReport(dir, {
        findings: [{ diagnostic: "d", normalizedFilePath: "a.js", line: 1, severity: "warn" }],
      });
      assert.equal(report.summary.blamedLines, 6, "one sha per line, not per blame group");
      assert.equal(report.summary.aiLines, 4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a history with no AI commit reports so, and blames nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-attr-"));
    try {
      await git(dir, ["init", "-q", "-b", "main"]);
      await writeFile(join(dir, "a.js"), "const x = 1;\n");
      await git(dir, ["add", "."]);
      await git(dir, ["commit", "-q", "-m", "ordinary work"]);
      const report = await buildAiAttributionReport(dir, {
        findings: [{ diagnostic: "d", normalizedFilePath: "a.js", line: 1, severity: "warn" }],
      });
      assert.equal(report.available, true);
      assert.equal(report.summary.aiCommits, 0);
      assert.equal(report.summary.filesBlamed, 0, "nothing to attribute, so nothing is blamed");
      assert.deepEqual(report.findingsOnAiLines, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("identical input yields byte-identical output", async () => {
    const dir = await makeRepo();
    try {
      const findings = [{ diagnostic: "d", normalizedFilePath: "a.js", line: 3, severity: "warn" }];
      const a = await buildAiAttributionReport(dir, { findings });
      const b = await buildAiAttributionReport(dir, { findings });
      assert.equal(JSON.stringify(a), JSON.stringify(b));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ai-attribution — abstains rather than guesses", () => {
  test("outside a work tree it says so", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-attr-plain-"));
    try {
      const report = await buildAiAttributionReport(dir);
      assert.equal(report.available, false);
      assert.equal(report.unavailableReason, "not a git work tree");
      assert.equal(report.summary.aiCommits, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ai-attribution — CLI wiring", () => {
  test("the command and its aliases parse", () => {
    assert.equal(parseArgs(["ai-attribution"]).command, "ai-attribution");
    assert.equal(parseArgs(["ai-trust"]).command, "ai-attribution");
    assert.equal(parseArgs(["authored-by"]).command, "ai-attribution");
  });
});
