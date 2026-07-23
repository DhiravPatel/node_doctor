import { lintSource } from "../src/core/scan.ts";
import { noSequentialIndependentAwaits as D } from "../src/diagnostics/performance/no-sequential-independent-awaits.ts";

const caps = new Set(["node", "esm", "typescript", "express"]);
const run = (src) => lintSource({ filePath: "a.ts", sourceText: src, diagnostics: [D], capabilities: caps });
const rep = (label, src) => {
  const r = run(src);
  console.log(`${r.findings.length}\tparseFailed=${r.parseFailed}\t${label}`);
  if (r.errors && r.errors.length) console.log("   errors:", r.errors);
};

// EXACT first-probe multi-line form
rep("MULTILINE conn.query", `
async function f(q1, q2) {
  const a = await conn.query(q1);
  const b = await conn.query(q2);
  return [a, b];
}`);

// single-line form
rep("SINGLELINE conn.query", `async function f(x,y){ const a = await conn.query(x); const b = await conn.query(y); return [a,b]; }`);

// single-line WITHOUT return
rep("SINGLELINE no-return conn.query", `async function f(x,y){ const a = await conn.query(x); const b = await conn.query(y); }`);

// multiline WITHOUT return
rep("MULTILINE no-return conn.query", `
async function f(x, y) {
  const a = await conn.query(x);
  const b = await conn.query(y);
}`);

// singleline WITH return, different arg names q1/q2
rep("SINGLELINE q1q2 conn.query", `async function f(q1,q2){ const a = await conn.query(q1); const b = await conn.query(q2); return [a,b]; }`);
