import { lintSource } from "../src/core/scan.ts";
import { noLivenessCheckWithDependency as D } from "../src/diagnostics/reliability/no-liveness-check-with-dependency.ts";

const caps = new Set(["node", "esm", "typescript", "express"]);
const n = (src: string): number =>
  lintSource({ filePath: "a.ts", sourceText: src, diagnostics: [D], capabilities: caps }).findings.length;

const cases: Array<[string, string]> = [
  // ---- Readiness precedence (should all be SILENT) ----
  ["readiness /health/ready", `app.get("/health/ready", async(req,res)=>{ await db.query("SELECT 1"); res.sendStatus(200); });`],
  ["readiness /readyz", `app.get("/readyz", async(req,res)=>{ await db.query("SELECT 1"); res.sendStatus(200); });`],
  ["readiness /readiness", `app.get("/readiness", async(req,res)=>{ await db.query("SELECT 1"); res.sendStatus(200); });`],
  ["readiness /ready", `app.get("/ready", async(req,res)=>{ await db.query("SELECT 1"); res.sendStatus(200); });`],

  // ---- /status process metrics (no dep) — SILENT ----
  ["status process.memoryUsage", `app.get("/status", async(req,res)=>{ const m = process.memoryUsage(); res.json(m); });`],

  // ---- in-memory cache.get — FP concern ----
  ["healthz cache.get in-memory", `app.get("/healthz", async(req,res)=>{ const v = await cache.get("build-version"); res.json({v}); });`],
  ["healthz Map.get in-memory (var named cache)", `const cache = new Map(); app.get("/healthz", async(req,res)=>{ const v = cache.get("build-version"); res.json({v}); });`],
  ["healthz localCache.get", `app.get("/healthz", async(req,res)=>{ const v = localCache.get("x"); res.json({v}); });`],

  // ---- shallow liveness — SILENT ----
  ["health sendStatus", `app.get("/health", (req,res)=>res.sendStatus(200));`],

  // ---- /health-tips over-match tests ----
  ["/api/health-tips db.query (anchored?)", `app.get("/api/health-tips", async(req,res)=>{ await db.query("SELECT 1"); });`],
  ["/health-tips db.query (root)", `app.get("/health-tips", async(req,res)=>{ await db.query("SELECT 1"); });`],
  ["/healthcheck-history db.query", `app.get("/healthcheck-history", async(req,res)=>{ await db.query("SELECT 1"); });`],
  ["/healthy-recipes db.query", `app.get("/healthy-recipes", async(req,res)=>{ await db.query("SELECT 1"); });`],
  ["/health-tips fetch (root)", `app.get("/health-tips", async(req,res)=>{ await fetch("http://x/y"); });`],
  ["/pingpong db.query", `app.get("/pingpong", async(req,res)=>{ await db.query("SELECT 1"); });`],
  ["/statuses db.query", `app.get("/statuses", async(req,res)=>{ await db.query("SELECT 1"); });`],
  ["/livestream db.query", `app.get("/livestream", async(req,res)=>{ await db.query("SELECT 1"); });`],

  // ---- /metrics registry.metrics() — SILENT ----
  ["/metrics registry.metrics", `app.get("/metrics", async(req,res)=>{ await registry.metrics(); });`],

  // ---- asyncHandler unwrap TP ----
  ["router /livez asyncHandler fetch (TP)", `router.get("/livez", asyncHandler(async(req,res)=>{ await fetch("http://sidecar/ping"); }));`],

  // ---- baseline TPs to prove wiring ----
  ["baseline /healthz db.query (TP)", `app.get("/healthz", async(req,res)=>{ await db.query("SELECT 1"); res.sendStatus(200); });`],
  ["baseline /health redis.ping (TP)", `app.get("/health", async(req,res)=>{ await redis.ping(); res.sendStatus(200); });`],
];

for (const [label, src] of cases) {
  console.log(`${n(src)}\t${label}`);
}
