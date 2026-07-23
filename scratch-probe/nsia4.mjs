import { lintSource } from "../src/core/scan.ts";
import { noSequentialIndependentAwaits as D } from "../src/diagnostics/performance/no-sequential-independent-awaits.ts";
const caps = new Set(["node", "esm", "typescript", "express"]);
const dump = (src) => {
  const r = lintSource({ filePath: "a.ts", sourceText: src, diagnostics: [D], capabilities: caps });
  return r.findings.length + " " + JSON.stringify(r.findings.map(f=>f.message));
};
const fn = (body) => `async function h(){\n${body}\n}`;
const T = [
  ["user/log create", fn(`const a = await db.user.create({data:1}); const b = await db.log.create({data:2});`)],
  ["parent/child create empty+name", fn(`const p = await db.parent.create({}); const c = await db.child.create({name:'x'});`)],
  ["parent/child create both empty", fn(`const p = await db.parent.create({}); const c = await db.child.create({});`)],
  ["parent/child create data args", fn(`const p = await db.parent.create({data:1}); const c = await db.child.create({data:2});`)],
  ["p/c bindings user/log", fn(`const p = await db.user.create({}); const c = await db.log.create({});`)],
  ["a/b parent/child name arg", fn(`const a = await db.parent.create({}); const b = await db.child.create({name:'x'});`)],
];
for (const [label, src] of T) console.log(dump(src).padEnd(120), "|", label);
