/**
 * §138 — Health-check correctness & cascading-failure risk:
 *   - no-liveness-check-with-dependency (Reliability)
 *
 * This test imports the diagnostic module directly and lints with an explicit
 * diagnostic list, so it does not depend on the generated registry. The
 * MUST-be-silent cases are precision-regression guards: the whole rule is
 * opt-in and precision-first, so a false positive here is a release blocker.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noLivenessCheckWithDependency } from "../../src/diagnostics/reliability/no-liveness-check-with-dependency.ts";
import type { Diagnostic } from "../../src/core/types.ts";

const CAPS = new Set(["node", "esm", "typescript", "express"]);

const findingsFor = (diagnostic: Diagnostic, source: string): number => {
  const { findings, parseFailed } = lintSource({
    filePath: "test.ts",
    sourceText: source,
    diagnostics: [diagnostic],
    capabilities: CAPS,
  });
  assert.ok(!parseFailed, `source failed to parse:\n${source}`);
  return findings.filter((f) => f.diagnostic === diagnostic.id).length;
};

const fires = (diagnostic: Diagnostic, source: string): void =>
  assert.ok(findingsFor(diagnostic, source) > 0, `expected ${diagnostic.id} to FIRE on:\n${source}`);

const silent = (diagnostic: Diagnostic, source: string): void =>
  assert.equal(findingsFor(diagnostic, source), 0, `expected ${diagnostic.id} to STAY SILENT on:\n${source}`);

describe("no-liveness-check-with-dependency", () => {
  const L = noLivenessCheckWithDependency;

  // FIRES ------------------------------------------------------------------
  test("fires: /healthz runs a DB query", () => {
    fires(L, `app.get("/healthz", async (req, res) => { await db.query("SELECT 1"); res.sendStatus(200); });`);
  });
  test("fires: /healthcheck and /health_check (separator variants) run a DB query", () => {
    fires(L, `app.get("/healthcheck", async (req, res) => { await db.query("SELECT 1"); });`);
    fires(L, `app.get("/health_check", async (req, res) => { await db.query("SELECT 1"); });`);
  });
  test("fires: /health does an outbound fetch", () => {
    fires(L, `app.get("/health", async (req, res) => { await fetch("http://other/health"); res.json({ ok: true }); });`);
  });
  test("fires: /livez pings redis", () => {
    fires(L, `app.get("/livez", async (req, res) => { await redis.ping(); res.sendStatus(200); });`);
  });
  test("fires: /ping does an axios.get to a dependency", () => {
    fires(L, `app.get("/ping", async (req, res) => { await axios.get("http://svc/ok"); res.sendStatus(200); });`);
  });
  test("fires: /_health uses http.request", () => {
    fires(L, `app.get("/_health", (req, res) => { http.request("http://svc"); res.end(); });`);
  });
  test("fires: /health/live pings a networked redis (segment-aware)", () => {
    fires(L, `router.get("/health/live", async (req, res) => { await redisClient.ping(); res.sendStatus(200); });`);
  });
  test("silent: /healthz reads an in-memory cache (a local Map/LRU is not a network dependency)", () => {
    // A bare `cache` is not a networked store — reading it cannot cascade, so it is
    // NOT flagged (only redis/memcached and DB/network qualify).
    silent(L, `app.get("/healthz", async (req, res) => { const v = cache.get("version"); res.json({ v }); });`);
    silent(L, `app.get("/healthz", async (req, res) => { const v = await cacheClient.get("hb"); res.json({ v }); });`);
  });
  test("fires: prisma findMany on a liveness path", () => {
    fires(L, `app.get("/liveness", async (req, res) => { await prisma.user.findMany(); res.sendStatus(200); });`);
  });
  test("fires: named handler binding resolved from the registration", () => {
    fires(
      L,
      `const healthz = async (req, res) => { await db.query("SELECT 1"); res.sendStatus(200); };
       app.get("/healthz", healthz);`,
    );
  });
  test("fires: dependency call in a non-async handler (got)", () => {
    fires(L, `app.get("/status", (req, res) => { got("http://svc/ok").then(() => res.sendStatus(200)); });`);
  });

  // MUST BE SILENT ---------------------------------------------------------
  test("silent: /health-tips is a content route, not a liveness probe (segment ≠ health)", () => {
    silent(L, `app.get("/health-tips", async (req, res) => { await db.query("SELECT 1"); res.json([]); });`);
    silent(L, `app.get("/healthy-recipes", async (req, res) => { await db.query("SELECT 1"); });`);
  });
  test("silent: /readyz checks the DB — readiness SHOULD do this", () => {
    silent(L, `app.get("/readyz", async (req, res) => { await db.query("SELECT 1"); res.sendStatus(200); });`);
  });
  test("silent: /readiness checks the DB", () => {
    silent(L, `app.get("/readiness", async (req, res) => { await db.query("SELECT 1"); res.sendStatus(200); });`);
  });
  test("silent: /health/ready checks a dependency (readiness wins over health prefix)", () => {
    silent(L, `app.get("/health/ready", async (req, res) => { await redis.ping(); res.sendStatus(200); });`);
  });
  test("silent: shallow /healthz just returns 200 (correct liveness)", () => {
    silent(L, `app.get("/healthz", (req, res) => res.sendStatus(200));`);
  });
  test("silent: /healthz returns static json (no dependency)", () => {
    silent(L, `app.get("/healthz", (req, res) => res.json({ ok: true }));`);
  });
  test("silent: /health returns process metrics (self-contained, not a dependency)", () => {
    silent(L, `app.get("/health", (req, res) => res.json({ uptime: process.uptime(), mem: process.memoryUsage() }));`);
  });
  test("silent: /users route does a DB query (not a health path)", () => {
    silent(L, `app.get("/users", async (req, res) => { const u = await db.query("SELECT * FROM users"); res.json(u); });`);
  });
  test("silent: dependency call only inside a nested, uninvoked closure", () => {
    silent(
      L,
      `app.get("/healthz", (req, res) => { const check = async () => { await db.query("SELECT 1"); }; res.sendStatus(200); });`,
    );
  });
  test("silent: map.get(key) is not a route registration", () => {
    silent(L, `const v = statusMap.get("status");`);
  });
  test("silent: liveness handler calls a local cache with an in-memory Map (no redis/cache receiver hint)", () => {
    // `store.get` — `store` is not a db/redis/cache receiver and `get` is not a QUERY_METHOD.
    silent(L, `app.get("/healthz", (req, res) => { const v = store.get("k"); res.sendStatus(200); });`);
  });
  test("silent: POST to a health path (only GET registrations are liveness probes)", () => {
    silent(L, `app.post("/healthz", async (req, res) => { await db.query("SELECT 1"); res.sendStatus(200); });`);
  });
});
