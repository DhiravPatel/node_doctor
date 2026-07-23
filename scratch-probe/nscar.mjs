import { lintSource } from "../src/core/scan.ts";
import { noSharedCacheAuthenticatedResponse as D } from "../src/diagnostics/http/no-shared-cache-authenticated-response.ts";

const caps = new Set(["node", "esm", "typescript", "express"]);
const n = (src) =>
  lintSource({ filePath: "a.ts", sourceText: src, diagnostics: [D], capabilities: caps }).findings.length;

const cases = {
  // ---- baseline sanity ----
  "01 canonical leak (req.user + public)":
    `app.get("/me",(req,res)=>{const u=req.user;res.set("Cache-Control","public, max-age=60");res.json(u);});`,
  "02 corrected (private)":
    `app.get("/me",(req,res)=>{const u=req.user;res.set("Cache-Control","private, no-store");res.json(u);});`,
  "03 truly public, no identity read":
    `app.get("/pricing",(req,res)=>{res.set("Cache-Control","public, max-age=3600");res.json(PLANS);});`,

  // ---- FP angle A: identity read only gates auth, response is public ----
  "A1 !req.user -> 401 gate, then PUBLIC catalog":
    `app.get("/catalog",(req,res)=>{ if(!req.user) return res.status(401).end(); res.set("Cache-Control","public, max-age=3600"); res.json(PUBLIC_CATALOG); });`,
  "A2 req.user only for logging, public marketing payload":
    `app.get("/promo",(req,res)=>{ logger.info("viewer",req.user&&req.user.id); res.set("Cache-Control","public, max-age=600"); res.json(PROMO); });`,

  // ---- FP angle B: cookie read for CSRF / feature flag, not personalization ----
  "B1 req.cookies for CSRF token only, public asset list":
    `app.get("/assets",(req,res)=>{ const csrf=req.cookies["XSRF-TOKEN"]; validateCsrf(csrf); res.set("Cache-Control","public, max-age=86400"); res.json(ASSET_MANIFEST); });`,
  "B2 req.cookies feature flag, public payload":
    `app.get("/home",(req,res)=>{ const variant=req.cookies.ab_bucket; res.set("Cache-Control","public, max-age=300"); res.json(homeFor(variant)); });`,

  // ---- FP angle C: public, max-age=0, must-revalidate ----
  "C1 public, max-age=0, must-revalidate + user":
    `app.get("/me",(req,res)=>{ const u=req.user; res.set("Cache-Control","public, max-age=0, must-revalidate"); res.json(u); });`,
  "C2 public, no-cache + user":
    `app.get("/me",(req,res)=>{ const u=req.user; res.set("Cache-Control","public, no-cache"); res.json(u); });`,

  // ---- FP angle D: two set calls, first public then private overrides ----
  "D1 public then private override (two calls)":
    `app.get("/me",(req,res)=>{ const u=req.user; res.set("Cache-Control","public"); res.set("Cache-Control","private, no-store"); res.json(u); });`,

  // ---- FP angle E: s-maxage=0 explicitly not shared-cached ----
  "E1 s-maxage=0 + user":
    `app.get("/me",(req,res)=>{ const u=req.user; res.set("Cache-Control","s-maxage=0"); res.json(u); });`,
  "E2 s-maxage=0, max-age=60 + user":
    `app.get("/me",(req,res)=>{ const u=req.user; res.set("Cache-Control","max-age=60, s-maxage=0"); res.json(u); });`,

  // ---- FP angle F: Vary: Authorization set (properly keyed) alongside public ----
  "F1 public + Vary: Authorization + user (correct per-user keying)":
    `app.get("/me",(req,res)=>{ const u=req.user; res.set("Vary","Authorization"); res.set("Cache-Control","public, max-age=30"); res.json(u); });`,

  // ---- FP angle G: middleware sets public globally ----
  "G1 app.use middleware sets public, reads req.user for logging":
    `app.use((req,res,next)=>{ if(req.user) audit(req.user.id); res.set("Cache-Control","public, max-age=60"); next(); });`,

  // ---- koa / fastify ----
  "K1 koa ctx.set public + ctx.state.user (real koa identity location)":
    `router.get("/me",async(ctx)=>{ const u=ctx.state.user; ctx.set("Cache-Control","public, max-age=60"); ctx.body=u; });`,
  "K2 koa ctx.set public + ctx.session (direct)":
    `router.get("/me",async(ctx)=>{ const s=ctx.session; ctx.set("Cache-Control","public, max-age=60"); ctx.body=s; });`,
  "FA1 fastify reply.header public + request.user":
    `fastify.get("/me",async(request,reply)=>{ const u=request.user; reply.header("Cache-Control","public, max-age=60"); return u; });`,

  // ---- FN angles ----
  "FN1 destructured const {user}=req + public (leak, member miss)":
    `app.get("/me",(req,res)=>{ const {user}=req; res.set("Cache-Control","public, max-age=60"); res.json(user); });`,
  "FN2 req.signedCookies + public (identity, not in prop set)":
    `app.get("/me",(req,res)=>{ const u=req.signedCookies.sid; res.set("Cache-Control","public, max-age=60"); res.json(u); });`,
  "FN3 res.writeHead({Cache-Control:public}) + req.user":
    `app.get("/me",(req,res)=>{ const u=req.user; res.writeHead(200,{"Cache-Control":"public, max-age=60"}); res.end(JSON.stringify(u)); });`,
  "FN4 identity read inside nested .then() closure (pruned)":
    `app.get("/me",(req,res)=>{ res.set("Cache-Control","public, max-age=60"); fetchProfile().then(()=>{ send(req.user); }); });`,
  "FN5 koa ctx.state.user (confirm miss) minimal":
    `router.get("/me",async(ctx)=>{ ctx.set("Cache-Control","public"); ctx.body=ctx.state.user; });`,
};

for (const [name, src] of Object.entries(cases)) {
  console.log(String(n(src)).padStart(2), " ", name);
}
