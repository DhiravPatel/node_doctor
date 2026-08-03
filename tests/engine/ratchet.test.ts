import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAX_RESOLVED_HISTORY,
  RATCHET_FILENAME,
  RATCHET_SCHEMA_VERSION,
  buildRatchet,
  compareToRatchet,
  readRatchet,
  recordResolutions,
  writeRatchet,
} from "../../src/core/ratchet.ts";
import { scanProject, SCHEMA_VERSION } from "../../src/core/scan.ts";
import type { ScanReport } from "../../src/core/scan.ts";
import type { Finding } from "../../src/core/types.ts";
import { PLUGIN } from "../../src/core/types.ts";

const agentApp = fileURLToPath(new URL("../fixtures/agent-app", import.meta.url));
const goodApp = fileURLToPath(new URL("../fixtures/good-app", import.meta.url));

// --- Hand-built reports: the policy is easier to pin down than to provoke. ----

const finding = (evidenceKey: string, over: Partial<Finding> = {}): Finding => ({
  id: `src/a.js::1:1::${PLUGIN}/demo-rule::${evidenceKey}`,
  filePath: "/repo/src/a.js",
  normalizedFilePath: "src/a.js",
  line: 1,
  column: 1,
  plugin: PLUGIN,
  diagnostic: "demo-rule",
  title: "Demo diagnostic",
  category: "Bugs",
  severity: "error",
  message: "demo",
  recommendation: "fix it",
  tags: [],
  confidence: "high",
  evidenceKey,
  ...over,
});

const report = (findings: Finding[], score: number): ScanReport => ({
  schemaVersion: SCHEMA_VERSION,
  provenance: {
    toolVersion: "0.0.0-test",
    rulesetHash: "ruleset",
    configHash: "config",
    capabilities: ["node"],
  },
  project: {
    name: "demo",
    rootDirectory: "/repo",
    capabilities: ["node"],
    analyzedFileCount: 1,
    totalLines: 100,
    complete: true,
    parseFailures: [],
  },
  diagnosticsRun: 1,
  diagnosticsAvailable: 1,
  findings,
  score: {
    score,
    label: score >= 75 ? "healthy" : score >= 50 ? "needs work" : "critical",
    weighted: 0,
    perThousandLines: 0,
    byCategory: { Security: 0, Reliability: 0, Bugs: 0, Performance: 0, Maintainability: 0 },
  },
});

describe("ratchet — buildRatchet", () => {
  test("freezes today's debt: score, severity counts, sorted accepted keys", () => {
    const r = buildRatchet(
      report([finding("bbb"), finding("aaa", { severity: "warn" }), finding("ccc")], 61),
    );
    assert.equal(r.schemaVersion, RATCHET_SCHEMA_VERSION);
    assert.equal(typeof r.toolVersion, "string");
    assert.equal(r.score, 61);
    assert.deepEqual(r.counts, { error: 2, warn: 1 });
    assert.deepEqual(r.accepted, ["aaa", "bbb", "ccc"]);
  });

  test("is deterministic across two scans of the same project", async () => {
    const a = buildRatchet(await scanProject({ rootDirectory: agentApp }));
    const b = buildRatchet(await scanProject({ rootDirectory: agentApp }));
    assert.deepEqual(a, b);
  });

  test("a clean project yields an empty accepted set", async () => {
    const r = buildRatchet(await scanProject({ rootDirectory: goodApp }));
    assert.deepEqual(r.accepted, []);
    assert.deepEqual(r.counts, { error: 0, warn: 0 });
  });
});

