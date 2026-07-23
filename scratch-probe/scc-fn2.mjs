import { lintSource } from "../src/core/scan.ts";
import { noSharedCacheAuthenticatedResponse as D } from "../src/diagnostics/http/no-shared-cache-authenticated-response.ts";
const caps = new Set(["node","esm","typescript","express","koa","fastify"]);
const n = (src) => lintSource({ filePath:"a.ts", sourceText:src, diagnostics:[D], capabilities:caps }).findings.length;
const cases = [
  ["G1 destructure rename const {user:u}=req",
   `app.get("/me",(req,res)=>{ const { user: u } = req; res.set("Cache-Control","public"); res.json(u); });`],
  ["G2 destructure nested {session:{userId}}=req",
   `app.get("/me",(req,res)=>{ const { session: { userId } } = req; res.set("Cache-Control","public"); res.json(userId); });`],
  ["G3 identity assigned to var then header (direct member still present)",
   `app.get("/me",(req,res)=>{ const uid = req.session.userId; res.set("Cache-Control","public"); res.json(uid); });`],
  ["G4 async await then direct req.user",
   `app.get("/me",async (req,res)=>{ res.set("Cache-Control","public"); const d = await load(); res.json(req.user); });`],
  ["G5 sync helper closure (defined+called in handler) req.user in closure",
   `app.get("/me",(req,res)=>{ res.set("Cache-Control","public"); const pick=()=>req.user.name; res.json(pick()); });`],
  ["G6 Vary Authorization present but still public+req.user (FP check)",
   `app.get("/me",(req,res)=>{ res.set("Cache-Control","public, max-age=60"); res.set("Vary","Authorization"); res.json(req.user); });`],
  ["G7 param renamed handler (r,s) reads r.user",
   `app.get("/me",(r,s)=>{ s.set("Cache-Control","public"); s.json(r.user); });`],
  ["G8 forEach/map nested identity read",
   `app.get("/list",(req,res)=>{ res.set("Cache-Control","public"); items.forEach(i=>{ log(req.user.id); }); res.json(items); });`],
  ["G9 koa ctx.response.set",
   `router.get("/me",(ctx)=>{ ctx.response.set("Cache-Control","public"); ctx.body = ctx.session.userId; });`],
  ["G10 exported GET convention handler (Next/SvelteKit)",
   `export function GET(request){ const r = new Response(); return r; }`],
];
for (const [name, src] of cases) {
  let c; try { c = n(src); } catch (e) { c = "ERR:" + e.message; }
  console.log(String(c).padStart(5), name);
}
