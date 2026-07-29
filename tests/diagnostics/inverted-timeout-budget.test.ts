/**
 * §136 — `no-inverted-timeout-budget`. Opt-in; driven directly through
 * `lintSource` with an explicit single-rule list.
 *
 * v2 semantics: every meaning is PROVEN, never assumed from a name — the wrapper
 * must resolve to the `p-timeout` package, a race timer must provably reject, and
 * each HTTP client is verified by its import (adversarial-hunt hardening).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noInvertedTimeoutBudget } from "../../src/diagnostics/reliability/no-inverted-timeout-budget.ts";

const CAPS = new Set(["node", "esm", "typescript"]);

const findings = (source: string) =>
  lintSource({
    filePath: "test.ts",
    sourceText: source,
    diagnostics: [noInvertedTimeoutBudget],
    capabilities: CAPS,
  }).findings.filter((f) => f.diagnostic === "no-inverted-timeout-budget");

const fires = (source: string): void => {
  assert.ok(findings(source).length > 0, `expected no-inverted-timeout-budget to FIRE on:\n${source}`);
};

const silent = (source: string): void => {
  const found = findings(source);
  assert.equal(
    found.length,
    0,
    `expected SILENCE, got ${found.length}:\n` +
      found.map((f) => `  - ${f.message}`).join("\n") +
      `\n--- source ---\n${source}`,
  );
};

const PT = `import pTimeout from "p-timeout";\n`;
const AX = `import axios from "axios";\n`;
const GOT = `import got from "got";\n`;
const KY = `import ky from "ky";\n`;

describe("no-inverted-timeout-budget — fires (proven semantics)", () => {
  test("imported p-timeout around a fetch with a longer AbortSignal.timeout", () => {
    fires(PT + `await pTimeout(fetch(url, { signal: AbortSignal.timeout(10_000) }), 2_000);`);
  });

  test("p-timeout via require()", () => {
    fires(`const pTimeout = require("p-timeout");\nawait pTimeout(fetch(url, { signal: AbortSignal.timeout(10_000) }), 2_000);`);
  });

  test("p-timeout under a different import name still fires (binding, not name)", () => {
    fires(`import pt from "p-timeout";\nawait pt(fetch(url, { signal: AbortSignal.timeout(10_000) }), 2_000);`);
  });

  test("p-timeout with { milliseconds } options form", () => {
    fires(PT + `await pTimeout(fetch(url, { signal: AbortSignal.timeout(30_000) }), { milliseconds: 5_000 });`);
  });

  test("imported axios.get with a longer timeout inside p-timeout", () => {
    fires(PT + AX + `await pTimeout(axios.get(url, { timeout: 30_000 }), 5_000);`);
  });

  test("race with an inline rejecting timer and a longer got timeout", () => {
    fires(GOT + `
      await Promise.race([
        got(url, { timeout: { request: 30_000 } }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 10_000)),
      ]);
    `);
  });

  test("race with setTimeout(reject, B) shorthand", () => {
    fires(`
      await Promise.race([
        fetch(url, { signal: AbortSignal.timeout(30_000) }),
        new Promise((resolve, reject) => setTimeout(reject, 5_000)),
      ]);
    `);
  });

  test("race with a same-file PROVABLY rejecting helper", () => {
    fires(AX + `
      const rejectAfter = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error("t")), ms));
      await Promise.race([axios.get(url, { timeout: 30_000 }), rejectAfter(5_000)]);
    `);
  });

  test("one hop into a module-level function declaration", () => {
    fires(PT + `
      async function loadUser(id) {
        return fetch("/u/" + id, { signal: AbortSignal.timeout(20_000) });
      }
      await pTimeout(loadUser(7), 3_000);
    `);
  });

  test("one hop into a module-level const arrow", () => {
    fires(PT + AX + `
      const loadOrders = () => axios.get("/orders", { timeout: 45_000 });
      await pTimeout(loadOrders(), 10_000);
    `);
  });

  test("multiplication literals (60 * 1000) resolve statically", () => {
    fires(PT + `await pTimeout(fetch(u, { signal: AbortSignal.timeout(60 * 1000) }), 5 * 1000);`);
  });

  test("imported ky with a longer timeout option", () => {
    fires(PT + KY + `await pTimeout(ky(url, { timeout: 30_000 }), 4_000);`);
  });

  test("node:https request with a longer timeout via module-level hop", () => {
    fires(PT + `import https from "node:https";
      function doRequest() { return https.request({ host, timeout: 30_000 }); }
      await pTimeout(doRequest(), 1_000);`);
  });

  test("a map callback runs under the budget and counts", () => {
    fires(PT + `await pTimeout(Promise.all(ids.map((id) => fetch(id, { signal: AbortSignal.timeout(30_000) }))), 2_000);`);
  });

  test("an IIFE body runs under the budget and counts", () => {
    fires(PT + `await pTimeout((async () => { return fetch(u, { signal: AbortSignal.timeout(30_000) }); })(), 2_000);`);
  });
});

describe("no-inverted-timeout-budget — silent (name is not semantics)", () => {
  test("a same-file withTimeout(fn, retries) RETRY helper never fires", () => {
    silent(`
      async function withTimeout(fn, retries) {
        let lastErr;
        for (let i = 0; i <= retries; i++) { try { return await fn(); } catch (e) { lastErr = e; } }
        throw lastErr;
      }
      export async function loadUser(url) {
        return withTimeout(() => fetch(url, { signal: AbortSignal.timeout(10_000) }), 3);
      }
    `);
  });

  test("this.withTimeout(fn, attempts) — a class retry method never fires", () => {
    silent(`
      export class ApiClient {
        async withTimeout(fn, attempts) {
          let lastErr;
          for (let i = 0; i < attempts; i++) { try { return await fn(); } catch (e) { lastErr = e; } }
          throw lastErr;
        }
        async getUser(url) {
          return this.withTimeout(() => fetch(url, { signal: AbortSignal.timeout(10_000) }), 5);
        }
      }
    `);
  });

  test("lock.withTimeout(op, seconds) — an SDK method never fires", () => {
    silent(`
      const lock = new LockClient();
      export async function loadWithLock(url) {
        return lock.withTimeout(fetch(url, { signal: AbortSignal.timeout(10_000) }), 60);
      }
    `);
  });

  test("a local const pTimeout tracing shim never fires (binding beats name)", () => {
    silent(`
      const pTimeout = (p, spanId) => p;
      await pTimeout(fetch(url, { signal: AbortSignal.timeout(30_000) }), 2_000);
    `);
  });

  test("bare pTimeout with NO p-timeout import never fires", () => {
    silent(`await pTimeout(fetch(url, { signal: AbortSignal.timeout(10_000) }), 2_000);`);
  });

  test("race with a resolve-only sleep helper never counts as a timer", () => {
    silent(GOT + `
      const timeout = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      await Promise.race([got(url, { timeout: { request: 30_000 } }), timeout(300)]);
    `);
  });

  test("race with an inline resolve-only sleep never counts", () => {
    silent(GOT + `
      await Promise.race([
        got(url, { timeout: { request: 30_000 } }),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    `);
  });

  test("a query-chain .timeout(5_000) METHOD is not a race timer", () => {
    silent(AX + `
      await Promise.race([
        axios.get(url, { timeout: 30_000 }),
        db.select("*").from("t").timeout(5_000),
      ]);
    `);
  });

  test("an IMPORTED race helper of unknown semantics never counts", () => {
    silent(AX + `import { rejectAfter } from "./helpers";
      await Promise.race([axios.get(url, { timeout: 30_000 }), rejectAfter(5_000)]);`);
  });

  test("a conditionally-rejecting timer (offline guard) is not a deadline", () => {
    silent(`
      await Promise.race([
        fetch(url, { signal: AbortSignal.timeout(10_000) }),
        new Promise((resolve, reject) => { if (!navigator.onLine) setTimeout(() => reject(new Error("offline")), 500); }),
      ]);
    `);
  });

  test("a same-file helper whose first arg is not the delay never counts", () => {
    silent(AX + `
      const timeout = async (gameId) => loadGame(gameId);
      await Promise.race([axios.get(url, { timeout: 30_000 }), timeout(42)]);
    `);
  });

  test("axios.post BODY field named timeout is payload, not config", () => {
    silent(PT + AX + `await pTimeout(axios.post(url, { timeout: 60_000 }), 5_000);`);
  });

  test("a same-file function NAMED got is not the got library", () => {
    silent(PT + `
      const got = (u, opts) => cache.get(u) ?? opts;
      await pTimeout(got(url, { timeout: 30_000 }), 5_000);
    `);
  });

  test("a shadowed local fetch map-reader is not global fetch", () => {
    silent(PT + `
      const fetch = (key, opts) => store.get(key);
      await pTimeout(fetch(url, { signal: AbortSignal.timeout(30_000) }), 2_000);
    `);
  });

  test("got's nested { timeout: { request } } shape never applies to axios", () => {
    silent(PT + AX + `await pTimeout(axios.get(url, { timeout: { request: 30_000 } }), 5_000);`);
  });

  test("a let-bound hop target (reassignable) is never followed", () => {
    silent(PT + `
      let load = () => fetch(u, { signal: AbortSignal.timeout(30_000) });
      load = () => fetch(u);
      await pTimeout(load(), 2_000);
    `);
  });

  test("inner timeout shorter than or equal to the budget (correct layering)", () => {
    silent(PT + `await pTimeout(fetch(url, { signal: AbortSignal.timeout(1_000) }), 5_000);`);
    silent(PT + `await pTimeout(fetch(url, { signal: AbortSignal.timeout(5_000) }), 5_000);`);
  });

  test("race timer LONGER than the inner timeout (correct layering)", () => {
    silent(`
      const rejectAfter = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error("t")), ms));
      await Promise.race([fetch(url, { signal: AbortSignal.timeout(10_000) }), rejectAfter(30_000)]);
    `);
  });

  test("dynamic budget or dynamic inner timeout", () => {
    silent(PT + `await pTimeout(fetch(url, { signal: AbortSignal.timeout(30_000) }), budgetMs);`);
    silent(PT + AX + `await pTimeout(axios.get(url, { timeout: cfg.timeout }), 5_000);`);
  });

  test("axios timeout: 0 (client 'no timeout' sentinel) is skipped", () => {
    silent(PT + AX + `await pTimeout(axios.get(url, { timeout: 0 }), 5_000);`);
  });

  test("a factory-returned (uninvoked) function's timeout does not count", () => {
    silent(PT + `
      function makeLoader() { return () => fetch(url, { signal: AbortSignal.timeout(30_000) }); }
      await pTimeout(makeLoader(), 2_000);
    `);
  });

  test("a function merely defined inside the op does not count", () => {
    silent(PT + AX + `
      await pTimeout((async () => {
        const helper = () => axios.get(u, { timeout: 30_000 });
        return db.ping();
      })(), 2_000);
    `);
  });

  test("got.extend config is never a request", () => {
    silent(PT + GOT + `await pTimeout(setup(), 5_000);
      function setup() { return got.extend({ timeout: { request: 30_000 } }); }`);
  });

  test("race between two data sources with no timer", () => {
    silent(`await Promise.race([fetch(a, { signal: AbortSignal.timeout(30_000) }), fetch(b)]);`);
  });
});

describe("no-inverted-timeout-budget — round-2 hunt regressions (ambiguity beats proof)", () => {
  test("a block-scoped shim shadowing the p-timeout import makes the name ambiguous", () => {
    silent(`
      import pTimeout from "p-timeout";
      import { withRetries } from "./retry-utils.ts";
      if (legacyMode) {
        const pTimeout = (promise, retries) => withRetries(promise, retries);
        void pTimeout(fetch(u, { signal: AbortSignal.timeout(10_000) }), 4);
      }
    `);
  });

  test("a let/var require binding is mutable and never a proof", () => {
    silent(`
      let pTimeout = require("p-timeout");
      pTimeout = (promise, retries) => promise;
      export const run = (url) => pTimeout(fetch(url, { signal: AbortSignal.timeout(10_000) }), 3);
    `);
    silent(`
      import pt from "p-timeout";
      var axios = require("axios");
      axios = makeStub();
      await pt(axios.get(u, { timeout: 30_000 }), 5_000);
    `);
  });

  test("a shadowed param named pTimeout makes the name ambiguous", () => {
    silent(`
      import pTimeout from "p-timeout";
      export function run(pTimeout) {
        return pTimeout(fetch(u, { signal: AbortSignal.timeout(10_000) }), 3);
      }
    `);
  });

  test("a race helper that reassigns its delay param is not a provable timer", () => {
    silent(GOT + `
      const deadline = (ms) => {
        ms = Math.max(ms, 60_000);
        return new Promise((_, reject) => setTimeout(() => reject(new Error("t")), ms));
      };
      await Promise.race([got(u, { timeout: { request: 30_000 } }), deadline(100)]);
    `);
  });

  test("a helper that CONTAINS a timer but returns the op races nothing", () => {
    silent(GOT + `
      const warnIfSlow = (ms, op) => {
        const warn = new Promise((_, reject) => setTimeout(() => reject(new Error("slow")), ms));
        warn.catch(() => console.warn("slow"));
        return op;
      };
      await Promise.race([warnIfSlow(500, got(a, { timeout: { request: 30_000 } })), got(b, { timeout: { request: 30_000 } })]);
    `);
  });

  test("a reject guarded INSIDE the setTimeout callback is not a deadline", () => {
    silent(`
      await Promise.race([
        fetch(u, { signal: AbortSignal.timeout(10_000) }),
        new Promise((resolve, reject) => setTimeout(() => { if (CHAOS) reject(new Error("chaos")); }, 100)),
      ]);
    `);
  });

  test("an executor that also calls clearTimeout may disarm itself — not provable", () => {
    silent(`
      await Promise.race([
        fetch(u, { signal: AbortSignal.timeout(10_000) }),
        new Promise((resolve, reject) => {
          const id = setTimeout(() => reject(new Error("t")), 100);
          clearTimeout(id);
        }),
      ]);
    `);
  });

  test("a hop target that returns a THUNK containing the long fetch is construction, not execution", () => {
    silent(PT + `
      const makeUploader = () => () => fetch(u, { signal: AbortSignal.timeout(30_000) });
      await pTimeout(makeUploader(), 2_000);
    `);
  });

  test("a bare .map (possibly a lazy stream helper) is not followed", () => {
    silent(PT + `
      await pTimeout(readable.map((x) => fetch(x, { signal: AbortSignal.timeout(30_000) })), 2_000);
    `);
  });

  test("Promise.all(ids.map(cb)) is still followed (the provable combinator shape)", () => {
    fires(PT + `await pTimeout(Promise.all(ids.map((id) => fetch(id, { signal: AbortSignal.timeout(30_000) }))), 2_000);`);
  });
});

describe("no-inverted-timeout-budget — determinism", () => {
  test("same input, same findings", () => {
    const src = PT + `await pTimeout(fetch(url, { signal: AbortSignal.timeout(10_000) }), 2_000);`;
    assert.deepEqual(JSON.stringify(findings(src)), JSON.stringify(findings(src)));
  });
});
