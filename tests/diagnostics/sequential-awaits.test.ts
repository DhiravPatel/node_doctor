/**
 * §132 static latency — no-sequential-independent-awaits (Performance, opt-in).
 *
 * Imports the diagnostic module directly and lints with an explicit diagnostic
 * list, so the test does not depend on the generated registry. The MUST-be-silent
 * cases dominate: this rule is precision-first (a false positive is a release
 * blocker), so every deliberate-silence branch is guarded here.
 *
 * The rule is NETWORK-READ ONLY: it flags independent GET round trips (safe to
 * parallelize), never writes and never DB queries (parallelizing those is unsafe on
 * a single connection / inside a transaction — see the rule's own comment).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noSequentialIndependentAwaits } from "../../src/diagnostics/performance/no-sequential-independent-awaits.ts";
import type { Diagnostic } from "../../src/core/types.ts";

const CAPS = new Set(["node", "esm", "typescript"]);
const D = noSequentialIndependentAwaits;

/** Wrap a statement list in an async function so `await` parses at statement scope. */
const wrap = (body: string): string => `async function handler(id, other, x, y, opts) {\n${body}\n}`;

const findingsFor = (source: string): number => {
  const { findings, parseFailed } = lintSource({
    filePath: "test.ts",
    sourceText: source,
    diagnostics: [D],
    capabilities: CAPS,
  });
  assert.ok(!parseFailed, `source failed to parse:\n${source}`);
  return findings.filter((f) => f.diagnostic === D.id).length;
};

const fires = (body: string): void =>
  assert.ok(findingsFor(wrap(body)) > 0, `expected ${D.id} to FIRE on:\n${body}`);

const firesExactly = (body: string, n: number): void =>
  assert.equal(findingsFor(wrap(body)), n, `expected ${D.id} to fire ${n}× on:\n${body}`);

const silent = (body: string): void =>
  assert.equal(findingsFor(wrap(body)), 0, `expected ${D.id} to STAY SILENT on:\n${body}`);

// ---------------------------------------------------------------------------
// FIRES — independent network GET reads
// ---------------------------------------------------------------------------

describe("no-sequential-independent-awaits — fires", () => {
  test("two independent fetch calls (variable URLs)", () => {
    fires(`const a = await fetch(x); const b = await fetch(y);`);
  });

  test("two discarded (unbound) fetch awaits", () => {
    fires(`await fetch(x); await fetch(y);`);
  });

  test("two axios GETs, independent args", () => {
    fires(`const a = await axios.get(x); const b = await axios.get(y);`);
  });

  test("http.get + https.get", () => {
    fires(`const a = await http.get(opts); const b = await https.get(x);`);
  });

  test("bare got(url) + ky(url) with string URLs", () => {
    fires(`const a = await got("https://a"); const b = await ky("https://b");`);
  });

  test("fetch with an options object that carries no method (still a GET)", () => {
    fires(`const a = await fetch(x, { headers: h }); const b = await fetch(y, { headers: h });`);
  });

  test("a run of three independent GETs fires exactly once", () => {
    firesExactly(`const a = await fetch(x); const b = await fetch(y); const c = await fetch(opts);`, 1);
  });

  test("two independent leaders, trailing dependent statement still flags the pair", () => {
    // a and b are independent (fire on b); use(a) is the dependent trailer.
    fires(`const a = await fetch(x); const b = await fetch(y); use(a);`);
  });

  test("dependency chain restarts, then two independent awaits fire", () => {
    // b depends on a (no fire), but b and c are mutually independent → fire on c.
    fires(`const a = await fetch(x); const b = await fetch(a.url); const c = await fetch(y);`);
  });
});

// ---------------------------------------------------------------------------
// MUST BE SILENT
// ---------------------------------------------------------------------------

