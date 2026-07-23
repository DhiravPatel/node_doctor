import { lintSource } from "../src/core/scan.ts";
import { noRetryAmplification as R } from "../src/diagnostics/reliability/no-retry-amplification.ts";
const caps=new Set(["node","esm","typescript"]);
const n=(s)=>lintSource({filePath:"a.ts",sourceText:s,diagnostics:[R],capabilities:caps}).findings.length;
console.log("got.extend (want 0):", n(`import got from "got"; pRetry(() => got.extend({prefixUrl:"x"}));`));
console.log("got() real (want 1):", n(`import got from "got"; pRetry(() => got("x"));`));
