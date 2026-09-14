/**
 * `no-unchecked-allsettled-result`.
 *
 * MEASURED on Node 22, one fulfilled and one rejected:
 *
 *   raw                        [{"status":"fulfilled","value":{"id":1}},{"status":"rejected","reason":{}}]
 *   b.value                    undefined
 *   b.value?.id                undefined
 *   results.map(r => r.value)  [{"id":1}, undefined]
 *   Promise.allSettled itself  never rejects — nothing throws, at all
 *
 * Choosing `allSettled` over `Promise.all` IS the decision to handle failures
 * individually, and reading only `.value` walks that decision back without saying
 * so. `Promise.all` would at least have rejected loudly; here the batch resolves,
 * the handler returns 200, and the failed half is `undefined`.
 *
 * The claim is not "you read `.value`" — that is the normal use — it is "you read
 * `.value` and NOTHING in this function ever looks at whether the entry
 * succeeded".
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noUncheckedAllsettledResult } from "../../src/diagnostics/async/no-unchecked-allsettled-result.ts";

const CAPS = new Set(["node", "esm", "typescript"]);

const findings = (body: string) =>
  lintSource({
    filePath: "/repo/src/service.ts",
    sourceText: `export async function load() {\n${body}\n}\n`,
    diagnostics: [noUncheckedAllsettledResult],
    capabilities: CAPS,
  }).findings.filter((f) => f.diagnostic === "no-unchecked-allsettled-result");

const fires = (body: string) => {
  const found = findings(body);
  assert.ok(found.length > 0, `expected a FIRE on:\n${body}`);
  return found;
};
const silent = (body: string): void => {
  const found = findings(body);
  assert.equal(found.length, 0, `expected SILENCE on:\n${body}\ngot: ${found.map((f) => f.message).join("\n")}`);
};

describe("no-unchecked-allsettled-result", () => {
  describe("the defect — a rejected settlement has no value", () => {
    test("destructured entries read for .value", () => {
      const found = fires(
        `const [user, orders] = await Promise.allSettled([getUser(), getOrders()]);\nreturn { user: user.value, orders: orders.value };`,
      );
      assert.equal(found.length, 2);
    });

    test("the array form, mapped", () => {
      fires(`const results = await Promise.allSettled(jobs);\nreturn results.map((r) => r.value);`);
    });

    test("every element callback, and reduce's second parameter", () => {
      fires(`const results = await Promise.allSettled(jobs);\nreturn results.forEach((r) => save(r.value));`);
      fires(`const results = await Promise.allSettled(jobs);\nreturn results.flatMap((r) => r.value);`);
      fires(`const results = await Promise.allSettled(jobs);\nreturn results.reduce((acc, r) => acc.concat(r.value), []);`);
    });

    test("a destructured .value inside the callback", () => {
      fires(`const results = await Promise.allSettled(jobs);\nreturn results.map((r) => { const { value } = r; return value; });`);
    });

    test("the message names the measurement and the decision", () => {
      const [found] = fires(`const results = await Promise.allSettled(jobs);\nreturn results.map((r) => r.value);`);
      assert.match(found!.message, /REJECTED settlement has no `value`/);
      assert.match(found!.message, /allSettled` never rejects/);
      assert.match(found!.message, /`Promise\.all` would at least have rejected loudly/);
      // The key does not become null — it disappears from the JSON entirely.
      assert.match(found!.message, /it is ABSENT/);
      assert.match(found!.message, /\{"user":\{"id":"u1"\}\}/);
      assert.match(found!.recommendation ?? "", /status === "fulfilled"/);
    });
  });

  describe("silence — the rejected case was considered", () => {
    test("a status check, in any spelling", () => {
      silent(
        `const [user] = await Promise.allSettled([getUser()]);\nif (user.status === "rejected") throw user.reason;\nreturn user.value;`,
      );
      silent(
        `const results = await Promise.allSettled(jobs);\nreturn results.filter((r) => r.status === "fulfilled").map((r) => r.value);`,
      );
      silent(`const results = await Promise.allSettled(jobs);\nreturn results.map((r) => (r.status === "fulfilled" ? r.value : null));`);
    });

    test("a reason read is the same proof", () => {
      silent(`const [user] = await Promise.allSettled([getUser()]);\nlog(user.reason);\nreturn user.value;`);
    });

    test("a destructure that names either half", () => {
      silent(`const [user] = await Promise.allSettled([getUser()]);\nconst { status, value } = user;\nreturn status === "fulfilled" ? value : null;`);
    });

    test("any fulfilled/rejected literal, which is how narrowing helpers are written", () => {
      silent(
        `const results = await Promise.allSettled(jobs);\nconst ok = (r) => r.status === "fulfilled";\nreturn results.map((r) => r.value);`,
      );
      silent(`const results = await Promise.allSettled(jobs);\nassertAll(results, "rejected");\nreturn results.map((r) => r.value);`);
    });

    test("the result passed onward unread", () => {
      silent(`const results = await Promise.allSettled(jobs);\nreturn results;`);
      silent(`const results = await Promise.allSettled(jobs);\nreturn summarize(results);`);
      silent(`const results = await Promise.allSettled(jobs);\nreturn results.length;`);
    });

    test("a computed read cannot be judged", () => {
      silent(`const results = await Promise.allSettled(jobs);\nreturn results.map((r) => r[key]);`);
    });
  });

  describe("precision guards", () => {
    test("Promise.all results have no .value wrapper and are never matched", () => {
      silent(`const rows = await Promise.all(jobs);\nreturn rows.map((r) => r.value);`);
      silent(`const [a] = await Promise.all([getUser()]);\nreturn a.value;`);
    });

    test("a same-named method on something else is not allSettled", () => {
      silent(`const results = await queue.allSettled(jobs);\nreturn results.map((r) => r.value);`);
    });

    test("a rebound or shadowed name is dropped", () => {
      silent(`const results = await Promise.allSettled(jobs);\nconst results2 = 1;\n{ const results = await refetch(); return results.map((r) => r.value); }`);
      silent(`const results = await Promise.allSettled(jobs);\nreturn other.map((results) => results.value);`);
    });

    test("a check outside the function is not visible, so nothing is claimed there", () => {
      // The enclosing function is the whole world the rule reasons about.
      const source = `const results = await Promise.allSettled(jobs);\nreturn results.map((r) => r.value);`;
      assert.equal(findings(source).length, 1);
    });
  });

  test("determinism — identical source yields identical findings", () => {
    const body = `const [a, b] = await Promise.allSettled([x(), y()]);\nreturn [a.value, b.value];`;
    assert.equal(JSON.stringify(findings(body)), JSON.stringify(findings(body)));
    assert.equal(findings(body).length, 2);
  });
});
