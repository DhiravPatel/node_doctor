import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { renderCodeFrame } from "../../src/report/code-frame.ts";
import { buildIssueUrl, normalizeRepoUrl } from "../../src/report/issue-url.ts";
import { renderReport } from "../../src/report/terminal.ts";
import type { Finding } from "../../src/core/types.ts";
import type { ScanReport } from "../../src/core/scan.ts";

const BIN = fileURLToPath(new URL("../../bin/node-doctor.js", import.meta.url));
const runCli = (args: string[]): Promise<{ code: number; stdout: string }> =>
  new Promise((res) => {
    const child = spawn(process.execPath, [BIN, ...args]);
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("close", (code) => res({ code: code ?? 0, stdout }));
  });

const ESC = String.fromCharCode(27);

// ---------------------------------------------------------------------------
// Code frames
// ---------------------------------------------------------------------------

describe("renderCodeFrame", () => {
  test("marks the target line and places a caret under the column", () => {
    const frame = renderCodeFrame({ sourceText: "line one\nconst x = bad;\nline three", line: 2, column: 11 });
    assert.match(frame, /> 2 .*const x = bad;/);
    const caretLine = frame.split("\n").find((l) => l.includes("^"))!;
    // caret sits at column 11 (10 spaces of pad after the gutter)
    assert.equal(caretLine.indexOf("^"), caretLine.lastIndexOf("^"));
    assert.ok(caretLine.includes(" ".repeat(10) + "^"));
  });
  test("returns empty for out-of-range lines and minified lines", () => {
    assert.equal(renderCodeFrame({ sourceText: "a\nb", line: 9, column: 1 }), "");
    const minified = "x".repeat(500);
    assert.equal(renderCodeFrame({ sourceText: minified, line: 1, column: 1 }), "");
  });
});

// ---------------------------------------------------------------------------
// Issue URL
// ---------------------------------------------------------------------------

describe("issue url", () => {
  test("normalizeRepoUrl handles git+https, ssh, and undefined", () => {
    assert.equal(normalizeRepoUrl("git+https://github.com/o/r.git"), "https://github.com/o/r");
    assert.equal(normalizeRepoUrl("git@github.com:o/r.git"), "https://github.com/o/r");
    assert.equal(normalizeRepoUrl("https://github.com/o/r"), "https://github.com/o/r");
    assert.equal(normalizeRepoUrl(undefined), undefined);
    assert.equal(normalizeRepoUrl("not a url"), undefined);
  });
  const finding: Finding = {
    id: "x", filePath: "/x/a.js", normalizedFilePath: "a.js", line: 3, column: 5,
    plugin: "node-doctor", diagnostic: "no-eval-with-input", title: "eval", category: "Security",
    severity: "error", message: "bad", recommendation: "don't", tags: [],
    confidence: "high",
  };
  test("buildIssueUrl encodes the finding; undefined without a repo", () => {
    const url = buildIssueUrl(finding, "git+https://github.com/o/r.git")!;
    assert.match(url, /^https:\/\/github\.com\/o\/r\/issues\/new\?/);
    assert.match(url, /no-eval-with-input/);
    assert.match(url, /labels=false-positive/);
    assert.equal(buildIssueUrl(finding, undefined), undefined);
  });
});

// ---------------------------------------------------------------------------
// Terminal hyperlinks + verbose code frames
// ---------------------------------------------------------------------------

const oneFindingReport = (): ScanReport => ({
  schemaVersion: 2,
  provenance: { toolVersion: "0.0.0", rulesetHash: "t", configHash: "t", capabilities: [] },
  project: { name: "x", rootDirectory: "/x", capabilities: ["node"], analyzedFileCount: 1, totalLines: 10, complete: true, parseFailures: [] },
  diagnosticsRun: 1,
  diagnosticsAvailable: 1,
  findings: [
    { id: "x", filePath: "/x/a.js", normalizedFilePath: "a.js", line: 2, column: 3, plugin: "node-doctor", diagnostic: "no-eval-with-input", title: "eval", category: "Security", severity: "error", message: "m", recommendation: "r", tags: [], confidence: "high" },
  ],
  score: { score: 40, label: "critical", weighted: 2, perThousandLines: 200, byCategory: { Security: 1, Reliability: 0, Bugs: 0, Performance: 0, Maintainability: 0 } },
});

describe("terminal reporter — hyperlinks + frames", () => {
  test("hyperlinks:true wraps the location in an OSC-8 sequence", () => {
    const out = renderReport(oneFindingReport(), { color: false, hyperlinks: true });
    assert.ok(out.includes(`${ESC}]8;;file:///x/a.js`), "expected an OSC-8 hyperlink");
  });
  test("hyperlinks:false leaves a plain location", () => {
    const out = renderReport(oneFindingReport(), { color: false, hyperlinks: false });
    assert.ok(!out.includes(`${ESC}]8;;`));
    assert.match(out, /a\.js:2:3/);
  });
  test("verbose + sourceFor draws a code frame with a caret", () => {
    const out = renderReport(oneFindingReport(), {
      color: false,
      verbose: true,
      sourceFor: () => "first\nconst y = evil;\nthird",
    });
    assert.match(out, /> 2 .*const y = evil;/);
    assert.ok(out.includes("^"));
  });
});

// ---------------------------------------------------------------------------
// diagnostics list --json + filters (end-to-end)
// ---------------------------------------------------------------------------

describe("diagnostics list", () => {
  test("--json emits structured rows with effective severity + source", async () => {
    const { code, stdout } = await runCli(["diagnostics", "--json"]);
    assert.equal(code, 0);
    const rows = JSON.parse(stdout) as Array<{ id: string; severity: string; source: string; category: string }>;
    assert.ok(rows.length > 50);
    for (const r of rows.slice(0, 5)) {
      assert.ok(typeof r.id === "string");
      assert.ok(["off", "warn", "error"].includes(r.severity));
      assert.ok(["default", "config"].includes(r.source));
    }
  });
  test("--category narrows the catalog", async () => {
    const { stdout } = await runCli(["diagnostics", "--category", "Security", "--json"]);
    const rows = JSON.parse(stdout) as Array<{ category: string }>;
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.category === "Security"));
  });
});
