import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { lintSource } from "../src/core/scan.ts";
import { noUnanchoredSecurityRegex } from "../src/diagnostics/security/no-unanchored-security-regex.ts";
import { noStatefulGlobalRegexTest } from "../src/diagnostics/security/no-stateful-global-regex-test.ts";
const RULES = [noUnanchoredSecurityRegex, noStatefulGlobalRegexTest];
const caps = new Set(["node","esm","typescript","commonjs","express"]);
const out = execSync(`find /Users/dhiravpatel/Documents/Project2 -type f \\( -name '*.js' -o -name '*.mjs' -o -name '*.ts' \\) -not -path '*/node_doctor/*' 2>/dev/null | head -30000`, {encoding:"utf8", maxBuffer: 1<<29});
let files = [...new Set(out.split("\n").filter(Boolean))];
for (const f of files) {
  let src; try { src = readFileSync(f, "utf8"); } catch { continue; }
  if (src.length > 400_000) continue;
  let res; try { res = lintSource({ filePath: f, sourceText: src, diagnostics: RULES, capabilities: caps }); } catch { continue; }
  for (const x of res.findings) {
    const lines = src.split("\n");
    console.log(`\n### [${x.diagnostic}] ${f}:${x.line}`);
    console.log("   " + (lines[x.line-1]||"").trim().slice(0,200));
  }
}
