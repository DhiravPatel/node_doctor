import { lintSource } from "../src/core/scan.ts";
import { noRetryAmplification as R } from "../src/diagnostics/reliability/no-retry-amplification.ts";
import { noLostAsyncContext as A } from "../src/diagnostics/reliability/no-lost-async-context.ts";
const caps=new Set(["node","esm","typescript"]);
const nr=(s)=>lintSource({filePath:"a.ts",sourceText:s,diagnostics:[R],capabilities:caps}).findings.length;
const na=(s)=>lintSource({filePath:"a.ts",sourceText:s,diagnostics:[A],capabilities:caps}).findings.length;
console.log("── §135 retry ──");
for (const [l,s] of [
 ["TP: pRetry(pRetry)", `pRetry(() => pRetry(() => call()));`],
 ["TP: pRetry(s3Client.send)", `pRetry(() => s3Client.send(cmd));`],
 ["RISK: pRetry(emailClient.send) non-AWS mailer", `pRetry(() => emailClient.send(msg));`],
 ["RISK: pRetry(queueClient.send)", `pRetry(() => queueClient.send(job));`],
 ["SILENT: pRetry(fetch)", `pRetry(() => fetch(url));`],
 ["SILENT: lone retry(work)", `retry(() => work());`],
]) console.log(`[${nr(s)}] ${l}`);
console.log("── §152 async-context ──");
for (const [l,s] of [
 ["TP: emitter.on getStore", `import {AsyncLocalStorage} from "async_hooks"; const als=new AsyncLocalStorage(); emitter.on("x",()=>{const c=als.getStore();});`],
 ["RISK: sync emit within run", `import {AsyncLocalStorage} from "async_hooks"; const als=new AsyncLocalStorage(); als.run(store,()=>{const ee=new EventEmitter(); ee.on("x",()=>als.getStore()); ee.emit("x");});`],
 ["RISK: PathB context.getStore non-ALS", `import {AsyncLocalStorage} from "async_hooks"; emitter.on("x",()=>{const c=context.getStore();});`],
 ["SILENT: als.run getStore", `import {AsyncLocalStorage} from "async_hooks"; const als=new AsyncLocalStorage(); als.run(store,()=>{const c=als.getStore();});`],
 ["SILENT: setTimeout getStore", `import {AsyncLocalStorage} from "async_hooks"; const als=new AsyncLocalStorage(); setTimeout(()=>als.getStore(),0);`],
]) console.log(`[${na(s)}] ${l}`);
