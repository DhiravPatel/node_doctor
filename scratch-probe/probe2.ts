import { lintSource } from "../src/core/scan.ts";
import { noLivenessCheckWithDependency as D } from "../src/diagnostics/reliability/no-liveness-check-with-dependency.ts";
const caps = new Set(["node","esm","typescript","express"]);
const n = (s:string)=>lintSource({filePath:"a.ts",sourceText:s,diagnostics:[D],capabilities:caps}).findings.length;
const c: Array<[string,string]> = [
  ["/health_check db (underscore)", `app.get("/health_check", async(req,res)=>{ await db.query("x"); });`],
  ["/status.json db", `app.get("/status.json", async(req,res)=>{ await db.query("x"); });`],
  ["/healthcheck db (no sep)", `app.get("/healthcheck", async(req,res)=>{ await db.query("x"); });`],
  ["/cache warmer redis.set on /healthz set", `app.get("/healthz", async(req,res)=>{ await redisCache.set("k","v"); });`],
  ["/health-tips memcache.get", `app.get("/health-tips", async(req,res)=>{ await memcache.get("k"); });`],
  ["ready wins /ready/health db", `app.get("/ready/health", async(req,res)=>{ await db.query("x"); });`],
];
for (const [l,s] of c) console.log(`${n(s)}\t${l}`);
