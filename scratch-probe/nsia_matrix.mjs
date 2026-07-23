import { lintSource } from "../src/core/scan.ts";
import { noSequentialIndependentAwaits as D } from "../src/diagnostics/performance/no-sequential-independent-awaits.ts";
const caps = new Set(["node", "esm", "typescript", "express"]);
const n = (src) => lintSource({ filePath: "a.ts", sourceText: src, diagnostics: [D], capabilities: caps }).findings.length;
const fn = (body) => `async function h(){\n${body}\n}`;
const M = [
  ["find+find (db.user/db.order)", `const a = await db.user.findUnique({id}); const b = await db.order.findMany({});`],
  ["create+find", `const a = await db.user.create({}); const b = await db.order.findMany({});`],
  ["find+create", `const a = await db.user.findUnique({id}); const b = await db.order.create({});`],
  ["create+create", `const a = await db.user.create({}); const b = await db.order.create({});`],
  ["findMany+findMany", `const a = await db.user.findMany({}); const b = await db.order.findMany({});`],
  ["save+save", `const a = await db.user.save({}); const b = await db.order.save({});`],
  ["update+update", `const a = await db.user.update({}); const b = await db.order.update({});`],
  ["count+count", `const a = await db.user.count({}); const b = await db.order.count({});`],
  ["create+create no-arg-empty {data}", `const a = await db.user.create({data:1}); const b = await db.order.create({data:2});`],
  ["two-level db.create (no model seg)", `const a = await db.create({}); const b = await db.insert({});`],
];
for (const [label, body] of M) console.log(String(n(fn(body))).padEnd(4), label);
