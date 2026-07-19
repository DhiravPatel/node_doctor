import { describe, test } from "node:test";
import { expectFires, expectSilent } from "../helpers.ts";

describe("no-async-array-callback", () => {
  test("silent: for...of with await", () => {
    expectSilent("no-async-array-callback", `for (const u of users) { await sendEmail(u); }`);
  });
  test("silent: Promise.all over a sync map", () => {
    expectSilent("no-async-array-callback", `await Promise.all(users.map((u) => sendEmail(u)));`);
  });
  test("silent: map result assigned", () => {
    expectSilent("no-async-array-callback", `const ps = users.map(async (u) => save(u));`);
  });
  test("silent: map result returned", () => {
    expectSilent("no-async-array-callback", `function f() { return users.map(async (u) => save(u)); }`);
  });
  test("fires: forEach with async callback", () => {
    expectFires("no-async-array-callback", `users.forEach(async (u) => { await sendEmail(u); });`);
  });
  test("fires: filter with async predicate", () => {
    expectFires("no-async-array-callback", `const active = users.filter(async (u) => await isActive(u));`);
  });
  test("fires: discarded map with async callback", () => {
    expectFires("no-async-array-callback", `items.map(async (i) => { await save(i); });`);
  });
});

describe("no-unbounded-promise-all", () => {
  test("silent: literal array is known-small", () => {
    expectSilent("no-unbounded-promise-all", `await Promise.all([fetchA(), fetchB(), fetchC()]);`);
  });
  test("silent: concurrency limiter applied", () => {
    expectSilent(
      "no-unbounded-promise-all",
      `const limit = pLimit(5);
       await Promise.all(rs.map((r) => limit(() => fetch("/x/" + r.id))));`,
    );
  });
  test("silent: mapper produces no async work", () => {
    expectSilent("no-unbounded-promise-all", `await Promise.all(rs.map((r) => r.id));`);
  });
  test("fires: unbounded fan-out over a variable collection", () => {
    expectFires(
      "no-unbounded-promise-all",
      `const rs = await db.restaurant.findMany();
       await Promise.all(rs.map((r) => fetch("https://partner.api/" + r.id)));`,
    );
  });
  test("fires: allSettled unbounded", () => {
    expectFires("no-unbounded-promise-all", `await Promise.allSettled(rows.map(async (r) => save(r)));`);
  });
});

describe("require-fetch-timeout", () => {
  test("silent: signal present", () => {
    expectSilent("require-fetch-timeout", `await fetch(url, { signal: AbortSignal.timeout(5000) });`);
  });
  test("silent: options are a variable (opaque)", () => {
    expectSilent("require-fetch-timeout", `await fetch(url, opts);`);
  });
  test("silent: method call, not global fetch", () => {
    expectSilent("require-fetch-timeout", `await client.fetch(url);`);
  });
  test("fires: no options", () => {
    expectFires("require-fetch-timeout", `const res = await fetch("https://partner.api/sync");`);
  });
  test("fires: options without a signal", () => {
    expectFires("require-fetch-timeout", `const res = await fetch(url, { method: "POST", body });`);
  });
});
