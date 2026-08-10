/**
 * §104 — why two reports differ.
 *
 * The provenance record had shipped; nothing read it back, so the question it
 * was recorded to answer still had to be answered by hand. This is that answer,
 * and its whole job is to separate "the code changed" from "the tool changed" —
 * a distinction a finding diff cannot make.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { explainDrift } from "../../src/core/drift.ts";
import type { ScanReport } from "../../src/core/scan.ts";
import { parseArgs } from "../../src/cli/args.ts";

const report = (over: Partial<{
  toolVersion: string;
  rulesetHash: string;
  ruleset: string[];
  configHash: string;
  capabilities: string[];
  files: number;
  complete: boolean;
  score: number;
  findings: number;
}> = {}): ScanReport =>
  ({
    schemaVersion: 3,
    provenance: {
      toolVersion: over.toolVersion ?? "1.0.0",
      rulesetHash: over.rulesetHash ?? "hash-a",
      ruleset: over.ruleset ?? ["a:error", "b:warn"],
      configHash: over.configHash ?? "config-a",
      capabilities: over.capabilities ?? ["node", "esm"],
    },
    project: {
      name: "p",
      rootDirectory: "/p",
      capabilities: over.capabilities ?? ["node", "esm"],
      analyzedFileCount: over.files ?? 10,
      files: [],
      totalLines: 100,
      complete: over.complete ?? true,
      suppressedKeys: [],
      parseFailures: [],
    },
    diagnosticsRun: 2,
    diagnosticsAvailable: 2,
    findings: Array.from({ length: over.findings ?? 0 }, () => ({}) as never),
    score: { score: over.score ?? 100 } as never,
  }) as unknown as ScanReport;

const causes = (a: ScanReport, b: ScanReport) => explainDrift(a, b).causes.map((c) => c.cause);

describe("drift — the verdict", () => {
  test("identical provenance means the CODE changed, and says so plainly", () => {
    const d = explainDrift(report({ findings: 1 }), report({ findings: 7 }));
    assert.equal(d.codeOnly, true);
    assert.deepEqual(d.causes.map((c) => c.cause), ["code"]);
    assert.match(d.causes[0]!.message, /means exactly what it appears to mean/);
    assert.equal(d.findings.delta, 6);
  });

  test("a tool version bump is not evidence of a code change", () => {
    const d = explainDrift(report(), report({ toolVersion: "1.1.0" }));
    assert.equal(d.codeOnly, false);
    assert.deepEqual(d.causes.map((c) => c.cause), ["tool-version"]);
    assert.match(d.causes[0]!.message, /1\.0\.0 to 1\.1\.0/);
  });
});

describe("drift — naming what moved", () => {
  test("an added rule is named, not merely counted", () => {
    const d = explainDrift(
      report(),
      report({ rulesetHash: "hash-b", ruleset: ["a:error", "b:warn", "no-nan-comparison:error"] }),
    );
    assert.deepEqual(d.ruleset.added, ["no-nan-comparison"]);
    assert.match(d.causes[0]!.message, /`no-nan-comparison`/);
    assert.match(d.causes[0]!.message, /new to the REPORT, not to the code/);
  });

  test("a removed rule and a re-graded one are distinguished", () => {
    const d = explainDrift(report(), report({ rulesetHash: "hash-b", ruleset: ["a:warn"] }));
    assert.deepEqual(d.ruleset.removed, ["b"]);
    assert.deepEqual(d.ruleset.regraded, [{ id: "a", from: "error", to: "warn" }]);
    assert.match(d.causes[0]!.message, /error→warn/);
  });

  test("an id containing a colon still splits at the LAST one", () => {
    const d = explainDrift(
      report({ ruleset: ["scope:rule:error"] }),
      report({ rulesetHash: "hash-b", ruleset: ["scope:rule:warn"] }),
    );
    assert.deepEqual(d.ruleset.regraded, [{ id: "scope:rule", from: "error", to: "warn" }]);
  });

  test("a capability change is called out, because it gates whole packs", () => {
    const d = explainDrift(report(), report({ capabilities: ["node", "esm", "prisma"] }));
    assert.deepEqual(d.capabilities.added, ["prisma"]);
    assert.match(d.causes[0]!.message, /gained `prisma`/);
    assert.match(d.causes[0]!.message, /switches on every rule that requires it/);
  });

  test("a config change, and a coverage change", () => {
    assert.deepEqual(causes(report(), report({ configHash: "config-b" })), ["config"]);
    assert.deepEqual(causes(report(), report({ files: 14 })), ["coverage"]);
  });

  test("several causes at once, each reported", () => {
    const list = causes(
      report(),
      report({ toolVersion: "2.0.0", rulesetHash: "hash-b", ruleset: ["a:error"], configHash: "c", files: 3 }),
    );
    assert.deepEqual(list, ["tool-version", "ruleset", "config", "coverage"]);
  });
});

describe("drift — honesty about what it cannot compare", () => {
  test("an INCOMPLETE scan makes the comparison unsound, not merely different", () => {
    const d = explainDrift(report({ complete: false }), report());
    assert.ok(d.causes.some((c) => c.cause === "incomplete-scan"));
    assert.match(d.causes.find((c) => c.cause === "incomplete-scan")!.message, /baseline scan/i);
    assert.match(d.causes.find((c) => c.cause === "incomplete-scan")!.message, /not necessarily fixed/);
  });

  test("an artifact predating the ruleset list says so rather than assuming equality", () => {
    // Treating a missing list as "unchanged" would be exactly the wrong answer.
    const old = report({ ruleset: [] });
    const d = explainDrift(old, report({ rulesetHash: "hash-b" }));
    assert.equal(d.ruleset.comparable, false);
    assert.match(d.causes[0]!.message, /predates the recorded rule list/);
  });

  test("an unchanged hash is not re-examined even if the list differs", () => {
    // The hash is computed from the list, so they cannot honestly disagree; the
    // hash is the authority.
    assert.deepEqual(causes(report(), report({ ruleset: ["a:error", "b:warn", "c:error"] })), ["code"]);
  });
});

describe("drift — determinism and wiring", () => {
  test("identical input yields identical output", () => {
    const a = report();
    const b = report({ toolVersion: "1.1.0", capabilities: ["node"] });
    assert.equal(JSON.stringify(explainDrift(a, b)), JSON.stringify(explainDrift(a, b)));
  });

  test("the command and its aliases parse", () => {
    assert.equal(parseArgs(["drift"]).command, "drift");
    assert.equal(parseArgs(["why-changed"]).command, "drift");
    assert.equal(parseArgs(["explain-drift"]).command, "drift");
  });
});
