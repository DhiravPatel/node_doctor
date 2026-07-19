import { describe, test } from "node:test";
import { expectFires, expectSilent } from "../helpers.ts";

describe("no-unbounded-module-cache", () => {
  test("silent: TTL sweep evicts", () => {
    expectSilent(
      "no-unbounded-module-cache",
      `const sessionCache = new Map(); setInterval(() => sessionCache.clear(), 60000); export function remember(t, u) { sessionCache.set(t, u); }`,
    );
  });
  test("silent: WeakMap self-evicts", () => {
    expectSilent("no-unbounded-module-cache", `const cache = new WeakMap(); export function put(k, v) { cache.set(k, v); }`);
  });
  test("silent: function-scoped Map dies with the call", () => {
    expectSilent(
      "no-unbounded-module-cache",
      `function group(items) { const m = new Map(); for (const i of items) m.set(i.id, i); return m; }`,
    );
  });
  test("silent: has explicit delete", () => {
    expectSilent(
      "no-unbounded-module-cache",
      `const c = new Map(); export function put(k, v) { c.set(k, v); } export function drop(k) { c.delete(k); }`,
    );
  });
  test("fires: write-only module-scope Map", () => {
    expectFires(
      "no-unbounded-module-cache",
      `const sessionCache = new Map(); export function remember(token, user) { sessionCache.set(token, user); }`,
    );
  });
});
