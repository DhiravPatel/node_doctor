import { lintSource } from "../src/core/scan.ts";
import { noSharedCacheAuthenticatedResponse as D } from "../src/diagnostics/http/no-shared-cache-authenticated-response.ts";

const caps = new Set(["node","esm","typescript","express","koa","fastify"]);
const n = (src) => lintSource({ filePath:"a.ts", sourceText:src, diagnostics:[D], capabilities:caps }).findings.length;

const cases = [
  // Baselines that MUST fire
  ["B1 genuine leak app.get /me public max-age",
   `app.get("/me",(req,res)=>{ res.set("Cache-Control","public, max-age=600"); res.json(req.user); });`],
  ["B2 setHeader s-maxage reads req.session.userId",
   `app.get("/me",(req,res)=>{ res.setHeader("Cache-Control","s-maxage=300"); res.json(req.session.userId); });`],
  ["B3 object form res.set({...}) with req.user",
   `app.get("/me",(req,res)=>{ res.set({ "Cache-Control":"public, max-age=60", "X-Foo":"bar" }); res.json(req.user); });`],

  // Destructured identity
  ["FN1 destructured const {user}=req; user.id",
   `app.get("/me",(req,res)=>{ const { user } = req; res.set("Cache-Control","public, max-age=60"); res.json(user.id); });`],
  ["FN1b destructured param ({user})=>",
   `app.get("/me",({ user }, res)=>{ res.set("Cache-Control","public, max-age=60"); res.json(user.id); });`],

  // Computed member identity read
  ["FN2 computed req.headers['authorization']",
   `app.get("/me",(req,res)=>{ res.set("Cache-Control","public, max-age=60"); res.json(req.headers["authorization"]); });`],
  ["FN2b dot req.headers.authorization (control)",
   `app.get("/me",(req,res)=>{ res.set("Cache-Control","public, max-age=60"); res.json(req.headers.authorization); });`],
  ["FN2c computed req['user']",
   `app.get("/me",(req,res)=>{ res.set("Cache-Control","public, max-age=60"); res.json(req["user"]); });`],

  // fastify reply.header lowercase name
  ["FN3 reply.header('cache-control','public') request.user",
   `fastify.get("/me",(request,reply)=>{ reply.header("cache-control","public"); reply.send(request.user); });`],
  ["FN3b reply.header CacheControl no-sep",
   `fastify.get("/me",(request,reply)=>{ reply.header("CacheControl","public"); reply.send(request.user); });`],

  // helper cross-function
  ["FN4 helper sendCached(res, req.user) sets header",
   `function sendCached(res,u){ res.set("Cache-Control","public, max-age=60"); res.json(u); }
    app.get("/me",(req,res)=>{ sendCached(res, req.user); });`],

  // nested callback identity read
  ["FN5 identity read in nested .then callback",
   `app.get("/me",(req,res)=>{ res.set("Cache-Control","public, max-age=60"); load().then(()=>{ res.json(req.user); }); });`],
  ["FN5b identity read in nested arrow (no promise)",
   `app.get("/me",(req,res)=>{ res.set("Cache-Control","public, max-age=60"); const f=()=>req.user.id; res.json(f()); });`],

  // Extra framework shapes worth probing
  ["X1 koa ctx.set cache + ctx.session",
   `router.get("/me",(ctx)=>{ ctx.set("Cache-Control","public, max-age=60"); ctx.body = ctx.session.userId; });`],
  ["X2 res.header alias express",
   `app.get("/me",(req,res)=>{ res.header("Cache-Control","public"); res.json(req.user); });`],
  ["X3 req.get('authorization') identity read",
   `app.get("/me",(req,res)=>{ res.set("Cache-Control","public, max-age=60"); res.json(req.get("authorization")); });`],
  ["X4 req.currentUser",
   `app.get("/me",(req,res)=>{ res.set("Cache-Control","public, max-age=60"); res.json(req.currentUser); });`],
  ["X5 req.userId direct",
   `app.get("/me",(req,res)=>{ res.set("Cache-Control","public, max-age=60"); res.json(req.userId); });`],
  ["X6 private no-store should be SILENT",
   `app.get("/me",(req,res)=>{ res.set("Cache-Control","private, no-store"); res.json(req.user); });`],
  ["X7 max-age only (browser-private) SILENT",
   `app.get("/me",(req,res)=>{ res.set("Cache-Control","max-age=600"); res.json(req.user); });`],
  ["X8 no identity read SILENT",
   `app.get("/pricing",(req,res)=>{ res.set("Cache-Control","public, max-age=3600"); res.json(PLANS); });`],
  ["X9 module-scope header SILENT",
   `res.set("Cache-Control","public, max-age=60");`],
];

for (const [name, src] of cases) {
  let c;
  try { c = n(src); } catch (e) { c = "ERR:" + e.message; }
  console.log(String(c).padStart(5), name);
}
