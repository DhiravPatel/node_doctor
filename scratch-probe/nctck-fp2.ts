import { lintSource } from "../src/core/scan.ts";
import { noCrossTenantCacheKey } from "../src/diagnostics/security/no-cross-tenant-cache-key.ts";
const caps = new Set(["node", "esm", "typescript", "express"]);
const n = (src: string) => lintSource({ filePath: "a.ts", sourceText: src, diagnostics: [noCrossTenantCacheKey], capabilities: caps }).findings.length;
const cases: Array<[string, string]> = [
  // audit id nested deeper (meta.auditedBy) with shared data
  ["audit meta.auditedBy", "async function f(req){ await cache.set(`k:${status}`, { rows: shared, meta: { auditedBy: req.user.id } }); }"],
  // Zustand-ish: dataStore ends in 'store'? no -> only exact 'store' or *cache/*redis
  ["dataStore.set (camel)", "async function f(req){ dataStore.set(`k:${status}`, getFor(req.user.id)); }"],
  // userStore.set -> segment 'userstore' not matched
  ["userStore.set", "async function f(req){ userStore.set(`k:${status}`, getFor(req.user.id)); }"],
  // a redux slice literally `store`
  ["store zustand setState", "async function f(req){ store.setState({ userId: req.user.id }); }"],
  // legit cache but value id only in a logging/telemetry-ish field
  ["cache audit createdBy", "async function f(req){ await cache.set(`report:${period}`, { totals: agg, createdBy: req.user.id }); }"],
];
for (const [label, src] of cases) {
  let out: number | string;
  try { out = n(src); } catch (e) { out = "ERR:" + (e as Error).message; }
  console.log(`${out}\t${label}`);
}
