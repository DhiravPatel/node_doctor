import { lintSource } from "../src/core/scan.ts";
import { noSequentialIndependentAwaits as D } from "../src/diagnostics/performance/no-sequential-independent-awaits.ts";
const caps=new Set(["node","esm","typescript"]);
const n=(s)=>lintSource({filePath:"a.ts",sourceText:s,diagnostics:[D],capabilities:caps}).findings.length;
for (const [l,s] of [
 ["TP: two independent READS", `async function f(id){ const u = await db.user.findUnique({id}); const o = await db.order.findMany({}); return [u,o]; }`],
 ["RISK: two independent WRITES (create)", `async function f(){ const a = await db.user.create({data:{}}); const b = await db.log.create({data:{}}); return [a,b]; }`],
 ["RISK: two updates", `async function f(){ const a = await db.user.update({}); const b = await db.stats.update({}); }`],
 ["RISK: same-tx serial queries", `async function f(tx){ const a = await tx.query("SELECT 1"); const b = await tx.query("SELECT 2"); }`],
 ["RISK: two fetch POSTs", `async function f(){ const a = await axios.post(u1,d1); const b = await axios.post(u2,d2); }`],
 ["SILENT: dependent", `async function f(id){ const u = await db.user.findUnique({id}); const o = await db.order.findMany({userId:u.id}); }`],
]) console.log(`[${n(s)}] ${l}`);
