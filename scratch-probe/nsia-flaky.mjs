import { lintSource } from "../src/core/scan.ts";
import { noSequentialIndependentAwaits as D } from "../src/diagnostics/performance/no-sequential-independent-awaits.ts";

const caps = new Set(["node", "esm", "typescript", "express"]);
const n = (src) => lintSource({ filePath: "a.ts", sourceText: src, diagnostics: [D], capabilities: caps }).findings.length;

const srcConn = `
async function f(q1, q2) {
  const a = await conn.query(q1);
  const b = await conn.query(q2);
  return [a, b];
}`;

const srcModel = `
async function f(x, y) {
  const a = await model.count(x);
  const b = await model.aggregate(y);
  return [a, b];
}`;

const srcFetch = `
async function f(x, y) {
  const a = await fetch(x);
  const b = await fetch(y);
  return [a, b];
}`;

const tally = (label, src, iters = 200) => {
  let ones = 0;
  for (let i = 0; i < iters; i++) if (n(src) === 1) ones++;
  console.log(`${label}: fired ${ones}/${iters}`);
};

tally("conn.query(DB)", srcConn);
tally("model.count(DB)", srcModel);
tally("fetch(net)", srcFetch);
