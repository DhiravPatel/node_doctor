import { lintSource } from "../src/core/scan.ts";
import { noSequentialIndependentAwaits as D } from "../src/diagnostics/performance/no-sequential-independent-awaits.ts";
const caps=new Set(["node","esm","typescript"]);
const n=(s)=>lintSource({filePath:"a.ts",sourceText:s,diagnostics:[D],capabilities:caps}).findings.length;
for (const [l,s] of [
 ["TP: two fetch GETs", `async function f(){ const a = await fetch(x); const b = await fetch(y); }`],
 ["TP: axios.get x2", `async function f(){ const a = await axios.get(x); const b = await axios.get(y); }`],
 ["FP-fixed: fetch(u,opts) variable POST opts", `async function f(){ const opts={method:'POST'}; const a = await fetch(u1,opts); const b = await fetch(u2,opts); }`],
 ["FP-fixed: fetch method:m dynamic", `async function f(){ const a = await fetch(u1,{method:m}); const b = await fetch(u2,{method:m}); }`],
 ["FP-fixed: axios(cfg) variable", `async function f(){ const a = await axios(cfg); const b = await axios(cfg2); }`],
 ["SILENT: DB reads (now excluded)", `async function f(){ const a = await db.user.findUnique({id}); const b = await db.order.findMany({}); }`],
 ["SILENT: dependent fetch", `async function f(){ const a = await fetch(x); const b = await fetch(a.url); }`],
]) console.log(`[${n(s)}] ${l}`);