describe("ratchet — compareToRatchet", () => {
  test("an unchanged re-scan passes with zero introduced and nothing to tighten", async () => {
    const first = await scanProject({ rootDirectory: agentApp });
    assert.ok(first.findings.length > 0, "fixture should carry pre-existing debt");
    const ratchet = buildRatchet(first);

    const second = await scanProject({ rootDirectory: agentApp });
    const cmp = compareToRatchet(second, ratchet);

    assert.deepEqual(cmp.introduced, []);
    assert.equal(cmp.resolved, 0);
    assert.equal(cmp.scoreDelta, 0);
    assert.equal(cmp.passed, true);
    assert.equal(cmp.tightened, null);
  });

  test("a genuinely new finding fails and is the only one reported", () => {
    const ratchet = buildRatchet(report([finding("old-1"), finding("old-2")], 70));
    const cmp = compareToRatchet(
      report([finding("old-1"), finding("old-2"), finding("brand-new")], 70),
      ratchet,
    );

    assert.equal(cmp.passed, false);
    assert.equal(cmp.introduced.length, 1);
    assert.equal(cmp.introduced[0]!.evidenceKey, "brand-new");
    assert.equal(cmp.resolved, 0);
    assert.equal(cmp.tightened, null, "a failing scan never rewrites the baseline");
  });

  test("a moved finding is not introduced — identity is evidence, not position", () => {
    const ratchet = buildRatchet(report([finding("k1")], 70));
    const moved = finding("k1", {
      normalizedFilePath: "src/moved.js",
      filePath: "/repo/src/moved.js",
      line: 412,
      column: 9,
      id: "src/moved.js::412:9::node-doctor/demo-rule::k1",
    });
    const cmp = compareToRatchet(report([moved], 70), ratchet);
    assert.deepEqual(cmp.introduced, []);
    assert.equal(cmp.passed, true);
  });

  test("multiset: 2 accepted, 3 present → exactly 1 introduced", () => {
    const ratchet = buildRatchet(report([finding("dup"), finding("dup")], 70));
    const cmp = compareToRatchet(report([finding("dup"), finding("dup"), finding("dup")], 70), ratchet);

    assert.equal(cmp.introduced.length, 1);
    assert.equal(cmp.introduced[0]!.evidenceKey, "dup");
    assert.equal(cmp.resolved, 0);
    assert.equal(cmp.passed, false);
  });

  test("multiset: 3 accepted, 2 present → 1 resolved, none introduced", () => {
    const ratchet = buildRatchet(report([finding("dup"), finding("dup"), finding("dup")], 70));
    const cmp = compareToRatchet(report([finding("dup"), finding("dup")], 72), ratchet);

    assert.deepEqual(cmp.introduced, []);
    assert.equal(cmp.resolved, 1);
    assert.equal(cmp.passed, true);
  });

  test("a resolved finding tightens the ratchet: smaller accepted set, floor never drops", () => {
    const ratchet = buildRatchet(report([finding("keep"), finding("fixed")], 70));
    const cmp = compareToRatchet(report([finding("keep")], 82), ratchet);

    assert.equal(cmp.passed, true);
    assert.equal(cmp.resolved, 1);
    assert.equal(cmp.scoreDelta, 12);

    const next = cmp.tightened;
    assert.ok(next, "an improving scan must offer a tighter ratchet");
    assert.ok(next.accepted.length < ratchet.accepted.length, "accepted may only shrink");
    assert.deepEqual(next.accepted, ["keep"]);
    assert.ok(next.score >= ratchet.score, "the score floor may only rise");
    assert.equal(next.score, 82);
    assert.deepEqual(next.counts, { error: 1, warn: 0 });

    // The tightened ratchet is a valid baseline: re-comparing the same scan passes.
    const again = compareToRatchet(report([finding("keep")], 82), next);
    assert.equal(again.passed, true);
    assert.equal(again.resolved, 0);
    assert.equal(again.tightened, null);
  });

  test("the tightened floor never falls below the old one even if the score is flat", () => {
    const ratchet = buildRatchet(report([finding("keep"), finding("fixed")], 70));
    const cmp = compareToRatchet(report([finding("keep")], 70), ratchet);
    assert.ok(cmp.tightened);
    assert.equal(cmp.tightened.score, 70);
    assert.deepEqual(cmp.tightened.accepted, ["keep"]);
  });

  test("a score drop with no new findings still fails", () => {
    const ratchet = buildRatchet(report([finding("a"), finding("b")], 80));
    const cmp = compareToRatchet(report([finding("a"), finding("b")], 74), ratchet);

    assert.deepEqual(cmp.introduced, []);
    assert.equal(cmp.resolved, 0);
    assert.equal(cmp.scoreDelta, -6);
    assert.equal(cmp.passed, false);
    assert.equal(cmp.tightened, null);
  });

  test("resolving debt while regressing the score does not tighten", () => {
    const ratchet = buildRatchet(report([finding("a"), finding("b")], 80));
    const cmp = compareToRatchet(report([finding("a")], 55), ratchet);

    assert.equal(cmp.resolved, 1);
    assert.equal(cmp.passed, false);
    assert.equal(cmp.tightened, null);
  });

  test("an empty ratchet accepts nothing — every finding is introduced", () => {
    const ratchet = buildRatchet(report([], 100));
    const cmp = compareToRatchet(report([finding("x")], 100), ratchet);
    assert.equal(cmp.introduced.length, 1);
    assert.equal(cmp.passed, false);
  });

  test("multiset tightening keeps the surviving duplicates, dropping exactly one", () => {
    const ratchet = buildRatchet(report([finding("dup"), finding("dup"), finding("dup")], 70));
    const cmp = compareToRatchet(report([finding("dup"), finding("dup")], 72), ratchet);

    assert.ok(cmp.tightened);
    // Not ["dup"] and not ["dup","dup","dup"] — the multiset must shrink by exactly
    // the number resolved, or the ratchet either loosens or over-tightens.
    assert.deepEqual(cmp.tightened.accepted, ["dup", "dup"]);
    assert.deepEqual(cmp.tightened.counts, { error: 2, warn: 0 });
    assert.equal(cmp.tightened.score, 72);
  });

  test("introduced + (accepted − resolved) accounts for every current finding", () => {
    const ratchet = buildRatchet(
      report([finding("a"), finding("a"), finding("b"), finding("gone")], 70),
    );
    const current = report([finding("a"), finding("a"), finding("a"), finding("b"), finding("new")], 70);
    const cmp = compareToRatchet(current, ratchet);

    assert.equal(cmp.resolved, 1, "only `gone` disappeared");
    assert.deepEqual(
      cmp.introduced.map((f) => f.evidenceKey),
      ["a", "new"],
      "the 3rd `a` exceeds the 2 accepted copies, and `new` was never accepted",
    );
    assert.equal(
      cmp.introduced.length + (ratchet.accepted.length - cmp.resolved),
      current.findings.length,
      "every current finding is either introduced or consumed an accepted entry",
    );
    assert.equal(cmp.passed, false);
  });

  test("an introduced warn fails too — the gate is severity-blind", () => {
    const ratchet = buildRatchet(report([finding("old")], 70));
    const cmp = compareToRatchet(
      report([finding("old"), finding("nag", { severity: "warn" })], 70),
      ratchet,
    );
    assert.equal(cmp.introduced.length, 1);
    assert.equal(cmp.introduced[0]!.severity, "warn");
    assert.equal(cmp.passed, false);
  });

  test("comparing does not mutate the ratchet it was given", () => {
    const ratchet = buildRatchet(report([finding("a"), finding("a"), finding("b")], 70));
    const snapshot = JSON.stringify(ratchet);
    compareToRatchet(report([finding("a")], 95), ratchet);
    compareToRatchet(report([finding("z")], 20), ratchet);
    assert.equal(JSON.stringify(ratchet), snapshot, "a stored baseline is read-only");
  });

  test("an unsorted accepted array still compares correctly", () => {
    const cmp = compareToRatchet(report([finding("m"), finding("z")], 70), {
      schemaVersion: RATCHET_SCHEMA_VERSION,
      toolVersion: "0.0.0",
      score: 70,
      counts: { error: 3, warn: 0 },
      accepted: ["z", "a", "m"],
      resolvedHistory: [],
      rulesetHash: "ruleset",
    });
    assert.deepEqual(cmp.introduced, []);
    assert.equal(cmp.resolved, 1);
    assert.deepEqual(cmp.tightened!.accepted, ["m", "z"]);
  });

  test("findings lacking an evidenceKey fall back to the positional id", () => {
    const legacy = finding("ignored");
    delete legacy.evidenceKey;
    const ratchet = buildRatchet(report([legacy], 70));
    assert.deepEqual(ratchet.accepted, [legacy.id]);
    assert.equal(compareToRatchet(report([legacy], 70), ratchet).passed, true);
  });
});

