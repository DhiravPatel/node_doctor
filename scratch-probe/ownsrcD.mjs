import { readFileSync } from "node:fs"; import { execSync } from "node:child_process";
import { lintSource } from "../src/core/scan.ts";
import { noCrossTenantCacheKey as A } from "../src/diagnostics/security/no-cross-tenant-cache-key.ts";
import { noDroppedAbortSignal as B } from "../src/diagnostics/reliability/no-dropped-abort-signal.ts";
import { noLivenessCheckWithDependency as C } from "../src/diagnostics/reliability/no-liveness-check-with-dependency.ts";
const caps=new Set(["node","esm","typescript","commonjs","express"]);
const files=execSync("find src -name '*.ts'",{encoding:"utf8"}).split("\n").filter(Boolean);
const by={}; const hits=[];
for(const f of files){const src=readFileSync(f,"utf8"); const r=lintSource({filePath:f,sourceText:src,diagnostics:[A,B,C],capabilities:caps});
 for(const x of r.findings){by[x.diagnostic]=(by[x.diagnostic]||0)+1; hits.push(`[${x.diagnostic}] ${f}:${x.line}`);}}
console.log("findings on our src:", JSON.stringify(by)); for(const h of hits.slice(0,15)) console.log("  "+h);
