import { lintSource } from "../src/core/scan.ts";
import { noCrossTenantCacheKey as D } from "../src/diagnostics/security/no-cross-tenant-cache-key.ts";
const caps=new Set(["node","esm","typescript","express"]);
const n=(s)=>lintSource({filePath:"a.ts",sourceText:`async function h(req,res){\n${s}\n}`,diagnostics:[D],capabilities:caps}).findings.length;
for (const [l,s] of [
 ["TP: inline key omits id, value has id", "cache.set(`orders:${status}`, await getOrders(req.user.id));"],
 ["FP-fixed: OPAQUE param key", "cache.set(cacheKey, await getOrders(req.user.id));"],
 ["TP: resolvable key omits id", "const k = `orders:${status}`; cache.set(k, await getOrders(req.user.id));"],
 ["SILENT: resolvable key HAS id", "const k = `orders:${req.user.id}`; cache.set(k, await getOrders(req.user.id));"],
 ["SILENT: inline key has id", "cache.set(`orders:${req.user.id}:${status}`, await getOrders(req.user.id));"],
 ["SILENT: value has no identity", "cache.set(`config:${env}`, loadConfig());"],
 ["SILENT: Map.set", "myMap.set(status, req.user.id);"],
 ["SILENT: cache.get", "const x = await cache.get(`orders:${status}`);"],
 ["TP: key-building call lacks id", "cache.set(makeKey(status), await getOrders(req.user.id));"],
 ["SILENT: key-building call has id", "cache.set(makeKey(req.user.id, status), await getOrders(req.user.id));"],
]) console.log(`[${n(s)}] ${l}`);