describe("ratchet — persistence", () => {
  test("readRatchet returns null for a missing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-ratchet-"));
    try {
      assert.equal(await readRatchet(join(dir, RATCHET_FILENAME)), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("readRatchet returns null for malformed or wrong-shaped JSON, never throws", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-ratchet-"));
    try {
      const path = join(dir, RATCHET_FILENAME);

      await writeFile(path, "{ not json at all", "utf8");
      assert.equal(await readRatchet(path), null);

      await writeFile(path, "[]", "utf8");
      assert.equal(await readRatchet(path), null);

      await writeFile(path, JSON.stringify({ schemaVersion: 1, accepted: ["a"] }), "utf8");
      assert.equal(await readRatchet(path), null);

      await writeFile(
        path,
        JSON.stringify({
          schemaVersion: RATCHET_SCHEMA_VERSION + 1,
          toolVersion: "9.9.9",
          score: 50,
          counts: { error: 0, warn: 0 },
          accepted: [],
        }),
        "utf8",
      );
      assert.equal(await readRatchet(path), null, "a newer schema is not half-trusted");

      await writeFile(
        path,
        JSON.stringify({
          schemaVersion: 1,
          toolVersion: "0.1.0",
          score: 50,
          counts: { error: 0, warn: 0 },
          accepted: ["ok", 7],
        }),
        "utf8",
      );
      assert.equal(await readRatchet(path), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("readRatchet rejects impossible numbers rather than half-trusting them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-ratchet-"));
    try {
      const path = join(dir, RATCHET_FILENAME);
      const base = {
        schemaVersion: RATCHET_SCHEMA_VERSION,
        toolVersion: "0.1.0",
        score: 50,
        counts: { error: 1, warn: 2 },
        accepted: ["a"],
      };
      const rejects = async (over: Record<string, unknown>, why: string) => {
        await writeFile(path, JSON.stringify({ ...base, ...over }), "utf8");
        assert.equal(await readRatchet(path), null, why);
      };

      await rejects({ schemaVersion: 0 }, "schema 0 predates the format");
      await rejects({ schemaVersion: 1.5 }, "a fractional schema version is nonsense");
      await rejects({ score: null }, "a null score is not a floor");
      await rejects({ score: "50" }, "a stringified score is not a floor");
      await rejects({ counts: { error: 1.5, warn: 0 } }, "counts are populations, not fractions");
      await rejects({ counts: { error: -1, warn: 0 } }, "a negative population is impossible");
      await rejects({ counts: [0, 0] }, "an array is not a counts record");
      await rejects({ accepted: "a" }, "accepted must be an array");

      // ...and the untouched baseline still loads, so the guard is not just refusing everything.
      await writeFile(path, JSON.stringify(base), "utf8");
      assert.deepEqual(await readRatchet(path), { ...base, resolvedHistory: [], rulesetHash: "" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("readRatchet returns null (never throws) when the path is a directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-ratchet-"));
    try {
      assert.equal(await readRatchet(dir), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("readRatchet normalizes an unsorted accepted array on load", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-ratchet-"));
    try {
      const path = join(dir, RATCHET_FILENAME);
      await writeFile(
        path,
        JSON.stringify({
          schemaVersion: RATCHET_SCHEMA_VERSION,
          toolVersion: "0.1.0",
          score: 50,
          counts: { error: 0, warn: 3 },
          accepted: ["zz", "aa", "mm"],
        }),
        "utf8",
      );
      assert.deepEqual((await readRatchet(path))!.accepted, ["aa", "mm", "zz"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("writeRatchet creates missing parent directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-ratchet-"));
    try {
      const path = join(dir, "nested", "deeper", RATCHET_FILENAME);
      const r = buildRatchet(report([finding("q")], 88));
      await writeRatchet(path, r);
      assert.deepEqual(await readRatchet(path), r);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the written file is 2-space JSON with a trailing newline and fixed key order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-ratchet-"));
    try {
      const path = join(dir, RATCHET_FILENAME);
      await writeRatchet(path, { ...buildRatchet(report([finding("k")], 40)), toolVersion: "1.2.3" });
      const text = await readFile(path, "utf8");
      assert.equal(
        text,
        [
          "{",
          `  "schemaVersion": ${RATCHET_SCHEMA_VERSION},`,
          '  "toolVersion": "1.2.3",',
          '  "rulesetHash": "ruleset",',
          '  "score": 40,',
          '  "counts": {',
          '    "error": 1,',
          '    "warn": 0',
          "  },",
          '  "accepted": [',
          '    "k"',
          "  ],",
          '  "resolvedHistory": []',
          "}",
          "",
        ].join("\n"),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("write → read round-trips, and the file is deterministic bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-ratchet-"));
    try {
      const path = join(dir, RATCHET_FILENAME);
      const original = buildRatchet(report([finding("zz"), finding("aa", { severity: "warn" })], 64));

      await writeRatchet(path, original);
      const loaded = await readRatchet(path);
      assert.deepEqual(loaded, original);

      // Re-writing the loaded copy produces byte-identical content.
      const other = join(dir, "second.json");
      await writeRatchet(other, loaded!);
      assert.equal(await readFile(path, "utf8"), await readFile(other, "utf8"));

      // Unsorted input is normalized on write.
      const unsorted = join(dir, "unsorted.json");
      await writeRatchet(unsorted, { ...original, accepted: ["zz", "aa"] });
      assert.deepEqual((await readRatchet(unsorted))!.accepted, ["aa", "zz"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a real project round-trips through disk and still passes its own ratchet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-ratchet-"));
    try {
      const path = join(dir, RATCHET_FILENAME);
      const scan = await scanProject({ rootDirectory: agentApp });
      await writeRatchet(path, buildRatchet(scan));

      const loaded = await readRatchet(path);
      assert.ok(loaded);
      const cmp = compareToRatchet(await scanProject({ rootDirectory: agentApp }), loaded);
      assert.equal(cmp.passed, true);
      assert.deepEqual(cmp.introduced, []);
      assert.equal(cmp.resolved, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("RATCHET_FILENAME is the committed sidecar name", () => {
    assert.equal(RATCHET_FILENAME, ".node-doctor-ratchet.json");
  });
});

// ---------------------------------------------------------------------------
// §161 — Fix-Regression Detection (boomerang bugs)
// ---------------------------------------------------------------------------

describe("§161 fix-regression — the fix → return lifecycle", () => {
  test("a finding fixed and then reintroduced is reported as REGRESSED", () => {
    // 1. Baseline accepts two findings.
    const base = buildRatchet(report([finding("a"), finding("b")], 80));

    // 2. `b` gets fixed — the ratchet tightens and records the resolution.
    const fixed = compareToRatchet(report([finding("a")], 90), base, { now: "2026-03-11" });
    assert.equal(fixed.passed, true);
    assert.deepEqual(fixed.resolvedKeys, ["b"]);
    const tightened = fixed.tightened!;
    assert.deepEqual(
      tightened.resolvedHistory.map((e) => [e.key, e.resolvedAt]),
      [["b", "2026-03-11"]],
    );
    assert.deepEqual(tightened.accepted, ["a"], "b is no longer accepted debt");

    // 3. `b` comes back. It is introduced debt AND a regression.
    const back = compareToRatchet(report([finding("a"), finding("b")], 80), tightened);
    assert.equal(back.passed, false);
    assert.equal(back.introduced.length, 1);
    assert.equal(back.regressed.length, 1);
    assert.equal(back.regressed[0]!.finding.evidenceKey, "b");
    assert.equal(back.regressed[0]!.previouslyResolvedAt, "2026-03-11");
  });

  test("a NEW finding never seen before is introduced but NOT a regression", () => {
    const base: Parameters<typeof compareToRatchet>[1] = {
      ...buildRatchet(report([finding("a")], 90)),
      resolvedHistory: [{ key: "b", resolvedAt: "2026-03-11", toolVersion: "1.0.0" }],
    };
    const cmp = compareToRatchet(report([finding("a"), finding("zzz")], 70), base);
    assert.equal(cmp.introduced.length, 1);
    assert.deepEqual(cmp.regressed, [], "zzz was never fixed, so it cannot have regressed");
  });

  test("still-accepted debt is not a regression even if its key is in history", () => {
    // Defensive: a key both accepted and in history must be absolved by the
    // accepted pool first — never reported as a boomerang.
    const base: Parameters<typeof compareToRatchet>[1] = {
      ...buildRatchet(report([finding("a")], 90)),
      resolvedHistory: [{ key: "a", resolvedAt: "2026-01-01", toolVersion: "1.0.0" }],
    };
    const cmp = compareToRatchet(report([finding("a")], 90), base);
    assert.deepEqual(cmp.introduced, []);
    assert.deepEqual(cmp.regressed, []);
    assert.equal(cmp.passed, true);
  });

  test("history survives repeated tightening and accumulates", () => {
    let r = buildRatchet(report([finding("a"), finding("b"), finding("c")], 60));
    r = compareToRatchet(report([finding("a"), finding("b")], 70), r, { now: "2026-01-01" }).tightened!;
    r = compareToRatchet(report([finding("a")], 80), r, { now: "2026-02-02" }).tightened!;
    assert.deepEqual(
      r.resolvedHistory.map((e) => e.key),
      ["b", "c"],
      "both resolutions are remembered, sorted by key",
    );
  });

  test("a regression is reported per distinct finding, deterministically", () => {
    const base: Parameters<typeof compareToRatchet>[1] = {
      ...buildRatchet(report([], 100)),
      resolvedHistory: [
        { key: "x", resolvedAt: "2026-01-01", toolVersion: "1.0.0" },
        { key: "y", resolvedAt: "2026-02-02", toolVersion: "1.0.0" },
      ],
    };
    const cmp = compareToRatchet(report([finding("x"), finding("y")], 50), base);
    assert.deepEqual(cmp.regressed.map((r) => r.finding.evidenceKey), ["x", "y"]);
    const again = compareToRatchet(report([finding("x"), finding("y")], 50), base);
    assert.equal(JSON.stringify(cmp.regressed), JSON.stringify(again.regressed));
  });
});

describe("§161 fix-regression — purity, schema and bounds", () => {
  test("compareToRatchet stays pure: no clock, no mutation, repeatable", () => {
    const base = buildRatchet(report([finding("a"), finding("b")], 80));
    const snapshot = JSON.stringify(base);
    const one = compareToRatchet(report([finding("a")], 90), base);
    const two = compareToRatchet(report([finding("a")], 90), base);
    assert.equal(JSON.stringify(one), JSON.stringify(two), "same inputs, same output");
    assert.equal(JSON.stringify(base), snapshot, "the stored ratchet is untouched");
    // With no clock supplied the resolution is undated, never lost.
    assert.deepEqual(one.tightened!.resolvedHistory.map((e) => e.resolvedAt), [""]);
  });

  test("a v1 ratchet file (no resolvedHistory) still loads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-ratchet-v1-"));
    try {
      const path = join(dir, RATCHET_FILENAME);
      await writeFile(
        path,
        JSON.stringify({
          schemaVersion: 1,
          toolVersion: "0.9.0",
          score: 70,
          counts: { error: 1, warn: 0 },
          accepted: ["a"],
        }),
      );
      const loaded = await readRatchet(path);
      assert.ok(loaded, "a v1 file is valid, not corrupt");
      assert.deepEqual(loaded!.resolvedHistory, [], "upgraded in memory with an empty history");
      assert.equal(loaded!.schemaVersion, RATCHET_SCHEMA_VERSION);
      assert.deepEqual(loaded!.accepted, ["a"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a malformed history rejects the file rather than fabricating a regression", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-ratchet-bad-"));
    try {
      const path = join(dir, RATCHET_FILENAME);
      await writeFile(
        path,
        JSON.stringify({
          schemaVersion: 2,
          toolVersion: "1.0.0",
          score: 70,
          counts: { error: 1, warn: 0 },
          accepted: ["a"],
          resolvedHistory: [{ key: 42, resolvedAt: "2026-01-01", toolVersion: "1.0.0" }],
        }),
      );
      assert.equal(await readRatchet(path), null, "a bad entry must not be half-trusted");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a written ratchet round-trips byte-identically with history", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-ratchet-rt-"));
    try {
      const path = join(dir, RATCHET_FILENAME);
      const r = {
        ...buildRatchet(report([finding("a")], 90)),
        resolvedHistory: [
          { key: "z", resolvedAt: "2026-02-02", toolVersion: "1.0.0" },
          { key: "b", resolvedAt: "2026-01-01", toolVersion: "1.0.0" },
        ],
      };
      await writeRatchet(path, r);
      const first = await readFile(path, "utf8");
      await writeRatchet(path, (await readRatchet(path))!);
      assert.equal(await readFile(path, "utf8"), first, "committed file must not churn");
      assert.match(first, /"key": "b"[\s\S]*"key": "z"/, "history sorted by key");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("history is capped, dropping the OLDEST entries first", () => {
    const old = Array.from({ length: MAX_RESOLVED_HISTORY }, (_, i) => ({
      key: `old-${String(i).padStart(4, "0")}`,
      resolvedAt: "2020-01-01",
      toolVersion: "1.0.0",
    }));
    const merged = recordResolutions(old, ["fresh"], "2026-06-01");
    assert.equal(merged.length, MAX_RESOLVED_HISTORY, "capped");
    assert.ok(merged.some((e) => e.key === "fresh"), "the newest entry survives");
  });

  test("re-resolving a key updates its date rather than duplicating it", () => {
    const merged = recordResolutions(
      [{ key: "a", resolvedAt: "2026-01-01", toolVersion: "1.0.0" }],
      ["a"],
      "2026-05-05",
    );
    assert.equal(merged.length, 1);
    assert.equal(merged[0]!.resolvedAt, "2026-05-05");
  });
});

// ---------------------------------------------------------------------------
// §161 — hunt regressions: "absent" only counts as "fixed" when PROVEN.
//
// Every case below previously wrote a permanent false "previously fixed, and
// back" claim into the committed ratchet. A finding disappears for reasons
// other than a fix, and each of those reasons has to be excluded explicitly.
// ---------------------------------------------------------------------------

/** A report whose provenance/completeness can be varied. */
const reportWith = (
  findings: Finding[],
  score: number,
  over: { rulesetHash?: string; complete?: boolean } = {},
): ScanReport => {
  const base = report(findings, score);
  return {
    ...base,
    provenance: { ...base.provenance, rulesetHash: over.rulesetHash ?? base.provenance.rulesetHash },
    project: {
      ...base.project,
      complete: over.complete ?? true,
      parseFailures: over.complete === false
        ? [{ filePath: "/repo/src/a.js", normalizedFilePath: "src/a.js", message: "Expected `}` but found `EOF`" }]
        : [],
    },
  };
};

describe("§161 — a finding must be PROVEN fixed before it enters history", () => {
  test("a narrower ruleset (--ignore-tag / config off) never records a fix", () => {
    const base = buildRatchet(report([finding("a")], 0));
    // The finding is gone only because fewer rules ran.
    const cmp = compareToRatchet(reportWith([], 100, { rulesetHash: "narrower" }), base, {
      now: "2026-03-11",
    });
    assert.equal(cmp.resolved, 1, "it is absent, so the pool still reports it");
    assert.equal(cmp.recordedResolutions, false, "but the scan is not comparable");
    assert.equal(cmp.tightened, null, "so nothing is written to the committed file");
  });

  test("an INCOMPLETE scan (parse failure) never records a fix", () => {
    const base = buildRatchet(report([finding("a")], 0));
    const cmp = compareToRatchet(reportWith([], 100, { complete: false }), base, { now: "2026-03-11" });
    assert.equal(cmp.recordedResolutions, false, "a file we could not read teaches us nothing");
    assert.equal(cmp.tightened, null);
  });

  test("and therefore no false REGRESSED claim on the next full scan", () => {
    const base = buildRatchet(report([finding("a")], 0));
    const narrowed = compareToRatchet(reportWith([], 100, { rulesetHash: "narrower" }), base, {
      now: "2026-03-11",
    });
    // The baseline is untouched, so the finding is still accepted debt.
    const next = compareToRatchet(report([finding("a")], 0), narrowed.tightened ?? base);
    assert.deepEqual(next.regressed, [], "nothing was fixed, so nothing can have regressed");
    assert.deepEqual(next.introduced, [], "it is still accepted debt");
    assert.equal(next.passed, true);
  });

  test("a key with a surviving copy is never recorded as fixed", () => {
    // 3 accepted, 2 present: one pool entry is left over, but the evidence is
    // still in the code — recording it would fabricate a later regression.
    const base = buildRatchet(report([finding("dup"), finding("dup"), finding("dup")], 70));
    const cmp = compareToRatchet(report([finding("dup"), finding("dup")], 72), base, { now: "2026-03-11" });
    assert.equal(cmp.resolved, 1);
    assert.deepEqual(cmp.tightened!.resolvedHistory, [], "the key is still present, so it is not fixed");
  });

  test("a genuine fix under the SAME ruleset on a COMPLETE scan is still recorded", () => {
    const base = buildRatchet(report([finding("a"), finding("b")], 70));
    const cmp = compareToRatchet(report([finding("a")], 85), base, { now: "2026-03-11" });
    assert.equal(cmp.recordedResolutions, true);
    assert.deepEqual(
      cmp.tightened!.resolvedHistory.map((e) => [e.key, e.resolvedAt]),
      [["b", "2026-03-11"]],
      "the guards must not break the real path",
    );
  });

  test("the cap never evicts the resolution it just recorded, even undated", () => {
    const old = Array.from({ length: MAX_RESOLVED_HISTORY }, (_, i) => ({
      key: `old-${String(i).padStart(4, "0")}`,
      resolvedAt: "2020-01-01",
      toolVersion: "1.0.0",
    }));
    // An undated entry sorts oldest — it must still survive the same call that added it.
    const merged = recordResolutions(old, ["fresh"], "");
    assert.equal(merged.length, MAX_RESOLVED_HISTORY);
    assert.ok(merged.some((e) => e.key === "fresh"), "the newly-learned fact must not be dropped");
  });

  test("buildRatchet carries prior history forward, so re-baselining keeps the fix record", () => {
    const prior = [{ key: "fixed-long-ago", resolvedAt: "2026-01-01", toolVersion: "1.0.0" }];
    const r = buildRatchet(report([finding("a")], 70), prior);
    assert.deepEqual(r.resolvedHistory.map((e) => e.key), ["fixed-long-ago"]);
    assert.deepEqual(r.accepted, ["a"], "the accepted set is still re-pinned");
  });

  test("a v1 ratchet has no rulesetHash, and that never blocks recording", () => {
    const v1 = { ...buildRatchet(report([finding("a")], 70)), rulesetHash: "" };
    const cmp = compareToRatchet(report([], 100), v1, { now: "2026-03-11" });
    assert.equal(cmp.recordedResolutions, true, "unknown ruleset must not punish an upgraded file");
  });
});
