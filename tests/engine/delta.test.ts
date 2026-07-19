import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { computeDelta, deltaHasBlocking } from "../../src/core/delta.ts";
import { lintSource } from "../../src/core/scan.ts";
import { DIAGNOSTICS } from "../../src/core/registry.ts";

const scan = (source: string) =>
  lintSource({ filePath: "routes.js", sourceText: source, diagnostics: DIAGNOSTICS, capabilities: new Set(["node", "esm", "express"]) }).findings;

const BASE = `app.get("/a", async (req, res) => {
  const u = await db.user.findUnique({ where: { id: req.params.id } });
  res.json(u);
});
`;

// A PR that appends one new bad handler at the end (existing lines unchanged).
const HEAD = `${BASE}app.get("/b", async (req, res) => {
  const t = require("fs").readFileSync("x", "utf8");
  res.send(t);
});
`;

describe("computeDelta", () => {
  test("reports only findings the PR introduced; pre-existing are ignored", () => {
    const baseline = { findings: scan(BASE) };
    const current = { findings: scan(HEAD) };

    assert.ok(baseline.findings.length > 0, "baseline should have pre-existing findings");

    const { introduced, resolved } = computeDelta(baseline, current);

    // The new handler introduces at least the sync-IO finding; nothing resolved.
    assert.ok(introduced.length >= 1);
    assert.equal(resolved.length, 0);
    // Every introduced finding lives in the appended region (line > BASE lines).
    const baseLineCount = BASE.split("\n").length;
    for (const d of introduced) assert.ok(d.line >= baseLineCount);
    // No pre-existing finding is reported as introduced.
    const baselineIds = new Set(baseline.findings.map((d) => d.id));
    for (const d of introduced) assert.ok(!baselineIds.has(d.id));
  });

  test("resolved findings surface when a bug is removed", () => {
    const baseline = { findings: scan(HEAD) };
    const current = { findings: scan(BASE) };
    const { introduced, resolved } = computeDelta(baseline, current);
    assert.equal(introduced.length, 0);
    assert.ok(resolved.length >= 1);
  });

  test("identical reports produce an empty delta", () => {
    const a = { findings: scan(HEAD) };
    const b = { findings: scan(HEAD) };
    const { introduced, resolved } = computeDelta(a, b);
    assert.equal(introduced.length, 0);
    assert.equal(resolved.length, 0);
  });

  test("deltaHasBlocking respects the blocking level", () => {
    const errors = [{ severity: "error" }] as never;
    const warns = [{ severity: "warn" }] as never;
    assert.equal(deltaHasBlocking(errors, "error"), true);
    assert.equal(deltaHasBlocking(warns, "error"), false);
    assert.equal(deltaHasBlocking(warns, "warning"), true);
    assert.equal(deltaHasBlocking(errors, "none"), false);
  });
});
