import { lintSource } from "../src/core/scan.ts";
import { noUnanchoredSecurityRegex } from "../src/diagnostics/security/no-unanchored-security-regex.ts";
import { noStatefulGlobalRegexTest } from "../src/diagnostics/security/no-stateful-global-regex-test.ts";
import { noThrowLiteral } from "../src/diagnostics/bugs/no-throw-literal.ts";
import { noBigintPrecisionLoss } from "../src/diagnostics/bugs/no-bigint-precision-loss.ts";
import { noNondeterministicStableKey } from "../src/diagnostics/security/no-nondeterministic-stable-key.ts";

const caps = new Set(["node","esm","typescript","express"]);
const n = (d, src) => lintSource({ filePath:"a.ts", sourceText:src, diagnostics:[d], capabilities:caps }).findings.length;
let fail = 0;
const want = (label, got, exp) => { const ok = got===exp; if(!ok) fail++; console.log(`${ok?"✓":"✗ FAIL"}  [${got}/${exp}] ${label}`); };

console.log("── no-unanchored-security-regex ──");
// FP (reported): extraction, must be SILENT
want("FP: const host = url.match(/…\\/([^/]+)/)[1]", n(noUnanchoredSecurityRegex, `export function f(url){ const host = url.match(/https?:\\/\\/([^/]+)/)[1]; return host; }`), 0);
want("FP: const [,h]=requestUrl.match(...)||[]", n(noUnanchoredSecurityRegex, `export function f(requestUrl){ const [, h] = requestUrl.match(/(https?):\\/\\/([^/]+)/) || []; return h; }`), 0);
want("FP: const m=RE.exec(referer) (stored, assigned)", n(noUnanchoredSecurityRegex, `const RE=/https?:\\/\\/([^/]+)/; export function f(referer){ const m=RE.exec(referer); return m; }`), 0);
// TP: genuine boolean gate, must FIRE
want("TP: if(/https:\\/\\/trusted\\.com/.test(redirectUrl))", n(noUnanchoredSecurityRegex, `export function f(redirectUrl){ if(/https:\\/\\/trusted\\.com/.test(redirectUrl)) location=redirectUrl; }`), 1);
want("TP: if(url.match(/trusted\\.com/)) as gate", n(noUnanchoredSecurityRegex, `export function f(url){ if(url.match(/https:\\/\\/trusted\\.com/)) allow(); }`), 1);
want("TP: !host.match(/internal\\.corp/)", n(noUnanchoredSecurityRegex, `export function f(host){ if(!host.match(/internal\\.corp/)) deny(); }`), 1);
want("TP: const OK=/internal\\.corp/; if(OK.test(host))", n(noUnanchoredSecurityRegex, `const OK=/internal\\.corp/; export function f(host){ if(OK.test(host)) grant(); }`), 1);
// Silent: start-anchored
want("SILENT: /^https?:\\/\\//.test(href)", n(noUnanchoredSecurityRegex, `export function f(href){ if(/^https?:\\/\\//.test(href)) go(); }`), 0);

console.log("── no-stateful-global-regex-test ──");
want("FP: while(RE.test(str)) c++ (counting idiom)", n(noStatefulGlobalRegexTest, `const RE=/\\d/g; export function f(str){ let c=0; while(RE.test(str)) c++; return c; }`), 0);
want("FP: for(;RE.test(s);) c++", n(noStatefulGlobalRegexTest, `const RE=/\\d/g; export function f(s){ let c=0; for(;RE.test(s);) c++; return c; }`), 0);
want("SILENT: while((m=RE.exec(s))) (exec idiom)", n(noStatefulGlobalRegexTest, `const RE=/\\w+/g; export function f(s){ let m; while((m=RE.exec(s))) use(m); }`), 0);
want("TP: const RE=/^[a-z]+$/g; valid=s=>RE.test(s)", n(noStatefulGlobalRegexTest, `const RE=/^[a-z]+$/g; export const valid=(s)=>RE.test(s);`), 1);
want("SILENT: stateless /^[a-z]+$/", n(noStatefulGlobalRegexTest, `const RE=/^[a-z]+$/; export const valid=(s)=>RE.test(s);`), 0);

console.log("── no-throw-literal ──");
want("FP: catch(error) shadows outer const error (string)", n(noThrowLiteral, `const error="\\x1b[31m";\nexport function h(){ try{ work(); } catch(error){ throw error; } }`), 0);
want("TP: throw \"a string literal\"", n(noThrowLiteral, `export function h(){ throw "boom"; }`), 1);
want("SILENT: throw new Error()", n(noThrowLiteral, `export function h(){ throw new Error("x"); }`), 0);
want("SILENT: catch(e){ throw e }", n(noThrowLiteral, `export function h(){ try{work();}catch(e){ throw e; } }`), 0);

console.log("── no-bigint-precision-loss ──");
want("FP: catch(id) shadows outer const id=100n", n(noBigintPrecisionLoss, `const id=100n;\nexport function load(){ try{ fetchRow(); } catch(id){ return Number(id); } }`), 0);
want("TP: const id=100n; Number(id)", n(noBigintPrecisionLoss, `const id=100n; export function f(){ return Number(id); }`), 1);
want("SILENT: String(bigint)", n(noBigintPrecisionLoss, `const id=100n; export function f(){ return String(id); }`), 0);

console.log("── no-nondeterministic-stable-key ──");
want("FP: cache.set(`m:${Math.floor(Date.now()/6e4)}`)", n(noNondeterministicStableKey, `export function f(data){ cache.set(\`metrics:\${Math.floor(Date.now()/60000)}\`, data); }`), 0);
want("FP: redis.set(`rl:${u}:${floor(Date.now()/1000)}`)", n(noNondeterministicStableKey, `export function f(userId,count){ redis.set(\`rl:\${userId}:\${Math.floor(Date.now()/1000)}\`, count); }`), 0);
want("FP: hmac.update(ts + body), ts=Date.now()", n(noNondeterministicStableKey, `import crypto from "crypto"; export function f(secret,body){ const ts=Date.now(); const h=crypto.createHmac("sha256",secret); h.update(ts+"."+body); return h.digest("hex"); }`), 0);
want("SILENT: const tmp=`/tmp/${Date.now()}.log`", n(noNondeterministicStableKey, `export function f(){ const tmp=\`/tmp/\${Date.now()}.log\`; return tmp; }`), 0);
// TP: random sources still fire
want("TP: idempotencyKey: crypto.randomUUID()", n(noNondeterministicStableKey, `import crypto from "crypto"; export function f(){ return { idempotencyKey: crypto.randomUUID() }; }`), 1);
want("TP: redis.set(`job:${Math.random()}`)", n(noNondeterministicStableKey, `export function f(x){ redis.set(\`job:\${Math.random()}\`, x); }`), 1);
want("TP: hmac.update(userId + Math.random())", n(noNondeterministicStableKey, `import crypto from "crypto"; export function f(secret,userId){ const h=crypto.createHmac("sha256",secret); h.update(userId+Math.random()); return h.digest("hex"); }`), 1);
want("SILENT: const token=crypto.randomUUID()", n(noNondeterministicStableKey, `import crypto from "crypto"; export function f(){ const token=crypto.randomUUID(); return token; }`), 0);

console.log(fail===0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail===0?0:1);
