import { lintSource } from "../src/core/scan.ts";
import { noSequentialIndependentAwaits as D } from "../src/diagnostics/performance/no-sequential-independent-awaits.ts";

const caps = new Set(["node", "esm", "typescript", "express"]);
const n = (src) => lintSource({ filePath: "a.ts", sourceText: src, diagnostics: [D], capabilities: caps }).findings.length;

const cases = {
  // ---- Sanity: intended TPs (safe reads) ----
  "TP reads: db.user.findUnique + db.order.findMany": `async function f(id,o){ const a = await db.user.findUnique({where:{id}}); const b = await db.order.findMany({where:{o}}); return [a,b]; }`,
  "TP reads: fetch(x) + fetch(y) (GET)": `async function f(x,y){ const a = await fetch(x); const b = await fetch(y); return [a,b]; }`,

  // ---- Confirm writes now SILENT (were the original FP) ----
  "WRITE create/create": `async function f(){ const a = await db.user.create({data:{}}); const b = await db.log.create({data:{}}); return [a,b]; }`,
  "WRITE update/insert": `async function f(){ const a = await db.account.update({}); const b = await db.ledger.insert({}); return [a,b]; }`,
  "WRITE save/save repo": `async function f(u,v){ const a = await userRepo.save(u); const b = await auditRepo.save(v); return [a,b]; }`,
  "WRITE deleteMany/deleteMany": `async function f(){ const a = await db.parent.deleteMany({}); const b = await db.child.deleteMany({}); return [a,b]; }`,
  "WRITE fetch POST option": `async function f(x,y){ const a = await fetch(x,{method:"POST"}); const b = await fetch(y,{method:"POST"}); return [a,b]; }`,
  "WRITE axios.post/post": `async function f(x,y){ const a = await axios.post(x); const b = await axios.post(y); return [a,b]; }`,

  // ---- REMAINING FP hunt: single-connection READS (cannot parallelize on one conn) ----
  "FP? client.query SELECT x2 (single pg Client)": `async function f(){ const a = await client.query("SELECT 1"); const b = await client.query("SELECT 2"); return [a,b]; }`,
  "FP? conn.query SELECT x2 (single connection)": `async function f(){ const a = await conn.query("SELECT a"); const b = await conn.query("SELECT b"); return [a,b]; }`,
  "FP? connection.query SELECT x2": `async function f(){ const a = await connection.query("SELECT a"); const b = await connection.query("SELECT b"); return [a,b]; }`,
  "pool.query SELECT x2 (pool = SAFE, correct fire)": `async function f(){ const a = await pool.query("SELECT a"); const b = await pool.query("SELECT b"); return [a,b]; }`,
  "FP? db.query SELECT x2 (db could be single conn)": `async function f(){ const a = await db.query("SELECT a"); const b = await db.query("SELECT b"); return [a,b]; }`,
  "FP? client.query template SELECT x2": `async function f(){ const a = await client.query(\`SELECT 1\`); const b = await client.query(\`SELECT 2\`); return [a,b]; }`,

  // ---- REMAINING FP: transactional EntityManager reads ----
  "FP? em.findOne x2 (transactional EntityManager, single conn)": `async function f(){ const a = await em.findOne(1); const b = await em.findOne(2); return [a,b]; }`,
  "queryRunner.query SELECT x2 (latent: hint casing => silent?)": `async function f(){ const a = await queryRunner.query("SELECT a"); const b = await queryRunner.query("SELECT b"); return [a,b]; }`,

  // ---- REMAINING FP: local helpers named request/got (naming collision) ----
  "FP? request(cfg) x2 (local queue helper, not http)": `async function f(cfg,cfg2){ const a = await request(cfg); const b = await request(cfg2); return [a,b]; }`,
  "FP? got(x) x2 (local getter, not the http lib)": `async function f(x,y){ const a = await got(x); const b = await got(y); return [a,b]; }`,

  // ---- REMAINING FP: throttled/rate-limited reads ----
  "FP? axios.get x2 (rate-limited API, throttle intended)": `async function f(x,y){ const a = await axios.get(x); const b = await axios.get(y); return [a,b]; }`,
  "FP? fetch x2 (rate-limited, throttle intended)": `async function f(x,y){ const a = await fetch(x); const b = await fetch(y); return [a,b]; }`,

  // ---- cache read (in-memory) stays silent (correct) ----
  "cache.get x2 (in-memory, correctly silent)": `async function f(k1,k2){ const a = await cache.get(k1); const b = await cache.get(k2); return [a,b]; }`,

  // ---- raw query non-SELECT literal stays silent (write) ----
  "raw query INSERT literal (write => silent)": `async function f(){ const a = await client.query("INSERT INTO t VALUES(1)"); const b = await client.query("INSERT INTO t VALUES(2)"); return [a,b]; }`,
  "raw query dynamic sql (unknown => silent)": `async function f(q1,q2){ const a = await client.query(q1); const b = await client.query(q2); return [a,b]; }`,
};

for (const [label, src] of Object.entries(cases)) {
  let out;
  try { out = n(src); } catch (e) { out = "ERR:" + e.message; }
  console.log(`${out}\t${label}`);
}