describe("no-sequential-independent-awaits — silent", () => {
  test("second fetch reads a property of the first (dependent)", () => {
    silent(`const a = await fetch(x); const b = await fetch(a.url);`);
  });

  // DB is entirely out of scope — parallelizing DB queries is unsafe on a single
  // connection / inside a transaction, and pooled-vs-single cannot be told apart.
  test("DB reads are NOT flagged (connection/transaction safety is undecidable)", () => {
    silent(`const u = await db.user.findUnique({ id }); const o = await db.order.findMany({});`);
    silent(`const a = await db.query("SELECT * FROM a"); const b = await db.query("SELECT * FROM b");`);
    silent(`const a = await client.query("SELECT 1"); const b = await client.query("SELECT 2");`);
    silent(`const a = await conn.query("SELECT 1"); const b = await conn.query("SELECT 2");`);
  });

  test("DB writes stay silent", () => {
    silent(`const a = await db.user.create({ data: x }); const b = await db.log.create({ data: y });`);
  });

  test("HTTP writes (POST) stay silent", () => {
    silent(`const a = await axios.post(u1, d1); const b = await axios.post(u2, d2);`);
    silent(`const a = await fetch(u1, { method: "POST" }); const b = await fetch(u2, { method: "POST" });`);
  });

  test("fetch with a VARIABLE options object stays silent (could be a POST)", () => {
    silent(`const a = await fetch(u1, opts); const b = await fetch(u2, opts);`);
  });

  test("fetch with a DYNAMIC method value stays silent (unprovable verb)", () => {
    silent(`const a = await fetch(u1, { method: m }); const b = await fetch(u2, { method: m });`);
  });

  test("bare axios(config) / got(config) with a variable first arg stays silent", () => {
    silent(`const a = await axios(cfg); const b = await axios(cfg2);`);
    silent(`const a = await got(cfg); const b = await got(cfg2);`);
  });

  test("axios(config-object) with a write method stays silent", () => {
    silent(`const a = await axios({ url: u1, method: "post" }); const b = await axios({ url: u2, method: "post" });`);
  });

  test("first await is a local computation, not a network read", () => {
    silent(`const a = await computeLocally(); const b = await fetch(x);`);
  });

  test("both awaits are local computations", () => {
    silent(`const a = await sleep(100); const b = await computeLocally();`);
  });

  test("intervening if-statement between the awaits", () => {
    silent(`const a = await fetch(x); if (a) doThing(); const b = await fetch(y);`);
  });

  test("intervening bare call statement between the awaits", () => {
    silent(`const a = await fetch(x); doSomething(a); const b = await fetch(y);`);
  });

  test("non-network await between the network awaits breaks the run", () => {
    silent(`const a = await fetch(x); const m = await computeLocally(); const b = await fetch(y);`);
  });

  test("already wrapped in Promise.all", () => {
    silent(`await Promise.all([fetch(x), fetch(y)]);`);
  });

  test("already wrapped in Promise.allSettled", () => {
    silent(`const r = await Promise.allSettled([fetch(x), fetch(y)]);`);
  });

  test("a lone network await", () => {
    silent(`const a = await fetch(x);`);
  });

  test("awaits in different blocks (separate if bodies)", () => {
    silent(`if (x) { const a = await fetch(id); } if (y) { const b = await fetch(other); }`);
  });

  test("awaits in different functions", () => {
    silent(
      `const inner = async () => { const a = await fetch(x); };\nconst other2 = async () => { const b = await fetch(y); };`,
    );
  });

  test("in-memory cache .get is not a network boundary", () => {
    silent(`const a = await cache.get(x); const b = await cache.get(y);`);
  });

  test("var-bound awaits are non-qualifying (const|let only)", () => {
    silent(`var a = await fetch(x); var b = await fetch(y);`);
  });

  test("destructuring bindings are non-qualifying", () => {
    silent(`const { data: a } = await axios.get(x); const { data: b } = await axios.get(y);`);
  });

  test("genuine three-step dependency chain stays silent", () => {
    silent(`const a = await fetch(x); const b = await fetch(a.next); const c = await fetch(b.next);`);
  });

  test("await of a non-call (awaiting a promise variable)", () => {
    silent(`const a = await p1; const b = await p2;`);
  });
});
