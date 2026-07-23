import { lintSource } from "../src/core/scan.ts";
import { noSharedCacheAuthenticatedResponse as D } from "../src/diagnostics/http/no-shared-cache-authenticated-response.ts";

const caps = new Set(["node", "esm", "typescript", "express"]);
const n = (src) =>
  lintSource({ filePath: "a.ts", sourceText: src, diagnostics: [D], capabilities: caps }).findings.length;

const cases = {
  // realistic conditional override: default public, private when authed
  "R1 default public; if(req.user) override to private (common CDN pattern)":
    `app.get("/feed",(req,res)=>{ res.set("Cache-Control","public, max-age=60"); if(req.user){ res.set("Cache-Control","private, no-store"); } res.json(feed(req.user)); });`,
  // Vary: Cookie form too
  "R2 public + Vary Cookie + req.cookies (per-cookie keyed, correct)":
    `app.get("/home",(req,res)=>{ const v=req.cookies.ab; res.set("Vary","Cookie"); res.set("Cache-Control","public, max-age=60"); res.json(homeFor(v)); });`,
  // fastify vary
  "R3 fastify reply Vary Authorization + public + request.user (documented fix)":
    `fastify.get("/me",async(request,reply)=>{ reply.header("Vary","Authorization"); reply.header("Cache-Control","public, max-age=30"); return request.user; });`,
  // object-form set with Vary in same object
  "R4 res.set object {Cache-Control:public, Vary:Authorization} + req.user":
    `app.get("/me",(req,res)=>{ res.set({"Cache-Control":"public, max-age=30","Vary":"Authorization"}); res.json(req.user); });`,
  // s-maxage=0 with public present
  "R5 public, s-maxage=0 + user (public storage disabled at shared layer)":
    `app.get("/me",(req,res)=>{ const u=req.user; res.set("Cache-Control","public, s-maxage=0, max-age=60"); res.json(u); });`,
  // confirm no-store anywhere silences even with public
  "R6 sanity: public, no-store + user (should be silent)":
    `app.get("/me",(req,res)=>{ const u=req.user; res.set("Cache-Control","public, no-store"); res.json(u); });`,
  // FN: signedCookies confirm + koa ctx.state variants
  "R7 koa ctx.state.user via header set ctx.set + Vary":
    `router.get("/me",async(ctx)=>{ ctx.set("Cache-Control","public, max-age=60"); ctx.body={user:ctx.state.user}; });`,
  // FN: express req.headers['x-user-id'] style custom identity header (not covered) - not identity by design
  // FN: setHeader raw node style is covered (setHeader in HEADER_SET_METHODS)
  "R8 res.setHeader raw + req.user (setHeader covered?)":
    `app.get("/me",(req,res)=>{ const u=req.user; res.setHeader("Cache-Control","public, max-age=60"); res.end(JSON.stringify(u)); });`,
};

for (const [name, src] of Object.entries(cases)) {
  console.log(String(n(src)).padStart(2), " ", name);
}
