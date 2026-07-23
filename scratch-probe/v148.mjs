import { lintSource } from "../src/core/scan.ts";
import { noUnnormalizedIdentityComparison as D } from "../src/diagnostics/security/no-unnormalized-identity-comparison.ts";
const caps=new Set(["node","esm","typescript"]);
const n=(s)=>lintSource({filePath:"a.ts",sourceText:s,diagnostics:[D],capabilities:caps}).findings.length;
for (const [l,s] of [
 ["template `admin` (want 0)", "if (slug.toLowerCase() === `admin`) x();"],
 ["Roles.ADMIN (want 0)", "if (username.toLowerCase() === Roles.ADMIN) x();"],
 ["empty template (want 0)", "if (email.trim() === ``) x();"],
 ["TP two dynamic (want 1)", "if (username.toLowerCase() === input.toLowerCase()) x();"],
 ["TP email===stored (want 1)", "if (email.trim() === stored) x();"],
]) console.log(`[${n(s)}] ${l}`);
