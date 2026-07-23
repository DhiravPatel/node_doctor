import { readFileSync } from "node:fs";
import { lintSource } from "../src/core/scan.ts";
import { noUnanchoredSecurityRegex } from "../src/diagnostics/security/no-unanchored-security-regex.ts";
const caps = new Set(["node","esm","typescript","commonjs","express"]);
for (const f of ["/Users/dhiravpatel/Documents/Project2/clinicflow-app/node_modules/firebase/firebase-database.js",
                 "/Users/dhiravpatel/Documents/Project2/clinicflow-app/node_modules/firebase/firebase-database-compat.js"]) {
  const src = readFileSync(f,"utf8");
  const res = lintSource({ filePath:f, sourceText:src, diagnostics:[noUnanchoredSecurityRegex], capabilities:caps });
  for (const x of res.findings) {
    // The message includes the pattern in backticks: `/…/`
    const m = x.message.match(/`\/(.*?)\/`/);
    console.log(f.split("/").pop(), "→ regex:", m? m[1] : x.message.slice(0,120));
  }
}
