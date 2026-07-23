import { lintSource } from "../src/core/scan.ts";
import { noCrossTenantCacheKey } from "../src/diagnostics/security/no-cross-tenant-cache-key.ts";

const caps = new Set(["node", "esm", "typescript", "express"]);
const n = (src: string) =>
  lintSource({
    filePath: "a.ts",
    sourceText: src,
    diagnostics: [noCrossTenantCacheKey],
    capabilities: caps,
  }).findings.length;

const cases: Array<[string, string]> = [
  // A: audit-field identity — id only in updatedBy of a shared value
  ["A audit-field", "async function f(req){ await cache.set(`k:${status}`, { data: shared, updatedBy: req.user.id }); }"],
  // A2: fully shared value (control) — should be silent
  ["A2 shared-control", "async function f(req){ await cache.set(`k:${status}`, { data: shared }); }"],

  // B: bare var value, no visible identity — silent (good), key has id
  ["B bare-profile", "async function f(req){ const profile = getP(); await cache.set(`user:${req.user.id}`, profile); }"],
  // B2: profile built one hop up from req.user.id — FN acceptable, key has id anyway
  ["B2 profile-onehop", "async function f(req){ const profile = { id: req.user.id }; await cache.set(`k:${status}`, profile); }"],

  // C: store receiver, non-cache (zustand/redux/session)
  ["C store-noncache", "async function f(req){ store.set(`k:${status}`, getFor(req.user.id)); }"],
  ["C2 store.set qualified", "async function f(req){ app.store.set(`k:${status}`, getFor(req.user.id)); }"],

  // D: express-session store — key is the session id, value has userId
  ["D sessionStore.set", "async function f(req, sid){ sessionStore.set(sid, { userId: req.user.id }); }"],
  // D2: session store named `store`, opaque key sid
  ["D2 store sid opaque", "async function f(req, sid){ store.set(sid, { userId: req.user.id }); }"],
  // D3: session store named `store`, concrete key = sid template (no id in key)
  ["D3 store concrete sid key", "async function f(req){ store.set(`sess:${sid}`, { userId: req.user.id }); }"],

  // E: bare `account` is a bank amount, member call arg — should NOT match
  ["E account-amount", "async function f(){ await cache.set(`fx:${pair}`, computeAccountValue(account)); }"],
  // E2: account as member of non-request root — should NOT match
  ["E2 row.accountId", "async function f(row){ await cache.set(`fx:${pair}`, computeValue(row.accountId)); }"],

  // F: orgId key, userid value — different tenancy dimension, SHOULD fire (not FP)
  ["F orgId-key userid-val", "async function f(req){ await cache.set(`k:${orgId}`, getOrders(req.user.id)); }"],

  // Extra: bare `store` end-to-end where it truly is a cache alias (intended fire)
  ["G store real-cache", "async function f(req){ store.set(`orders:${status}`, getOrders(req.user.id)); }"],
];

for (const [label, src] of cases) {
  let out: number | string;
  try {
    out = n(src);
  } catch (e) {
    out = "ERR:" + (e as Error).message;
  }
  console.log(`${out}\t${label}`);
}
