/**
 * §140 cache-key correctness & cross-tenant poisoning:
 *   - no-cross-tenant-cache-key (Security)
 *
 * This test imports the diagnostic module directly and lints with an explicit
 * diagnostic list, so it does not depend on the generated registry. The rule is
 * opt-in and precision-first: a false positive is a cross-tenant *non*-bug that
 * would block a release, so the SILENT block is intentionally the larger one.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noCrossTenantCacheKey } from "../../src/diagnostics/security/no-cross-tenant-cache-key.ts";
import type { Diagnostic } from "../../src/core/types.ts";

const CAPS = new Set(["node", "esm", "typescript", "express"]);

const findingsFor = (diagnostic: Diagnostic, source: string) => {
  const { findings, parseFailed } = lintSource({
    filePath: "test.ts",
    sourceText: source,
    diagnostics: [diagnostic],
    capabilities: CAPS,
  });
  assert.ok(!parseFailed, `source failed to parse:\n${source}`);
  return findings.filter((f) => f.diagnostic === diagnostic.id);
};

const fires = (diagnostic: Diagnostic, source: string): void =>
  assert.ok(findingsFor(diagnostic, source).length > 0, `expected ${diagnostic.id} to FIRE on:\n${source}`);

const silent = (diagnostic: Diagnostic, source: string): void =>
  assert.equal(findingsFor(diagnostic, source).length, 0, `expected ${diagnostic.id} to STAY SILENT on:\n${source}`);

describe("no-cross-tenant-cache-key", () => {
  const D = noCrossTenantCacheKey;

  // FIRES ------------------------------------------------------------------
  test("fires: template key omits the user id the awaited value depends on", () => {
    fires(D, 'const h = async (req) => { cache.set(`orders:${status}`, await getOrders(req.user.id)); };');
  });
  test("fires: redis literal key, value derived from req.tenantId", () => {
    fires(D, 'redis.set("profile", buildProfile(req.tenantId));');
  });
  test("fires: a resolvable key that omits the id, value depends on req.user.id", () => {
    fires(D, 'const k = `orders:${status}`; cache.set(k, getOrders(req.user.id));');
  });
  test("fires: bare `userId` identifier flows into the value", () => {
    fires(D, 'cache.set(`orders:${status}`, getOrders(userId));');
  });
  test("fires: setex — value is the third argument", () => {
    fires(D, 'cache.setex(`orders:${status}`, 60, getOrders(req.user.id));');
  });
  test("fires: put write API", () => {
    fires(D, 'cache.put(`orders:${status}`, getOrders(req.user.id));');
  });
  test("fires: cross-token — key has the tenant id but value depends on the user id", () => {
    fires(D, 'cache.set(`t:${req.tenantId}:${status}`, getOrders(req.user.id));');
  });
  test("fires: the id is a real DATA dependency even when an audit stamp is also present", () => {
    // audit exclusion must not over-suppress: the id is in a data position too.
    fires(D, 'cache.set(`k:${status}`, { orders: getOrders(req.user.id), createdBy: req.user.id });');
  });
  test("fires: receiver ends in `cache` (usersCache)", () => {
    fires(D, 'usersCache.set(`k:${status}`, load(req.user.id));');
  });
  test("fires: redisClient receiver, tenant identity", () => {
    fires(D, 'redisClient.set(`k:${status}`, load(req.tenantId));');
  });
  test("fires: ctx.state.user identity in the value", () => {
    fires(D, 'cache.set(`k:${status}`, serialize(ctx.state.user));');
  });
  test("fires: value is a direct req.user member (no wrapping call)", () => {
    fires(D, 'cache.set(`k:${status}`, req.user);');
  });
  test("fires: this.cache receiver inside a method", () => {
    fires(D, 'class C { save(req){ this.cache.set(`k:${status}`, getOrders(req.user.id)); } }');
  });

  // MUST BE SILENT ---------------------------------------------------------
  test("silent: key already includes the user id", () => {
    silent(D, 'cache.set(`orders:${req.user.id}:${status}`, getOrders(req.user.id));');
  });
  test("silent: OPAQUE key (a bare variable/param we cannot read) — could carry the id upstream", () => {
    silent(D, 'cache.set(cacheKey, getOrders(req.user.id));');
    silent(D, 'const k = buildKey(); cache.set(k, getOrders(req.user.id));');
  });
  test("silent: a resolvable key that already carries the id", () => {
    silent(D, 'const k = `orders:${req.user.id}`; cache.set(k, getOrders(req.user.id));');
  });
  test("silent: a key-building call that receives the id (`makeKey(req.user.id, …)`)", () => {
    silent(D, 'cache.set(makeKey(req.user.id, status), getOrders(req.user.id));');
  });
  test("silent: value has no identity reference (global/shared entry)", () => {
    silent(D, 'cache.set(`config:${env}`, loadConfig());');
  });
  test("silent: id appears only in an AUDIT field (createdBy/updatedBy/auditedBy) of a shared value", () => {
    silent(D, 'cache.set(`report:${period}`, { totals: agg, createdBy: req.user.id });');
    silent(D, 'cache.set(`report:${period}`, { data, meta: { auditedBy: req.user.id } });');
  });
  test("silent: `store` is not a cache receiver (too generic — Redux/session/data stores)", () => {
    silent(D, 'store.set(`k:${status}`, getFor(req.user.id));');
  });
  test("silent: a per-session key (`sess:${sid}`) already scopes the entry per user", () => {
    silent(D, 'cache.set(`sess:${sid}`, { userId: req.user.id });');
    silent(D, 'cache.set(`s:${sessionId}`, buildProfile(req.user.id));');
  });
  test("silent: Map.set is not a cache", () => {
    silent(D, 'map.set(k, req.user.id);');
  });
  test("silent: cache READ is never flagged", () => {
    silent(D, 'const v = cache.get(`orders:${status}`);');
  });
  test("silent: identity only inside a nested function of the value (memoize)", () => {
    silent(D, 'cache.set(`k:${status}`, memoize(() => getOrders(req.user.id)));');
  });
  test("silent: identity only inside an inline .map callback (pruned)", () => {
    silent(D, 'cache.set(`k:${status}`, items.map((i) => tag(i, req.user.id)));');
  });
  test("silent: headers.set is not a cache", () => {
    silent(D, 'res.headers.set("x-user", req.user.id);');
  });
  test("silent: formData.set is not a cache", () => {
    silent(D, 'formData.set("user", req.user.id);');
  });
  test("silent: tenant id present on both sides", () => {
    silent(D, 'redis.set(`profile:${req.tenantId}`, buildProfile(req.tenantId));');
  });
  test("silent: setex with the user id in the key", () => {
    silent(D, 'cache.setex(`u:${req.user.id}`, 60, load(req.user.id));');
  });
  test("silent: store receiver but a genuinely shared value", () => {
    silent(D, 'store.set(`totals`, computeTotals());');
  });
  test("silent: member property `userId` on a non-request root is not counted", () => {
    silent(D, 'cache.set(`k:${status}`, serialize(row.userId));');
  });
  test("silent: bare identifier that is not an identity (productId)", () => {
    silent(D, 'cache.set(`k:${status}`, getOrders(productId));');
  });
  test("silent: same user id in key and value via different member forms", () => {
    silent(D, 'cache.set(`u:${req.userId}`, load(req.user.id));');
  });
  test("silent: sessionStore receiver is not a recognised cache client", () => {
    silent(D, 'sessionStore.set(`k:${status}`, load(req.user.id));');
  });
  test("silent: literal-only key and literal-only value", () => {
    silent(D, 'cache.set("settings", DEFAULTS);');
  });

  // MESSAGE ----------------------------------------------------------------
  test("message names the missing identity token and the leaking source", () => {
    const [f] = findingsFor(D, 'cache.set(`orders:${status}`, getOrders(req.user.id));');
    assert.ok(f, "expected a finding");
    assert.match(f.message, /user's identity/);
    assert.match(f.message, /req\.user\.id/);
    assert.match(f.message, /orders:\$\{status\}/);
    assert.match(f.message, /Add the user id to the cache key/);
  });
});
