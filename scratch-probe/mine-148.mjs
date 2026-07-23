import { lintSource } from "../src/core/scan.ts";
import { noUnnormalizedIdentityComparison as D } from "../src/diagnostics/security/no-unnormalized-identity-comparison.ts";
const caps = new Set(["node","esm","typescript"]);
const n = (src) => lintSource({ filePath:"a.ts", sourceText:src, diagnostics:[D], capabilities:caps }).findings.length;
const cases = [
  ["over-match handler", `if (handler.toLowerCase() === x) go();`],
  ["over-match slugify", `if (slugify.trim() === x) go();`],
  ["over-match accountId", `if (accountId.toLowerCase() === x) go();`],
  ["camelCase userName (should fire)", `if (userName.toLowerCase() === input.toLowerCase()) go();`],
  ["identity vs literal 'admin'", `if (slug.toLowerCase() === "admin") elevate();`],
  ["identity vs empty string", `if (email.trim() === "") reject();`],
  ["two dynamic identities (real TP)", `if (username.toLowerCase() === input.toLowerCase()) grant();`],
  ["email.trim() === stored (TP)", `if (email.trim() === stored) merge();`],
];
for (const [label, src] of cases) console.log(`[${n(src)}] ${label}`);
