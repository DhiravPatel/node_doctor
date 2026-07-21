import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { parseArgs } from "../../src/cli/args.ts";
import { toJson, toJsonError } from "../../src/report/json.ts";
import { scanProject } from "../../src/core/scan.ts";

const goodApp = fileURLToPath(new URL("../fixtures/good-app", import.meta.url));

// ---------------------------------------------------------------------------
// Argument parsing — the Wave 1 flag surface
// ---------------------------------------------------------------------------

describe("parseArgs — display filters", () => {
  test("--category canonicalizes case and dedupes; comma-separated allowed", () => {
    assert.deepEqual(parseArgs(["--category", "security"]).categories, ["Security"]);
    assert.deepEqual(parseArgs(["--category", "Security,bugs"]).categories, ["Security", "Bugs"]);
    const repeated = parseArgs(["--category", "security", "--category", "Security"]);
    assert.deepEqual(repeated.categories, ["Security"]);
  });
  test("unknown --category is a clear error", () => {
    const a = parseArgs(["--category", "Bogus"]);
    assert.equal(a.categories.length, 0);
    assert.match(a.errors[0]!, /not valid.*Security, Reliability, Bugs, Performance, Maintainability/);
  });
  test("--no-warnings toggles warnings off; default on", () => {
    assert.equal(parseArgs([]).warnings, true);
    assert.equal(parseArgs(["--no-warnings"]).warnings, false);
    assert.equal(parseArgs(["--warnings"]).warnings, true);
  });
});

describe("parseArgs — scope + output shaping", () => {
  test("--scope validates; --lines is an alias", () => {
    assert.equal(parseArgs(["--scope", "lines"]).scope, "lines");
    assert.equal(parseArgs(["--scope", "files"]).scope, "files");
    assert.equal(parseArgs(["--lines"]).scope, "lines");
    assert.match(parseArgs(["--scope", "nope"]).errors[0]!, /--scope must be one of/);
  });
  test("--changed-files-from + --include-untracked", () => {
    assert.equal(parseArgs(["--changed-files-from", "list.txt"]).changedFilesFrom, "list.txt");
    assert.equal(parseArgs(["--include-untracked"]).includeUntracked, true);
  });
  test("--score / --json-compact / --color tri-state", () => {
    assert.equal(parseArgs(["--score"]).scoreOnly, true);
    const jc = parseArgs(["--json-compact"]);
    assert.equal(jc.json, true);
    assert.equal(jc.jsonCompact, true);
    assert.equal(parseArgs([]).color, undefined);
    assert.equal(parseArgs(["--color"]).color, true);
    assert.equal(parseArgs(["--no-color"]).color, false);
  });
});

describe("parseArgs — engine controls + guards", () => {
  test("--audit and --no-respect-inline-disables both set audit", () => {
    assert.equal(parseArgs(["--audit"]).audit, true);
    assert.equal(parseArgs(["--no-respect-inline-disables"]).audit, true);
  });
  test("--max-duration must be a positive number", () => {
    assert.equal(parseArgs(["--max-duration", "5"]).maxDuration, 5);
    assert.match(parseArgs(["--max-duration", "x"]).errors[0]!, /positive number/);
    assert.match(parseArgs(["--max-duration", "-1"]).errors[0]!, /positive number/);
  });
  test("--dead-code tri-state", () => {
    assert.equal(parseArgs([]).deadCode, undefined);
    assert.equal(parseArgs(["--dead-code"]).deadCode, true);
    assert.equal(parseArgs(["--no-dead-code"]).deadCode, false);
  });
  test("version subcommand parses", () => {
    assert.equal(parseArgs(["version"]).command, "version");
  });
  test("removed flags fail loudly with guidance", () => {
    assert.match(parseArgs(["--fail-on", "error"]).errors[0]!, /--fail-on was removed.*--blocking/);
    assert.match(parseArgs(["--format", "json"]).errors[0]!, /--format was removed/);
  });
});

// ---------------------------------------------------------------------------
// JSON reporter — compact + structured error
// ---------------------------------------------------------------------------

describe("json reporter", () => {
  const fakeReport = {
    schemaVersion: 2,
    project: { name: "x", rootDirectory: "/x", capabilities: [], analyzedFileCount: 0, totalLines: 0, complete: true, parseFailures: [] },
    diagnosticsRun: 0,
    diagnosticsAvailable: 0,
    findings: [],
    score: { score: 100, label: "healthy" as const, weighted: 0, perThousandLines: 0, byCategory: { Security: 0, Reliability: 0, Bugs: 0, Performance: 0, Maintainability: 0 } },
  };
  test("--json-compact emits a single line; default is indented", () => {
    assert.equal(toJson(fakeReport as never, { compact: true }).includes("\n"), false);
    assert.equal(toJson(fakeReport as never).includes("\n"), true);
  });
  test("toJsonError is a well-formed ok:false report", () => {
    const parsed = JSON.parse(toJsonError(new Error("boom")));
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.message, "boom");
    assert.deepEqual(parsed.findings, []);
    assert.equal(parsed.score, null);
    assert.equal(parsed.schemaVersion, 2);
  });
});

// ---------------------------------------------------------------------------
// Engine — audit mode + time budget (through scanProject)
// ---------------------------------------------------------------------------

describe("scanProject — audit mode neutralizes inline suppressions", () => {
  test("a suppressed finding is hidden by default and surfaced under audit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-audit-"));
    try {
      await writeFile(
        join(dir, "a.js"),
        "// node-doctor-disable-next-line no-eval-with-input -- reviewed, trusted input\nconst x = eval(userInput);\n",
      );
      const respected = await scanProject({ rootDirectory: dir });
      const audited = await scanProject({ rootDirectory: dir, respectInlineDisables: false });

      const evalIn = (r: Awaited<ReturnType<typeof scanProject>>): boolean =>
        r.findings.some((f) => f.diagnostic === "no-eval-with-input");

      assert.equal(evalIn(respected), false, "suppressed by default");
      assert.equal(evalIn(audited), true, "surfaced under audit");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("scanProject — time budget", () => {
  test("a past deadline stops the scan and marks the report incomplete", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-budget-"));
    try {
      await writeFile(join(dir, "a.js"), "const x = eval(userInput);\n");
      await writeFile(join(dir, "b.js"), "const y = eval(other);\n");
      const report = await scanProject({ rootDirectory: dir, deadlineEpochMs: Date.now() - 1000 });
      assert.equal(report.project.complete, false);
      assert.equal(report.project.analyzedFileCount, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// CLI end-to-end — spawn the real binary (robust vs. the test runner's stdout)
// ---------------------------------------------------------------------------

const BIN = fileURLToPath(new URL("../../bin/node-doctor.js", import.meta.url));

const runCli = (cliArgs: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [BIN, ...cliArgs], { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolvePromise({ code: code ?? 0, stdout, stderr }));
  });

describe("CLI end-to-end", () => {
  test("version subcommand prints platform + node runtime", async () => {
    const { code, stdout } = await runCli(["version"]);
    assert.equal(code, 0);
    assert.match(stdout, /^node-doctor\/\d+\.\d+\.\d+ \w+-\w+ node-v\d+/);
  });
  test("--json with a bad flag emits a structured error report and exits 2", async () => {
    const { code, stdout } = await runCli(["--json", "--blocking", "bogus"]);
    assert.equal(code, 2);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error.message, /--blocking/);
  });
  test("--score prints only the numeric health score", async () => {
    const { code, stdout } = await runCli([goodApp, "--score"]);
    assert.equal(code, 0);
    assert.match(stdout.trim(), /^\d+$/);
  });
});
