import { lintSource } from "../src/core/scan.ts";
import { noSequentialIndependentAwaits as D } from "../src/diagnostics/performance/no-sequential-independent-awaits.ts";
const caps = new Set(["node", "esm", "typescript", "express"]);
const n = (src) => lintSource({ filePath: "a.ts", sourceText: src, diagnostics: [D], capabilities: caps }).findings.length;
const fn = (body) => `async function h(){\n${body}\n}`;

const cases = [
  // ===== TASK: MUST FIRE (reads) =====
  ["MF db find+find", fn(`const u = await db.user.findUnique({id}); const o = await db.order.findMany({});`)],
  ["MF fetch+fetch", fn(`const a = await fetch(x); const b = await fetch(y);`)],
  ["MF 3 reads once", fn(`const a = await fetch(x); const b = await fetch(y); const c = await fetch(z);`)],

  // ===== TASK: MUST BE SILENT =====
  ["MS dependent u.id", fn(`const u = await db.user.findUnique({id}); const o = await db.order.findMany({userId: u.id});`)],
  ["MS first not network", fn(`const a = await computeLocally(); const b = await fetch(x);`)],
  ["MS intervening if", fn(`const a=await fetch(x); if(a.ok) log(); const b=await fetch(y);`)],
  ["MS Promise.all", fn(`await Promise.all([fetch(x),fetch(y)]);`)],

  // ===== TASK: FN candidates =====
  ["FN pure const c=1 separator", fn(`const a = await fetch(x); const c = 1; const b = await fetch(y);`)],
  ["FN .then not await", fn(`const a = fetch(x).then(r=>r.json()); const b = fetch(y).then(r=>r.json());`)],
  ["FN top-level module await", `const a = await fetch(x);\nconst b = await fetch(y);`],
  ["FN destructured binding", fn(`const {a} = await fetch(x); const {b} = await fetch(y);`)],

  // ===== NEW read/write split — reads should FIRE =====
  ["RD axios.get twice", fn(`const a = await axios.get(x); const b = await axios.get(y);`)],
  ["RD mixed fetch+axios.get", fn(`const a = await fetch(x); const b = await axios.get(y);`)],
  ["RD bare await discarded", fn(`await fetch(x); await fetch(y);`)],
  ["RD raw query SELECT literal", fn(`const a = await db.query("SELECT 1"); const b = await db.query("SELECT 2");`)],
  ["RD raw query select template", fn("const a = await db.query(`select * from a`); const b = await db.query(`select * from b`);")],
  ["RD count+aggregate", fn(`const a = await db.user.count({}); const b = await db.order.aggregate({});`)],

  // ===== NEW read/write split — writes should be SILENT (design) =====
  ["WR create+create silent", fn(`const a = await db.user.create({}); const b = await db.order.create({});`)],
  ["WR POST inline option silent", fn(`await fetch(u1,{method:'POST'}); await fetch(u2,{method:'POST'});`)],
  ["WR axios.post silent", fn(`await axios.post(u1); await axios.post(u2);`)],
  ["WR raw query DELETE literal silent", fn(`const a = await db.query("DELETE FROM a"); const b = await db.query("DELETE FROM b");`)],
  ["WR raw query dynamic sql silent", fn(`const a = await db.query(sql1); const b = await db.query(sql2);`)],
  ["WR ambiguous axios.request silent", fn(`const a = await axios.request(x); const b = await axios.request(y);`)],

  // ===== ADVERSARIAL FP HUNT against the read/write split =====
  ["FP var options obj (POST via opts) FIRES?", fn(`const opts={method:'POST'}; const a = await fetch(u1,opts); const b = await fetch(u2,opts);`)],
  ["FP dynamic method value (POST via var) FIRES?", fn(`const a = await fetch(u1,{method:m}); const b = await fetch(u2,{method:m});`)],
  ["FP axios(config) config var write FIRES?", fn(`const cfg={method:'post',url:u}; const a = await axios(cfg); const b = await axios(cfg2);`)],
  ["FP WITH-CTE data-modifying select-ish FIRES?", fn("const a = await db.query(`WITH d AS (DELETE FROM a RETURNING *) SELECT * FROM d`); const b = await db.query(`WITH e AS (DELETE FROM b RETURNING *) SELECT * FROM e`);")],
  ["FP method:'GET' explicit still read FIRES", fn(`const a = await fetch(u1,{method:'GET'}); const b = await fetch(u2,{method:'GET'});`)],

  // precision re-confirm
  ["PREC key not a use fires", fn(`const id = await fetch(x); const o = await db.order.findMany({id: 5});`)],
  ["PREC shorthand value use silent", fn(`const u = await fetch(x); const o = await db.order.findMany({u});`)],
];

for (const [label, src] of cases) {
  let c; try { c = n(src); } catch (e) { c = "ERR:" + e.message; }
  console.log(String(c).padEnd(5), label);
}
