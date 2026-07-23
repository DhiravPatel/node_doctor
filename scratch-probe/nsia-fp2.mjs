import { lintSource } from "../src/core/scan.ts";
import { noSequentialIndependentAwaits as D } from "../src/diagnostics/performance/no-sequential-independent-awaits.ts";

const caps = new Set(["node", "esm", "typescript", "express"]);
const n = (src) =>
  lintSource({ filePath: "a.ts", sourceText: src, diagnostics: [D], capabilities: caps }).findings.length;

const cases = {
  "pool.query x2 (pool IS safe to parallelize)": `
async function f(q1,q2){ const a = await pool.query(q1); const b = await pool.query(q2); return [a,b]; }`,
  "connection.query x2 (single connection)": `
async function f(q1,q2){ const a = await connection.query(q1); const b = await connection.query(q2); return [a,b]; }`,
  "queryRunner.query x2 (typeorm single QueryRunner tx)": `
async function f(q1,q2){ const a = await queryRunner.query(q1); const b = await queryRunner.query(q2); return [a,b]; }`,
  "session.save x2 (mongoose session tx-ish)": `
async function f(){ const a = await session.save({}); const b = await session.save({}); return [a,b]; }`,
  "em.persist? em.save x2 (typeorm EntityManager, one uow)": `
async function f(){ const a = await em.save({id:1}); const b = await em.save({id:2}); return [a,b]; }`,
};

for (const [label, src] of Object.entries(cases)) {
  let out;
  try { out = n(src); } catch (e) { out = "ERR:" + e.message; }
  console.log(`${out}\t${label}`);
}
