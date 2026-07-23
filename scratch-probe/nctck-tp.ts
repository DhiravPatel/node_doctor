import { lintSource } from "../src/core/scan.ts";
import { noCrossTenantCacheKey } from "../src/diagnostics/security/no-cross-tenant-cache-key.ts";

const caps = new Set(["node", "esm", "typescript", "express"]);
const n = (src: string) =>
  lintSource({ filePath: "a.ts", sourceText: src, diagnostics: [noCrossTenantCacheKey], capabilities: caps })
    .findings.length;

// A1: template key varies by status, value from req.user.id -> should FIRE
console.log("A1", n("async function h(req){ cache.set(`orders:${status}`, await getOrders(req.user.id)); }"));

// A2: literal key, value from req.tenantId -> should FIRE
console.log("A2", n('function h(req){ redis.set("profile", buildProfile(req.tenantId)); }'));

// A3: bare userId in value -> should FIRE
console.log("A3", n("function h(){ cache.set(`k:${status}`, getFor(userId)); }"));

// A4: setex value in arg2 -> should FIRE
console.log("A4", n("async function h(req){ cache.setex(`k:${status}`, 60, await getOrders(req.user.id)); }"));

// A5: resolvable key var -> should FIRE
console.log("A5", n("function h(req){ const k = `x:${status}`; cache.set(k, f(req.user.id)); }"));

// --- FN / control probes ---

// A6 (safe control): key already carries the id -> should be SILENT
console.log("A6-safe", n("async function h(req){ cache.set(`orders:${req.user.id}:${status}`, await getOrders(req.user.id)); }"));

// A7 (safe control): no identity in value -> should be SILENT
console.log("A7-safe", n("function h(env){ cache.set(`config:${env}`, loadConfig()); }"));

// A8 (FN probe): opaque key variable (unresolvable) -> intentionally SILENT
console.log("A8-opaque", n("function h(req){ cache.set(cacheKey, f(req.user.id)); }"));

// A9 (FN probe): value identity only in nested closure -> intentionally SILENT
console.log("A9-nested", n("function h(req){ cache.set(`k:${status}`, memoize(() => getOrders(req.user.id))); }"));

// A10 (FN probe): key built by call makeKey(...) -> opaque key, SILENT
console.log("A10-makekey", n("function h(req){ cache.set(makeKey(status), f(req.user.id)); }"));

// A11 (FN probe): plain redis.set with bare userId only in value, literal key
console.log("A11", n('function h(){ redis.set("orders", getFor(userId)); }'));

// A12 (FN probe): value identity via req.session.user
console.log("A12", n("function h(req){ cache.set(`k:${status}`, load(req.session.user.id)); }"));

// A13 (FN probe): cross-file helper hides identity -> SILENT (no taint through opaque helper without arg)
console.log("A13-crossfile", n("function h(){ cache.set(`k:${status}`, getForCurrentUser()); }"));
