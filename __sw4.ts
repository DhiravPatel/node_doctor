import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { lintSource } from "./src/core/scan.ts";
import { noUncatchableSignalHandler } from "./src/diagnostics/reliability/no-uncatchable-signal-handler.ts";
import { noOutOfRangeExitCode } from "./src/diagnostics/bugs/no-out-of-range-exit-code.ts";
import { noStringLengthAsContentLength } from "./src/diagnostics/bugs/no-string-length-as-content-length.ts";
import { noChunkStringConcat } from "./src/diagnostics/bugs/no-chunk-string-concat.ts";
const fg = (await import("fast-glob")).default;
const R = [noUncatchableSignalHandler, noOutOfRangeExitCode, noStringLengthAsContentLength, noChunkStringConcat];
const tc = new Map<string,string>();
const nt = async (d: string): Promise<string> => { const seen: string[] = []; let c = d;
  for (let i=0;i<40;i++){ const h=tc.get(c); if(h){for(const x of seen)tc.set(x,h);return h;} seen.push(c);
    try{const m=JSON.parse(await readFile(join(c,"package.json"),"utf8"));const v=m.type==="module"?"module":"commonjs";for(const x of seen)tc.set(x,v);return v;}catch{}
    const u=dirname(c); if(u===c)break; c=u; }
  for(const x of seen)tc.set(x,"commonjs"); return "commonjs"; };
let scanned=0; const hits: string[]=[];
for (const root of process.argv.slice(2)) {
  let files: string[]=[];
  try { files = await fg(["**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}"],{cwd:root,absolute:true,onlyFiles:true,followSymbolicLinks:false,suppressErrors:true,ignore:["**/*.min.js","**/.git/**"]}); } catch { continue; }
  for (const f of files) { let src: string; try{src=await readFile(f,"utf8");}catch{continue;} if(src.length>300_000)continue;
    scanned++;
    const caps=new Set(["node",(await nt(dirname(f)))==="module"?"esm":"cjs","typescript"]);
    try{ for(const d of lintSource({filePath:f,sourceText:src,diagnostics:R as any,capabilities:caps}).findings) hits.push(`${d.diagnostic}  ${f.replace(/^.*node_modules\//,"…/")}:${d.line}`);}catch{} } }
console.log(`scanned ${scanned}, ${hits.length} finding(s)`);
const seen=new Set<string>(); for(const h of hits.sort()){ if(seen.has(h))continue; seen.add(h); console.log("  "+h); }
