import { lintSource } from "../src/core/scan.ts";
import { noSharedCacheAuthenticatedResponse as D } from "../src/diagnostics/http/no-shared-cache-authenticated-response.ts";
const caps=new Set(["node","esm","typescript","express","koa","fastify"]);
const n=(s)=>lintSource({filePath:"a.ts",sourceText:s,diagnostics:[D],capabilities:caps}).findings.length;
const T=[
 // --- must FIRE (true positives) ---
 ["TP: public + res.json(req.user)", `app.get("/me",(req,res)=>{ res.set("Cache-Control","public, max-age=600"); res.json(req.user); });`, 1],
 ["TP: s-maxage=300 + req.session in body", `app.get("/me",(req,res)=>{ res.setHeader("Cache-Control","s-maxage=300"); res.json(req.session.userId); });`, 1],
 ["TP: const u=req.user; res.json(u)", `app.get("/me",(req,res)=>{ const u=req.user; res.set("Cache-Control","public"); res.json(u); });`, 1],
 ["TP: destructured const {user}=req; res.json(user)", `app.get("/me",(req,res)=>{ const {user}=req; res.set("Cache-Control","public, max-age=60"); res.json(user); });`, 1],
 ["TP: koa ctx.body={user:ctx.state.user}", `router.get("/me",async(ctx)=>{ ctx.set("Cache-Control","public, max-age=60"); ctx.body={user:ctx.state.user}; });`, 1],
 ["TP: object form + req.user body", `app.get("/me",(req,res)=>{ res.set({"Cache-Control":"public, max-age=60"}); res.json({name:req.user.name}); });`, 1],
 // --- must be SILENT (FPs the hunt found) ---
 ["FP-fix Vary:Authorization", `app.get("/me",(req,res)=>{ res.set("Vary","Authorization"); res.set("Cache-Control","public, max-age=30"); res.json(req.user); });`, 0],
 ["FP-fix override public->private", `app.get("/feed",(req,res)=>{ res.set("Cache-Control","public, max-age=60"); res.set("Cache-Control","private, no-store"); res.json(req.user); });`, 0],
 ["FP-fix auth-gate only, public body", `app.get("/catalog",(req,res)=>{ if(!req.user) return res.sendStatus(401); res.set("Cache-Control","public, max-age=3600"); res.json(PUBLIC_CATALOG); });`, 0],
 ["FP-fix CSRF read only, public body", `app.get("/m",(req,res)=>{ const csrf=req.cookies["XSRF-TOKEN"]; res.set("Cache-Control","public, max-age=60"); res.json(ASSET_MANIFEST); });`, 0],
 ["FP-fix s-maxage=0", `app.get("/me",(req,res)=>{ res.set("Cache-Control","s-maxage=0"); res.json(req.user); });`, 0],
 ["SILENT private,no-store", `app.get("/me",(req,res)=>{ res.set("Cache-Control","private, no-store"); res.json(req.user); });`, 0],
 ["SILENT no identity anywhere", `app.get("/plans",(req,res)=>{ res.set("Cache-Control","public, max-age=3600"); res.json(PLANS); });`, 0],
];
let fail=0;
for (const [l,s,exp] of T){ const g=n(s); const ok=g===exp; if(!ok)fail++; console.log(`${ok?"✓":"✗ FAIL"} [${g}/${exp}] ${l}`); }
console.log(fail?`\n${fail} FAILED`:"\nALL PASS");
