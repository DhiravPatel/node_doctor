/**
 * Tests for the error-taxonomy (§153) and BigInt-serialization (§145) rules.
 *
 * These diagnostics are not yet in the generated registry (the orchestrator
 * wires that), so we drive `lintSource` with the diagnostic object directly
 * rather than resolving it by id through the shared test helpers.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { lintSource } from "../../src/core/scan.ts";
import type { Diagnostic } from "../../src/core/types.ts";
import { noThrowLiteral } from "../../src/diagnostics/bugs/no-throw-literal.ts";
import { noBigintPrecisionLoss } from "../../src/diagnostics/bugs/no-bigint-precision-loss.ts";

const CAPS = new Set(["node", "esm", "typescript"]);

const countFor = (diagnostic: Diagnostic, source: string): number => {
  const { findings } = lintSource({
    filePath: "test.ts",
    sourceText: source,
    diagnostics: [diagnostic],
    capabilities: CAPS,
  });
  return findings.filter((f) => f.diagnostic === diagnostic.id).length;
};

const fires = (diagnostic: Diagnostic, source: string): void => {
  const n = countFor(diagnostic, source);
  assert.ok(n > 0, `expected ${diagnostic.id} to FIRE but got 0 on:\n${source}`);
};

const silent = (diagnostic: Diagnostic, source: string): void => {
  const n = countFor(diagnostic, source);
  assert.equal(n, 0, `expected ${diagnostic.id} to STAY SILENT but got ${n} on:\n${source}`);
};

// ---------------------------------------------------------------------------
// no-throw-literal
// ---------------------------------------------------------------------------

describe("no-throw-literal", () => {
  test("fires on a thrown string literal", () => {
    fires(noThrowLiteral, `function f() { throw "user not found"; }`);
  });
  test("fires on a thrown number", () => {
    fires(noThrowLiteral, `function f() { throw 42; }`);
  });
  test("fires on a thrown boolean", () => {
    fires(noThrowLiteral, `function f() { throw true; }`);
  });
  test("fires on a thrown null", () => {
    fires(noThrowLiteral, `function f() { throw null; }`);
  });
  test("fires on a thrown bare undefined", () => {
    fires(noThrowLiteral, `function f() { throw undefined; }`);
  });
  test("fires on a thrown object literal", () => {
    fires(noThrowLiteral, `function f() { throw { code: "ENOENT", message: "x" }; }`);
  });
  test("fires on a thrown array literal", () => {
    fires(noThrowLiteral, `function f() { throw [1, 2, 3]; }`);
  });
  test("fires on a thrown template literal", () => {
    fires(noThrowLiteral, "function f(x) { throw `bad: ${x}`; }");
  });
  test("fires on a const identifier resolving to a string", () => {
    fires(noThrowLiteral, `function f() { const msg = "boom"; throw msg; }`);
  });
  test("fires on a const identifier resolving to an object literal", () => {
    fires(noThrowLiteral, `function f() { const e = { code: 1 }; throw e; }`);
  });

  // --- MUST be silent ---
  test("silent on throw new Error", () => {
    silent(noThrowLiteral, `function f() { throw new Error("boom"); }`);
  });
  test("silent on throw new TypeError", () => {
    silent(noThrowLiteral, `function f() { throw new TypeError("bad arg"); }`);
  });
  test("silent on throw new CustomError (unknown class assumed Error-like)", () => {
    silent(noThrowLiteral, `function f() { throw new CustomError("nope", 404); }`);
  });
  test("silent on a re-throw of a caught param", () => {
    silent(noThrowLiteral, `function f() { try { g(); } catch (err) { throw err; } }`);
  });
  test("silent on throw of an unresolved identifier", () => {
    silent(noThrowLiteral, `function f() { throw somethingElse; }`);
  });
  test("silent on throw of a factory call result", () => {
    silent(noThrowLiteral, `function f() { throw makeError("boom"); }`);
  });
  test("silent on throw Error(...) without new (returns an Error)", () => {
    silent(noThrowLiteral, `function f() { throw Error("boom"); }`);
  });
  test("silent on a let identifier (reassignable — could hold an Error)", () => {
    silent(noThrowLiteral, `function f() { let e = "x"; e = buildError(); throw e; }`);
  });
  test("silent on a const identifier initialized from a NewExpression", () => {
    silent(noThrowLiteral, `function f() { const err = new Error("x"); throw err; }`);
  });
  test("silent on a const identifier initialized from a call", () => {
    silent(noThrowLiteral, `function f() { const err = makeError(); throw err; }`);
  });
  test("silent on a const identifier destructured from an object", () => {
    silent(noThrowLiteral, `function f(o) { const { err } = o; throw err; }`);
  });
});

// ---------------------------------------------------------------------------
// no-bigint-precision-loss
// ---------------------------------------------------------------------------

describe("no-bigint-precision-loss", () => {
  test("fires on Number() of a BigInt literal", () => {
    fires(noBigintPrecisionLoss, `const n = Number(123n);`);
  });
  test("fires on Number() of a const BigInt binding", () => {
    fires(noBigintPrecisionLoss, `const id = 9007199254740993n; const n = Number(id);`);
  });
  test("fires on Number() of a BigInt(...) result", () => {
    fires(noBigintPrecisionLoss, `const id = BigInt(rawId); const n = Number(id);`);
  });
  test("fires on Number() of a direct BigInt(...) call", () => {
    fires(noBigintPrecisionLoss, `const n = Number(BigInt(rawId));`);
  });
  test("fires on unary + of a BigInt", () => {
    fires(noBigintPrecisionLoss, `const big = 123n; const n = +big;`);
  });
  test("fires on parseInt of a BigInt", () => {
    fires(noBigintPrecisionLoss, `const id = BigInt(x); const n = parseInt(id);`);
  });
  test("fires on parseFloat of a BigInt", () => {
    fires(noBigintPrecisionLoss, `const n = parseFloat(123n);`);
  });
  test("fires through a const alias chain of BigInts", () => {
    fires(noBigintPrecisionLoss, `const a = 123n; const b = a; const n = Number(b);`);
  });

  // --- MUST be silent ---
  test("silent on String() of a BigInt (lossless)", () => {
    silent(noBigintPrecisionLoss, `const id = 123n; const s = String(id);`);
  });
  test("silent on .toString() of a BigInt (lossless)", () => {
    silent(noBigintPrecisionLoss, `const id = 123n; const s = id.toString();`);
  });
  test("silent when the operand is not provably a BigInt (a name like id)", () => {
    silent(noBigintPrecisionLoss, `function f(id) { return Number(id); }`);
  });
  test("silent on Number() of a plain number literal", () => {
    silent(noBigintPrecisionLoss, `const n = Number(42);`);
  });
  test("silent on Number() of a member expression of unknown type", () => {
    silent(noBigintPrecisionLoss, `const n = Number(row.id);`);
  });
  test("silent on a let binding initialized to a BigInt (reassignable)", () => {
    silent(noBigintPrecisionLoss, `let id = 123n; id = 5; const n = Number(id);`);
  });
  test("silent on unary + of a plain number binding", () => {
    silent(noBigintPrecisionLoss, `const x = 5; const n = +x;`);
  });
  test("silent on unary - of a BigInt (stays a BigInt)", () => {
    silent(noBigintPrecisionLoss, `const big = 123n; const n = -big;`);
  });
  test("silent on Number() with no arguments", () => {
    silent(noBigintPrecisionLoss, `const n = Number();`);
  });
});
