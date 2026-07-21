import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RATCHET_FILENAME,
  RATCHET_SCHEMA_VERSION,
  buildRatchet,
  compareToRatchet,
  readRatchet,
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
      assert.deepEqual(await readRatchet(path), base);
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
          '  "score": 40,',
          '  "counts": {',
          '    "error": 1,',
          '    "warn": 0',
          "  },",
          '  "accepted": [',
          '    "k"',
          "  ]",
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
