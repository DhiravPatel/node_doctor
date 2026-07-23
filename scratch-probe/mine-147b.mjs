import { lintSource } from "../src/core/scan.ts";
import { noSharedCacheAuthenticatedResponse as D } from "../src/diagnostics/http/no-shared-cache-authenticated-response.ts";
const caps = new Set(["node","esm","typescript","express"]);
const n = (src) => lintSource({ filePath:"a.ts", sourceText:src, diagnostics:[D], capabilities:caps }).findings.length;
const cases = [
  ["TP: public,max-age=600 + req.user", `app.get("/me",(req,res)=>{ res.set("Cache-Control","public, max-age=600"); res.json(req.user); });`],
  ["TP: s-maxage=300 + req.session", `app.get("/me",(req,res)=>{ const s=req.session.userId; res.setHeader("Cache-Control","s-maxage=300"); res.json(s); });`],
  ["FP-fixed: bare s-maxage=0 + req.user", `app.get("/me",(req,res)=>{ const u=req.user; res.set("Cache-Control","s-maxage=0"); res.json(u); });`],
  ["still fires (public present): public, s-maxage=0", `app.get("/me",(req,res)=>{ const u=req.user; res.set("Cache-Control","public, s-maxage=0"); res.json(u); });`],
  ["SILENT: private, no-store", `app.get("/me",(req,res)=>{ const u=req.user; res.set("Cache-Control","private, no-store"); res.json(u); });`],
];
for (const [label, src] of cases) console.log(`[${n(src)}] ${label}`);
