import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { lintSource } from "../src/core/scan.ts";
import { noUnanchoredSecurityRegex } from "../src/diagnostics/security/no-unanchored-security-regex.ts";
import { noStatefulGlobalRegexTest } from "../src/diagnostics/security/no-stateful-global-regex-test.ts";
import { noThrowLiteral } from "../src/diagnostics/bugs/no-throw-literal.ts";
import { noBigintPrecisionLoss } from "../src/diagnostics/bugs/no-bigint-precision-loss.ts";
import { noNondeterministicStableKey } from "../src/diagnostics/security/no-nondeterministic-stable-key.ts";
const RULES = [noUnanchoredSecurityRegex, noStatefulGlobalRegexTest, noThrowLiteral, noBigintPrecisionLoss, noNondeterministicStableKey];
const caps = new Set(["node","esm","typescript","commonjs","express"]);
const out = execSync(`find /Users/dhiravpatel/Documents/Project2 -type f \\( -name '*.js' -o -name '*.mjs' -o -name '*.ts' \\) -not -path '*/node_doctor/*' 2>/dev/null | head -30000`, {encoding:"utf8", maxBuffer: 1<<29});
let files = [...new Set(out.split("\n").filter(Boolean))];
const byRule = {}; let scanned=0, errs=0; const hits=[];
for (const f of files) {
  let src; try { src = readFileSync(f, "utf8"); } catch { continue; }
  if (src.length > 400_000) continue;
  scanned++;
  let res; try { res = lintSource({ filePath: f, sourceText: src, diagnostics: RULES, capabilities: caps }); } catch { errs++; continue; }
  for (const x of res.findings) { byRule[x.diagnostic]=(byRule[x.diagnostic]||0)+1; if(hits.length<80) hits.push(`[${x.diagnostic}] ${f}:${x.line}`); }
}
console.log(`scanned ${scanned} files (${errs} parse-skips)`);
console.log("findings by rule:", JSON.stringify(byRule));
for (const h of hits) console.log("  "+h);
