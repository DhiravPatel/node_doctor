import { lintSource } from "../src/core/scan.ts";
import { noSequentialIndependentAwaits as D } from "../src/diagnostics/performance/no-sequential-independent-awaits.ts";
const caps = new Set(["node", "esm", "typescript", "express"]);
const n = (src) => lintSource({ filePath: "a.ts", sourceText: src, diagnostics: [D], capabilities: caps }).findings.length;
const fn = (body) => `async function h(){\n${body}\n}`;
const cases = [
  ["PREC member-access dep a.url -> silent", fn(`const a = await fetch(x); const b = await fetch(a.url);`)],
  ["PREC let reassign second -> silent(sep)", fn(`let a = await fetch(x); a = await fetch(y);`)],
  ["FN? separated by side-effect-free expr stmt", fn(`const a = await fetch(x); x++; const b = await fetch(y);`)],
  ["FIRE 4 reads -> once", fn(`const a=await fetch(x);const b=await fetch(y);const c=await fetch(z);const d=await fetch(w);`)],
  ["FP? create parent then child (FK order)", fn(`const p = await db.parent.create({}); const c = await db.child.create({name:'x'});`)],
];
for (const [label, src] of cases) {
  let count; try { count = n(src); } catch (e) { count = "ERR:" + e.message; }
  console.log(String(count).padEnd(6), label);
}
