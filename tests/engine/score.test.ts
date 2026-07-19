import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { calculateScore } from "../../src/core/score.ts";
import type { Category, Finding, Severity } from "../../src/core/types.ts";

const diag = (category: Category, severity: Severity): Finding =>
  ({ category, severity }) as Finding;

describe("calculateScore", () => {
  test("worked example: 2000 lines, 3 Security errors + 4 Performance warnings → 89 healthy", () => {
    const findings = [
      diag("Security", "error"),
      diag("Security", "error"),
      diag("Security", "error"),
      diag("Performance", "warn"),
      diag("Performance", "warn"),
      diag("Performance", "warn"),
      diag("Performance", "warn"),
    ];
    const score = calculateScore(findings, { totalLines: 2000 });
    // weighted = 3*(3*2.0) + 4*(1*1.0) = 18 + 4 = 22
    assert.equal(score.weighted, 22);
    assert.equal(score.perThousandLines, 11);
    assert.equal(score.score, 89);
    assert.equal(score.label, "healthy");
  });

  test("empty findings → perfect score", () => {
    const score = calculateScore([], { totalLines: 500 });
    assert.equal(score.score, 100);
    assert.equal(score.label, "healthy");
  });

  test("dense findings bottom out at 0 / critical", () => {
    const findings = Array.from({ length: 50 }, () => diag("Security", "error"));
    const score = calculateScore(findings, { totalLines: 100 });
    assert.equal(score.score, 0);
    assert.equal(score.label, "critical");
  });

  test("labels: needs work band (50–74)", () => {
    // Need per_kloc between 26 and 50. 10 Performance warnings over 250 lines:
    // weighted = 10, per_kloc = 40, penalty = 40, score = 60.
    const findings = Array.from({ length: 10 }, () => diag("Performance", "warn"));
    const score = calculateScore(findings, { totalLines: 250 });
    assert.equal(score.score, 60);
    assert.equal(score.label, "needs work");
  });

  test("zero lines does not divide by zero", () => {
    const score = calculateScore([diag("Security", "error")], { totalLines: 0 });
    assert.equal(score.score, 0);
    assert.ok(Number.isFinite(score.perThousandLines));
  });

  test("byCategory counts every category", () => {
    const score = calculateScore([diag("Bugs", "error"), diag("Bugs", "warn")], { totalLines: 1000 });
    assert.equal(score.byCategory.Bugs, 2);
    assert.equal(score.byCategory.Security, 0);
  });
});
