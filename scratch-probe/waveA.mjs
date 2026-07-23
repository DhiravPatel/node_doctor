import { lintSource } from "../src/core/scan.ts";
import { noUnanchoredSecurityRegex } from "../src/diagnostics/security/no-unanchored-security-regex.ts";
import { noStatefulGlobalRegexTest } from "../src/diagnostics/security/no-stateful-global-regex-test.ts";
import { noThrowLiteral } from "../src/diagnostics/bugs/no-throw-literal.ts";
import { noBigintPrecisionLoss } from "../src/diagnostics/bugs/no-bigint-precision-loss.ts";
import { noNondeterministicStableKey } from "../src/diagnostics/security/no-nondeterministic-stable-key.ts";
const caps = new Set(["node","esm","typescript","express"]);
const run = (d, src) => lintSource({ filePath:"src/a.ts", sourceText:src, diagnostics:[d], capabilities:caps }).findings.length;
const C = [
  // §146 unanchored security regex
  ["regex: unanchored url check FIRES", noUnanchoredSecurityRegex, `if (/https:\\/\\/trusted\\.com/.test(redirectUrl)) redirect(redirectUrl);`, true],
  ["regex: anchored url check SILENT", noUnanchoredSecurityRegex, `if (/^https:\\/\\/trusted\\.com$/.test(redirectUrl)) redirect(redirectUrl);`, false],
  ["regex: replace/tokenize SILENT", noUnanchoredSecurityRegex, `const clean = str.replace(/\\s+/g, " ");`, false],
  ["regex: non-security digit test SILENT", noUnanchoredSecurityRegex, `if (/^\\d{4}$/.test(pin)) ok();`, false],
  // §146 stateful global regex
  ["regex: stored /g .test FIRES", noStatefulGlobalRegexTest, `const re = /foo/g;\nfunction f(x){ return re.test(x); }`, true],
  ["regex: non-global .test SILENT", noStatefulGlobalRegexTest, `const re = /foo/;\nfunction f(x){ return re.test(x); }`, false],
  ["regex: .replace with /g SILENT", noStatefulGlobalRegexTest, `const re = /foo/g;\nfunction f(x){ return x.replace(re, ""); }`, false],
  // §153 throw literal
  ["throw string FIRES", noThrowLiteral, `function f(){ throw "boom"; }`, true],
  ["throw object literal FIRES", noThrowLiteral, `function f(){ throw { code: 500 }; }`, true],
  ["throw new Error SILENT", noThrowLiteral, `function f(){ throw new Error("x"); }`, false],
  ["throw new CustomError SILENT", noThrowLiteral, `function f(){ throw new NotFoundError("x"); }`, false],
  ["re-throw caught err SILENT", noThrowLiteral, `try { g(); } catch (err) { throw err; }`, false],
  ["throw factory() SILENT", noThrowLiteral, `function f(){ throw makeError(500); }`, false],
  // §145 bigint precision
  ["Number(bigint literal) FIRES", noBigintPrecisionLoss, `const id = 123n;\nconst n = Number(id);`, true],
  ["+bigint FIRES", noBigintPrecisionLoss, `const id = BigInt(row.id);\nconst n = +id;`, true],
  ["Number(unknown) SILENT", noBigintPrecisionLoss, `const n = Number(req.query.id);`, false],
  ["bigint.toString() SILENT", noBigintPrecisionLoss, `const id = 123n;\nconst s = id.toString();`, false],
  // §150 nondeterministic key
  ["Date.now into hmac.update FIRES", noNondeterministicStableKey, `const h = crypto.createHmac("sha256", key);\nh.update("p" + Date.now());`, true],
  ["Math.random into cache.set key FIRES", noNondeterministicStableKey, `cache.set("k" + Math.random(), value);`, true],
  ["Math.random for a token SILENT", noNondeterministicStableKey, `const token = Math.random().toString(36);`, false],
  ["static cache key SILENT", noNondeterministicStableKey, `cache.set("orders:" + status, value);`, false],
];
let bad=0;
for (const [name,d,src,fire] of C){const n=run(d,src);const ok=(n>0)===fire;if(!ok)bad++;console.log(`  ${ok?"ok  ":"FAIL"} ${fire?"FIRE ":"SILENT"} ${name}${ok?"":` (got ${n})`}`);}
console.log(bad===0?"\nALL PASS":`\n${bad} FAIL`);
