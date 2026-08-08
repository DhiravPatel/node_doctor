/**
 * §201 — `no-nan-comparison`.
 *
 * A fact about the language, not a judgement about the code: `NaN` is not equal
 * to itself, so every comparison against it has a constant answer. The only
 * thing to establish is that the operand really is the global `NaN`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noNanComparison } from "../../src/diagnostics/bugs/no-nan-comparison.ts";

const findings = (source: string, filePath = "/repo/src/a.ts") =>
  lintSource({
    filePath,
    sourceText: source,
    diagnostics: [noNanComparison],
    capabilities: new Set(["node", "esm", "typescript"]),
  }).findings.filter((f) => f.diagnostic === "no-nan-comparison");

const fires = (source: string, filePath?: string) => {
  const found = findings(source, filePath);
  assert.ok(found.length > 0, `expected a FIRE on:\n${source}`);
  return found;
};

const silent = (source: string, filePath?: string): void => {
  const found = findings(source, filePath);
  assert.equal(found.length, 0, `expected SILENCE, got ${found.length}:\n${source}`);
};

describe("no-nan-comparison — fires", () => {
  test("`=== NaN` is always false, and says so", () => {
    const [f] = fires(`if (total === NaN) return 0;`);
    assert.match(f!.message, /always false/);
    assert.match(f!.message, /Number\.isNaN/);
  });

  test("`!== NaN` is always true, and says the opposite thing", () => {
    const [f] = fires(`if (total !== NaN) send(total);`);
    assert.match(f!.message, /always true/);
    assert.match(f!.message, /never reject/);
  });

  test("loose equality and the relational operators", () => {
    fires(`if (x == NaN) {}`);
    fires(`if (x != NaN) {}`);
    fires(`if (score > NaN) {}`);
    fires(`if (score <= NaN) {}`);
  });

  test("`Number.NaN` is the same value", () => {
    fires(`if (x === Number.NaN) {}`);
  });

  test("either side", () => {
    fires(`if (NaN === x) {}`);
  });

  test("one finding when both sides are NaN", () => {
    assert.equal(findings(`if (NaN === NaN) {}`).length, 1);
  });
});

describe("no-nan-comparison — silent", () => {
  test("the correct forms", () => {
    silent(`if (Number.isNaN(total)) return 0;`);
    silent(`if (Object.is(x, NaN)) {}`);
    silent(`if (x !== x) {}`);
  });

  test("arithmetic is not a comparison", () => {
    silent(`const y = x + NaN;`);
    silent(`x = NaN;`);
    silent(`switch (x) { case NaN: break; }`);
  });

  test("a rebound `NaN` is an ordinary variable", () => {
    silent(`const NaN = 1;\nif (x === NaN) {}`);
    silent(`function f(NaN) { return x === NaN; }`);
    silent(`if (x === obj.NaN) {}`);
  });
});

describe("no-nan-comparison — hardened by the adversarial hunt", () => {
  test("a file that declares its OWN `Number` is comparing object identity", () => {
    // `Number.NaN` there is a symbol, a frozen singleton, a schema object —
    // never the float. Applying this rule's advice inside such a file is a
    // TypeError, because the local `Number` has no `isNaN`.
    silent(`const Number = { NaN: Symbol("nan") };\nif (v === Number.NaN) {}`);
    silent(`import * as Number from "./number.ts";\nif (v === Number.NaN) {}`);
    silent(`export class Number { static NaN = new Number(); }\nexport const f = (v: any) => v === Number.NaN;`);
    silent(`export function f(Number: any, v: any) { return v === Number.NaN; }`);
  });

  test("a TypeScript `namespace Number` declares a value the resolver does not record", () => {
    silent(`export namespace Number { export const NaN = Symbol("x"); }\nexport const f = (t: symbol) => t === Number.NaN;`);
    silent(`enum Number { NaN = 1 }\nexport const f = (t: any) => t === Number.NaN;`);
  });

  test("a TEST FILE is inert — the constant IS the assertion", () => {
    // `expect(NaN === NaN).toBe(false)` pins the language fact down on purpose,
    // and there is no branch for the harm model to be about.
    silent(
      `import { test, expect } from "vitest";\ntest("SameValueZero", () => { expect(NaN === NaN).toBe(false); });`,
      "/repo/src/a.test.ts",
    );
    silent(
      `import test from "node:test";\nimport assert from "node:assert/strict";\ntest("order", () => { assert.equal(NaN < 1, false); });`,
      "/repo/test/compare.test.ts",
    );
  });

  test("a genuinely global `Number.NaN` still fires next to a local `Number` TYPE", () => {
    // A type alias is erased; it binds no value.
    fires(`type Number = { x: 1 };\nif (v === globalThis.Number.NaN) {}\nif (v === Number.NaN) {}`);
  });
});

describe("no-nan-comparison — determinism", () => {
  test("identical source yields identical findings", () => {
    const source = `if (a === NaN) {}\nif (b !== NaN) {}`;
    assert.equal(JSON.stringify(findings(source)), JSON.stringify(findings(source)));
    assert.equal(findings(source).length, 2);
  });
});
