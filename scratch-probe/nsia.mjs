import { lintSource } from "../src/core/scan.ts";
import { noSequentialIndependentAwaits as D } from "../src/diagnostics/performance/no-sequential-independent-awaits.ts";

const caps = new Set(["node", "esm", "typescript", "express"]);
const n = (src) =>
  lintSource({ filePath: "a.ts", sourceText: src, diagnostics: [D], capabilities: caps }).findings.length;

// Helper to wrap statements in an async function (so awaits are inside a BlockStatement).
const fn = (body) => `async function h(){\n${body}\n}`;

const cases = [
  // ---- MUST FIRE ----
  ["FIRE db two reads", fn(`const u = await db.user.findUnique({id}); const o = await db.order.findMany({});`)],
  ["FIRE fetch two", fn(`const a = await fetch(x); const b = await fetch(y);`)],
  ["FIRE 3 independent reads (once)", fn(`const a = await fetch(x); const b = await fetch(y); const c = await fetch(z);`)],

  // ---- MUST BE SILENT ----
  ["SILENT dependent (o reads u.id)", fn(`const u = await db.user.findUnique({id}); const o = await db.order.findMany({userId: u.id});`)],
  ["SILENT first not network (computeLocally)", fn(`const a = await computeLocally(); const b = await fetch(x);`)],
  ["SILENT intervening if", fn(`const a=await fetch(x); if(a.ok) log(); const b=await fetch(y);`)],
  ["SILENT Promise.all", fn(`await Promise.all([fetch(x),fetch(y)]);`)],

  // ---- FN candidates ----
  ["FN? separated by pure const c=1", fn(`const a = await fetch(x); const c = 1; const b = await fetch(y);`)],
  ["FN? .then instead of await", fn(`const a = fetch(x).then(r=>r.json()); const b = fetch(y).then(r=>r.json());`)],
  ["FN? top-level module await", `const a = await fetch(x);\nconst b = await fetch(y);`],
  ["FN? destructured binding", fn(`const {a} = await fetch(x); const {b} = await fetch(y);`)],
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
