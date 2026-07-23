import { lintSource } from "../src/core/scan.ts";
import { noSequentialIndependentAwaits as D } from "../src/diagnostics/performance/no-sequential-independent-awaits.ts";

const caps = new Set(["node", "esm", "typescript", "express"]);
const n = (src) =>
  lintSource({ filePath: "a.ts", sourceText: src, diagnostics: [D], capabilities: caps }).findings.length;
const fn = (body) => `async function h(){\n${body}\n}`;

const cases = [
  // ---- FP HUNT: mutation / side-effect ordering that fires but may not be safely parallelizable ----
  ["FP? two independent DB writes (create/create)", fn(`const a = await db.user.create({data:1}); const b = await db.log.create({data:2});`)],
  ["FP? two POSTs (side-effect ordering)", fn(`await axios.post(u1); await axios.post(u2);`)],
  ["FP? fetch POST then fetch POST", fn(`await fetch(u1,{method:'POST'}); await fetch(u2,{method:'POST'});`)],
  ["FP? write then independent write via db.save", fn(`await db.user.save(a); await db.order.save(b);`)],
  ["FP? deleteMany then deleteMany", fn(`await db.a.deleteMany({}); await db.b.deleteMany({});`)],

  // ---- FN HUNT: should fire but might be silent ----
  ["FN? mixed fetch + axios.get", fn(`const a = await fetch(x); const b = await axios.get(y);`)],
  ["FN? two axios.get", fn(`const a = await axios.get(x); const b = await axios.get(y);`)],
  ["FN? http.request twice", fn(`const a = await http.request(x); const b = await https.request(y);`)],
  ["FN? bare await discarded (no binding)", fn(`await fetch(x); await fetch(y);`)],
  ["FN? optional call await axios.get?.()", fn(`const a = await axios.get?.(x); const b = await axios.get?.(y);`)],
  ["FN? indep separated by dependent middle (a,b,c reads b)", fn(`const a=await fetch(x); const b=await fetch(y); const c=await fetch(b);`)],

  // ---- Precision checks ----
  ["PREC key not a use -> fires ({id:5} literal)", fn(`const id = await fetch(x); const o = await db.order.findMany({id: 5});`)],
  ["PREC shorthand value IS a use -> silent", fn(`const u = await fetch(x); const o = await db.order.findMany({u});`)],
  ["PREC computed member uses bound -> silent", fn(`const k = await fetch(x); const o = await db.order.findMany(map[k]);`)],
  ["PREC write-after-read -> silent", fn(`const u = await db.user.findUnique({id}); await db.user.save(u);`)],
  ["PREC three reads, third reads first -> fires once", fn(`const a=await fetch(x); const b=await fetch(y); const c=await fetch(a);`)],

  // ---- receiver false positive risk ----
  ["FP? em inside 'items' should NOT be db", fn(`const a = await items.findMany({}); const b = await items.findMany({});`)],
  ["FN? local async fn twice (not network) -> silent", fn(`const a = await loadA(); const b = await loadB();`)],
];

for (const [label, src] of cases) {
  let count;
  try {
    count = n(src);
  } catch (e) {
    count = "ERR:" + e.message;
  }
  console.log(String(count).padEnd(6), label);
}
