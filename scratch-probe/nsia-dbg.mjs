import { lintSource } from "../src/core/scan.ts";
import { noSequentialIndependentAwaits as D } from "../src/diagnostics/performance/no-sequential-independent-awaits.ts";
import { DB_RECEIVER_HINTS, QUERY_METHODS } from "../src/core/signals.ts";

const caps = new Set(["node", "esm", "typescript", "express"]);
const n = (src) =>
  lintSource({ filePath: "a.ts", sourceText: src, diagnostics: [D], capabilities: caps }).findings.length;

// re-implement isDbReceiver to see what it thinks
const isDbReceiver = (receiver) => {
  const segments = receiver.split(".").map((s) => s.toLowerCase());
  for (const seg of segments) {
    for (const hint of DB_RECEIVER_HINTS) {
      if (hint.length < 4) { if (seg === hint) return true; }
      else if (seg.includes(hint)) return true;
    }
  }
  return false;
};

for (const r of ["pool","conn","connection","client","queryRunner","db.tx","em","session","model","collection","apiClient"]) {
  console.log(`isDbReceiver(${JSON.stringify(r)}) = ${isDbReceiver(r)}`);
}
console.log("query in QUERY_METHODS:", QUERY_METHODS.has("query"));
console.log("save  in QUERY_METHODS:", QUERY_METHODS.has("save"));

const mk = (rcv, meth) => `async function f(x,y){ const a = await ${rcv}.${meth}(x); const b = await ${rcv}.${meth}(y); return [a,b]; }`;
for (const [rcv,meth] of [["pool","query"],["conn","query"],["connection","query"],["client","query"],["queryRunner","query"],["session","save"],["em","save"]]) {
  console.log(`FIRE ${rcv}.${meth} =`, n(mk(rcv,meth)));
}
