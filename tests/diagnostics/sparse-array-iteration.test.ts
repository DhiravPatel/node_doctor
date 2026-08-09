/**
 * §200 — `no-sparse-array-iteration`.
 *
 * `new Array(5)` creates five HOLES, not five `undefined`s, and every
 * callback-taking method on `Array.prototype` skips holes — so the callback
 * never runs. It fails quietly: `.length` is still 5 and `JSON.stringify`
 * renders the holes as `null`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noSparseArrayIteration } from "../../src/diagnostics/bugs/no-sparse-array-iteration.ts";

const findings = (source: string) =>
  lintSource({
    filePath: "/repo/src/a.ts",
    sourceText: source,
    diagnostics: [noSparseArrayIteration],
    capabilities: new Set(["node", "esm", "typescript"]),
  }).findings.filter((f) => f.diagnostic === "no-sparse-array-iteration");

const fires = (source: string) => {
  const found = findings(source);
  assert.ok(found.length > 0, `expected a FIRE on:\n${source}`);
  return found;
};

const silent = (source: string): void => {
  const found = findings(source);
  assert.equal(found.length, 0, `expected SILENCE, got ${found.length}:\n${source}`);
};

describe("no-sparse-array-iteration — fires", () => {
  test("the classic `new Array(n).map(...)`", () => {
    const [f] = fires(`const ids = new Array(5).map((_, i) => i);`);
    assert.match(f!.message, /5 \*\*holes\*\*/);
    assert.match(f!.message, /Array\.from/);
  });

  test("`forEach` runs zero times, and the message says so", () => {
    const [f] = fires(`Array(3).forEach(seed);`);
    assert.match(f!.message, /callback never runs/);
    assert.doesNotMatch(f!.message, /result is another array/);
  });

  test("every hole-skipping method", () => {
    assert.equal(
      findings(
        `new Array(4).filter(Boolean);\nnew Array(4).some(f);\nnew Array(4).every(f);\nnew Array(4).reduce(f, 0);\nnew Array(2).flatMap(f);\nnew Array(2).find(f);\nnew Array(2).findIndex(f);`,
      ).length,
      7,
    );
  });
});

describe("no-sparse-array-iteration — silent", () => {
  test("the two correct forms", () => {
    silent(`const ids = new Array(5).fill(0).map((_, i) => i);`);
    silent(`const ids = Array.from({ length: 5 }, (_, i) => i);`);
  });

  test("the ELEMENTS form has no holes", () => {
    silent(`new Array(1, 2, 3).map(f);`);
    silent(`[1, 2, 3].map(f);`);
  });

  test("a length that is not a positive integer literal", () => {
    // `new Array(n)` might be `new Array(0)`, or not the length form at all.
    silent(`new Array(n).map(f);`);
    silent(`new Array(0).map(f);`);
    silent(`new Array(2.5).map(f);`);
    silent(`new Array(-1).map(f);`);
    silent(`new Array(count).forEach(f);`);
  });

  test("methods that VISIT holes", () => {
    silent(`new Array(5).join(",");`);
    silent(`new Array(5).keys();`);
    silent(`new Array(5).fill(0);`);
    silent(`new Array(5).includes(1);`);
  });

  test("a local `Array` is somebody else's constructor", () => {
    silent(`function f(Array) { return new Array(5).map(g); }`);
  });
});

describe("no-sparse-array-iteration — determinism", () => {
  test("identical source yields identical findings", () => {
    const source = `new Array(3).map(f);\nnew Array(4).forEach(g);`;
    assert.equal(JSON.stringify(findings(source)), JSON.stringify(findings(source)));
    assert.equal(findings(source).length, 2);
  });
});
