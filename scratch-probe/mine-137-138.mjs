import { lintSource } from "../src/core/scan.ts";
import { noDroppedAbortSignal as S } from "../src/diagnostics/reliability/no-dropped-abort-signal.ts";
import { noLivenessCheckWithDependency as H } from "../src/diagnostics/reliability/no-liveness-check-with-dependency.ts";
const caps=new Set(["node","esm","typescript","express"]);
const ns=(s)=>lintSource({filePath:"a.ts",sourceText:s,diagnostics:[S],capabilities:caps}).findings.length;
const nh=(s)=>lintSource({filePath:"a.ts",sourceText:s,diagnostics:[H],capabilities:caps}).findings.length;
console.log("── §137 ──");
for (const [l,s] of [
 ["TP: fetch drops signal param", `async function f(url, signal){ return fetch(url); }`],
 ["RISK: 'signal' param not an AbortSignal (logs it)", `async function handler(signal){ log("got signal", signal); return fetch(url); }`],
 ["RISK: unix signal handler", `function onSignal(signal){ if(signal==="SIGTERM") shutdown(); return fetch(healthUrl); }`],
 ["SILENT: forwards signal", `async function f(url, signal){ return fetch(url, { signal }); }`],
 ["SILENT: no signal param", `async function f(url){ return fetch(url); }`],
 ["SILENT: nested callback, signal in outer", `function outer(signal){ items.forEach(u => fetch(u)); }`],
]) console.log(`[${ns(s)}] ${l}`);
console.log("── §138 ──");
for (const [l,s] of [
 ["TP: /healthz + db.query", `app.get("/healthz", async (req,res) => { await db.query("SELECT 1"); res.sendStatus(200); });`],
 ["RISK: /health-tips over-match", `app.get("/api/health-tips", async (req,res) => { await db.query("SELECT * FROM tips"); res.json([]); });`],
 ["RISK: /healthcheck-history", `app.get("/healthcheck-history", async (req,res) => { await db.query("SELECT * FROM h"); });`],
 ["RISK: in-memory cache.get on /healthz", `app.get("/healthz", async (req,res) => { const v = cache.get("version"); res.json({v}); });`],
 ["SILENT: /readyz + db", `app.get("/readyz", async (req,res) => { await db.query("SELECT 1"); res.sendStatus(200); });`],
 ["SILENT: shallow /health 200", `app.get("/health", (req,res) => res.sendStatus(200));`],
 ["SILENT: /status memoryUsage", `app.get("/status", (req,res) => { res.json(process.memoryUsage()); });`],
]) console.log(`[${nh(s)}] ${l}`);
