import { lintSource } from "../src/core/scan.ts";
import { noThrowLiteral } from "../src/diagnostics/bugs/no-throw-literal.ts";
import { noBigintPrecisionLoss } from "../src/diagnostics/bugs/no-bigint-precision-loss.ts";
const caps = new Set(["node","esm","typescript"]);
const run = (d, src) => lintSource({ filePath:"a.ts", sourceText:src, diagnostics:[d], capabilities:caps }).findings.length;
console.log("throw: catch shadows outer string const →", run(noThrowLiteral, `const error = "\\x1b[31m";\nexport function h(){ try { work(); } catch (error) { throw error; } }`), "(want 0)");
console.log("bigint: catch shadows outer bigint const →", run(noBigintPrecisionLoss, `const id = 100n;\nfunction load(){ try { fetch(); } catch (id) { return Number(id); } }`), "(want 0)");
