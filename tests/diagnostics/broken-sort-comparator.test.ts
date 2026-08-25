/**
 * `no-broken-sort-comparator`.
 *
 * A comparator needs three answers: negative for "a first", positive for "b
 * first", zero for equal. A boolean supplies only 1 and 0, so nothing can move
 * toward the front and the sort is a no-op. MEASURED on `[5,3,9,1,7,2,8]`,
 * running every form before encoding it here:
 *
 *   sort((a, b) => a > b)            → [5,3,9,1,7,2,8]   unchanged
 *   sort((a, b) => a < b)            → [5,3,9,1,7,2,8]   unchanged
 *   sort((a, b) => a >= b)           → [5,3,9,1,7,2,8]   unchanged
 *   sort((a, b) => a === b)          → [5,3,9,1,7,2,8]   unchanged
 *   sort((a, b) => a > b ? 1 : 0)    → [5,3,9,1,7,2,8]   unchanged
 *   sort((a, b) => a && a !== b)     → [5,3,9,1,7,2,8]   unchanged
 *   sort((a, b) => !(a < b))         → [5,3,9,1,7,2,8]   unchanged
 *   function (a, b) { return a > b } → [5,3,9,1,7,2,8]   unchanged
 *
 *   sort((a, b) => a > b ? 1 : -1)   → [1,2,3,5,7,8,9]   CORRECT — must be silent
 *   sort((a, b) => a - b)            → [1,2,3,5,7,8,9]   CORRECT — must be silent
 *
 * The `? 1 : -1` and `Math.random() - 0.5` rows are the ones that decide the
 * predicate: it is "every return is provably non-negative", not "the return
 * looks boolean-ish".
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noBrokenSortComparator } from "../../src/diagnostics/bugs/no-broken-sort-comparator.ts";

const findings = (source: string) =>
  lintSource({
    filePath: "/repo/src/report.ts",
    sourceText: source,
    diagnostics: [noBrokenSortComparator],
    capabilities: new Set(["node", "esm", "typescript"]),
  }).findings.filter((f) => f.diagnostic === "no-broken-sort-comparator");

const fires = (source: string) => {
  const found = findings(source);
  assert.ok(found.length > 0, `expected a FIRE on:\n${source}`);
  return found;
};
const silent = (source: string): void =>
  assert.equal(findings(source).length, 0, `expected SILENCE on:\n${source}`);

describe("no-broken-sort-comparator", () => {
  describe("the defect", () => {
    test("a bare greater-than — the canonical shape", () => {
      fires(`rows.sort((a, b) => a.total > b.total);`);
    });

    test("every relational and equality operator", () => {
      for (const op of [">", "<", ">=", "<=", "===", "!==", "==", "!="]) {
        fires(`rows.sort((a, b) => a.k ${op} b.k);`);
      }
    });

    test("a conditional whose branches are both non-negative", () => {
      fires(`rows.sort((a, b) => (a.name > b.name ? 1 : 0));`);
    });

    test("a negated comparison", () => {
      fires(`rows.sort((a, b) => !(a.k < b.k));`);
    });

    test("a logical combination of comparisons", () => {
      fires(`rows.sort((a, b) => a.k > b.k && a.k !== b.k);`);
      fires(`rows.sort((a, b) => a.k > b.k || a.k === b.k);`);
    });

    test("a block body whose every return is non-negative", () => {
      fires(`
        rows.sort(function (a, b) {
          if (a.k > b.k) return 1;
          return 0;
        });
      `);
    });

    test("a plain function expression returning a comparison", () => {
      fires(`rows.sort(function (a, b) { return a.k > b.k; });`);
    });

    test("toSorted has the same contract", () => {
      fires(`const out = rows.toSorted((a, b) => a.k > b.k);`);
    });

    test("optional chaining and a `this` receiver", () => {
      fires(`this.items.sort((a, b) => a.k > b.k);`);
      fires(`rows?.sort((a, b) => a.k > b.k);`);
    });

    test("the message names the mechanism and shows the measured result", () => {
      const [found] = fires(`rows.sort((a, b) => a.total > b.total);`);
      assert.match(found!.message, /non-negative/);
      assert.match(found!.message, /\[5,3,9,1,7,2,8\]/);
      assert.match(found!.recommendation ?? "", /localeCompare|NEGATIVE/);
    });
  });

  describe("silence — comparators that actually work", () => {
    test("subtraction", () => {
      silent(`rows.sort((a, b) => a.total - b.total);`);
    });

    test("localeCompare", () => {
      silent(`rows.sort((a, b) => a.name.localeCompare(b.name));`);
    });

    test("a conditional with a negative branch", () => {
      silent(`rows.sort((a, b) => (a.name > b.name ? 1 : -1));`);
      silent(`rows.sort((a, b) => (a.k > b.k ? 1 : a.k < b.k ? -1 : 0));`);
    });

    test("a block body with a negative return", () => {
      silent(`
        rows.sort(function (a, b) {
          if (a.k > b.k) return 1;
          if (a.k < b.k) return -1;
          return 0;
        });
      `);
    });

    test("the deliberate shuffle idiom", () => {
      silent(`rows.sort(() => Math.random() - 0.5);`);
    });

    test("a comparator delegating to a helper", () => {
      silent(`rows.sort((a, b) => byPriority(a, b));`);
      silent(`rows.sort(byPriority);`);
    });

    test("Date subtraction", () => {
      silent(`rows.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());`);
    });

    test("a unary minus", () => {
      silent(`rows.sort((a, b) => -compare(a, b));`);
    });

    test("sort with no comparator at all is a different rule's business", () => {
      silent(`rows.sort();`);
    });
  });

  describe("the second clause — a comparator that never reads one element", () => {
    test("subtracting two fields of the SAME element", () => {
      // Verified: [{p:3},{p:1},{p:2}].sort((a,b) => a.p - a.q) gives [2,1,3].
      fires(`rows.sort((a, b) => a.price - a.cost);`);
    });

    test("returning a field of only the first element", () => {
      fires(`rows.sort((a, b) => a.priority);`);
    });

    test("reading only the SECOND element", () => {
      fires(`rows.sort((a, b) => b.rank - b.offset);`);
    });

    test("a single declared parameter cannot compare a pair", () => {
      fires(`rows.sort((a) => a.priority);`);
    });

    test("destructured parameters count as read", () => {
      silent(`rows.sort(({ k: x }, { k: y }) => x - y);`);
    });

    test("a destructured parameter that is never used is still unread", () => {
      fires(`rows.sort(({ k: x }, { k: y }) => x - x);`);
    });

    test("a nested-block shadow is a documented recall gap, not a precision one", () => {
      // This comparator IS broken — it reads the inner `b`, never the element,
      // and the array comes back unsorted (verified). But the scope resolver
      // models module/function/catch scopes and not nested blocks, so the inner
      // `const b` hoists to the function scope and reads as the parameter.
      //
      // A top-level `const b` beside a parameter `b` is a SyntaxError
      // ("Identifier 'b' has already been declared"), so a nested block is the
      // only legal way to write this — which is why the gap is narrow.
      //
      // Pinned as SILENT deliberately: the rule under-reports here rather than
      // reporting correct code. If block scopes are ever modelled, this test
      // should flip to `fires` on purpose, not by accident.
      silent(`
        rows.sort((a, b) => {
          {
            const b = { v: 1 };
            return a.v - b.v;
          }
        });
      `);
    });

    test("a rest parameter reads both elements through one binding", () => {
      silent(`rows.sort((...args) => args[0].k - args[1].k);`);
    });

    test("`arguments` bypasses the named parameters", () => {
      silent(`rows.sort(function (a, b) { return arguments[0].k - arguments[1].k; });`);
    });

    test("a zero-parameter comparator is the shuffle idiom", () => {
      silent(`rows.sort(() => Math.random() - 0.5);`);
    });

    test("a parameter named `_` is taken at its word", () => {
      // The one clause-2 hit across every readable `.sort(` on this machine was
      // vite's lockfile ordering, `.sort((_, { manager }) => …)`. That comparator
      // really is non-antisymmetric, but arguing with an explicit `_` is how a
      // rule gets switched off.
      silent(`
        formats.sort((_, { manager }) =>
          process.env.npm_config_user_agent?.startsWith(manager) ? 1 : -1);
      `);
      silent(`rows.sort((_a, b) => b.k - b.j);`);
    });

    test("the message names the unread element", () => {
      const [found] = fires(`rows.sort((a, b) => a.price - a.cost);`);
      assert.match(found!.message, /never reads `b`/);
    });
  });

  describe("precision guards", () => {
    test("a comparator with no return is not claimed by the NON-NEGATIVE clause", () => {
      // `undefined` coerces to NaN, not to a non-negative number, so clause 1
      // cannot prove anything here. Clause 2 still can when the parameters are
      // declared and read — this one reads both, so nothing fires.
      silent(`rows.sort(function (a, b) { doSomething(a, b); });`);
    });

    test("but an empty body reads neither element, which clause 2 does claim", () => {
      fires(`rows.sort((a, b) => {});`);
    });

    test("a bare `return;` is not claimed either", () => {
      silent(`
        rows.sort(function (a, b) {
          if (a.k > b.k) return 1;
          return;
        });
      `);
    });

    test("a return inside a NESTED function is not this comparator's return", () => {
      // The outer comparator's own return is a subtraction, which is fine.
      silent(`
        rows.sort(function (a, b) {
          const key = (x) => { return x.a > x.b; };
          return key(a) - key(b);
        });
      `);
    });

    test("a bare `sort(fn)` call with no receiver is not an array sort", () => {
      silent(`sort((a, b) => a > b);`);
    });

    test("a constant comparator is claimed either way", () => {
      // `0` is non-negative, so clause 1 catches it; `-1` is not, but clause 2
      // does — neither reads an element, so neither can be comparing them.
      fires(`rows.sort((a, b) => 0);`);
      fires(`rows.sort((a, b) => -1);`);
    });

    test("a constant comparator with no parameters is the shuffle idiom", () => {
      // Zero declared parameters is how the deliberate shuffle is spelled, so
      // clause 2 stays out; `-1` defeats clause 1 too.
      silent(`rows.sort(() => -1);`);
    });

    test("a comparator on a differently-named method is untouched", () => {
      silent(`rows.filter((a, b) => a.k > b.k);`);
      silent(`rows.sortBy((a, b) => a.k > b.k);`);
    });

    test("plain numeric addition in a comparator proves nothing", () => {
      silent(`rows.sort((a, b) => a.k + b.k);`);
    });
  });
});
