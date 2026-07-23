import { lintSource } from "../src/core/scan.ts";
import { noSharedCacheAuthenticatedResponse as D } from "../src/diagnostics/http/no-shared-cache-authenticated-response.ts";
const caps = new Set(["node","esm","typescript","express"]);
const n = (src) => lintSource({ filePath:"a.ts", sourceText:src, diagnostics:[D], capabilities:caps }).findings.length;
const cases = [
  ["TP: public cache + res.json(req.user)", `app.get("/me",(req,res)=>{ res.set("Cache-Control","public, max-age=600"); res.json(req.user); });`],
  ["?: req.user auth-gate only, PUBLIC payload", `app.get("/plans",(req,res)=>{ if(!req.user) return res.sendStatus(401); res.set("Cache-Control","public, max-age=3600"); res.json(PLANS); });`],
  ["?: s-maxage=0 (not shared-cached)", `app.get("/me",(req,res)=>{ const u=req.user; res.set("Cache-Control","public, s-maxage=0"); res.json(u); });`],
  ["?: public, max-age=0, must-revalidate", `app.get("/me",(req,res)=>{ const u=req.user; res.set("Cache-Control","public, max-age=0, must-revalidate"); res.json(u); });`],
  ["override: public then private (2 calls)", `app.get("/me",(req,res)=>{ const u=req.user; res.set("Cache-Control","public"); res.set("Cache-Control","private, no-store"); res.json(u); });`],
  ["SILENT: private, no-store", `app.get("/me",(req,res)=>{ const u=req.user; res.set("Cache-Control","private, no-store"); res.json(u); });`],
  ["SILENT: no identity read", `app.get("/plans",(req,res)=>{ res.set("Cache-Control","public, max-age=3600"); res.json(PLANS); });`],
];
for (const [label, src] of cases) console.log(`[${n(src)}] ${label}`);
