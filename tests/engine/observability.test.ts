import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildObservabilityReport,
  type ObservabilityReport,
  type RouteObservability,
} from "../../src/core/observability.ts";

// ---------------------------------------------------------------------------
// §151 — Observability Coverage Score
//
// An express-app fixture exercising each check's pass and fail path:
//   /orders/:id  — try/catch + logger.error + fetch{signal} + correlation id (high)
//   /users/:id   — async awaits with NO try/catch                (error-handling fail)
//   /webhook     — a catch that swallows (empty)                 (logs-on-failure fail)
//   /proxy       — fetch with no timeout                         (timed-external-calls fail)
//   /health      — sync handler, no await                       (error-handling na, high)
// ---------------------------------------------------------------------------

const FIXTURE = `
import express from "express";
import asyncHandler from "express-async-handler";
const app = express();

// High score: async error handling, logs on failure, a timed fetch, correlation id.
app.get("/orders/:id", asyncHandler(async (req, res) => {
  const rid = req.headers["x-request-id"];
  try {
    const data = await fetch("https://api.example.com/orders", { signal: AbortSignal.timeout(5000) });
    logger.info({ requestId: rid }, "fetched orders");
    res.json(await data.json());
  } catch (err) {
    logger.error({ requestId: rid, err }, "failed to fetch orders");
    res.status(500).json({ error: "internal" });
  }
}));

// error-handling FAIL: awaits with no try/catch, no wrapper, no .catch.
app.get("/users/:id", async (req, res) => {
  const user = await db.users.findUnique({ where: { id: req.params.id } });
  res.json(user);
});

// logs-on-failure FAIL: a catch that swallows the error (only responds).
app.post("/webhook", async (req, res) => {
  try {
    await processWebhook(req.body);
    res.sendStatus(200);
  } catch (err) {
    res.sendStatus(500);
  }
});

// timed-external-calls FAIL: fetch with no timeout/signal.
app.get("/proxy", async (req, res) => {
  try {
    const r = await fetch("https://upstream.example.com/data");
    res.json(await r.json());
  } catch (err) {
    console.error("proxy failed", err);
    res.status(502).end();
  }
});

// error-handling NA: a synchronous handler with nothing async to fail.
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});
`;

let dir: string;
let report: ObservabilityReport;

const byPath = (r: ObservabilityReport, path: string): RouteObservability => {
  const found = r.routes.find((route) => route.path === path);
  assert.ok(found, `expected a route for ${path}`);
  return found!;
};

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "nd-observability-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "routes.js"), FIXTURE, "utf8");
  report = await buildObservabilityReport(dir);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("buildObservabilityReport — per-route checks", () => {
  test("scores every registered route handler", () => {
    assert.equal(report.summary.routes, 5);
    assert.equal(report.routes.length, 5);
  });

  test("high-score route passes all applicable checks", () => {
    const r = byPath(report, "/orders/:id");
    assert.equal(r.method, "GET");
    assert.equal(r.checks["error-handling"], "pass");
    assert.equal(r.checks["logs-on-failure"], "pass");
    assert.equal(r.checks["timed-external-calls"], "pass");
    assert.equal(r.checks["correlation-id"], "pass");
    assert.equal(r.score, 100);
  });

  test("async handler with no try/catch fails error-handling", () => {
    const r = byPath(report, "/users/:id");
    assert.equal(r.checks["error-handling"], "fail");
    assert.equal(r.checks["logs-on-failure"], "na");
    assert.equal(r.checks["timed-external-calls"], "na");
    assert.equal(r.checks["correlation-id"], "na");
    assert.equal(r.score, 0);
  });

  test("a swallowing catch fails logs-on-failure but passes error-handling", () => {
    const r = byPath(report, "/webhook");
    assert.equal(r.checks["error-handling"], "pass");
    assert.equal(r.checks["logs-on-failure"], "fail");
    assert.equal(r.score, 50);
  });

  test("fetch without a timeout fails timed-external-calls", () => {
    const r = byPath(report, "/proxy");
    assert.equal(r.checks["timed-external-calls"], "fail");
    // It has a try/catch and a console.error, so those two pass.
    assert.equal(r.checks["error-handling"], "pass");
    assert.equal(r.checks["logs-on-failure"], "pass");
    // It logs but without a correlation id → fail.
    assert.equal(r.checks["correlation-id"], "fail");
  });

  test("a synchronous handler has nothing async to fail (all na, score 100)", () => {
    const r = byPath(report, "/health");
    assert.equal(r.checks["error-handling"], "na");
    assert.equal(r.checks["logs-on-failure"], "na");
    assert.equal(r.checks["timed-external-calls"], "na");
    assert.equal(r.checks["correlation-id"], "na");
    assert.equal(r.score, 100);
  });
});

describe("buildObservabilityReport — aggregate + determinism", () => {
  test("codebase score is a bounded mean of route scores", () => {
    assert.ok(report.score >= 0 && report.score <= 100, "score in [0,100]");
    const mean = Math.round(report.routes.reduce((s, r) => s + r.score, 0) / report.routes.length);
    assert.equal(report.score, mean);
  });

  test("routes are sorted worst-first (score ascending)", () => {
    for (let i = 1; i < report.routes.length; i++) {
      assert.ok(report.routes[i - 1]!.score <= report.routes[i]!.score, "non-decreasing score order");
    }
  });

  test("per-check pass rate is present for all four checks", () => {
    for (const check of ["error-handling", "logs-on-failure", "timed-external-calls", "correlation-id"]) {
      const rate = report.summary.checkPassRate[check];
      assert.ok(typeof rate === "number" && rate >= 0 && rate <= 100, `${check} rate in [0,100]`);
    }
  });

  test("identical input yields byte-identical output (determinism)", async () => {
    const again = await buildObservabilityReport(dir);
    assert.equal(JSON.stringify(again), JSON.stringify(report));
  });
});

describe("buildObservabilityReport — a `.catch()` swallow is an error path", () => {
  test("`.catch(() => {})` scores like a swallowing try/catch (logs-on-failure fail)", async () => {
    const d = await mkdtemp(join(tmpdir(), "nd-observability-catch-"));
    try {
      await mkdir(join(d, "src"), { recursive: true });
      await writeFile(
        join(d, "src", "r.js"),
        [
          'app.get("/swallow", async (req, res) => { await db.save(req.body).catch(() => {}); res.json({ ok: true }); });',
          'app.get("/logged", async (req, res) => { await db.save(req.body).catch(e => { logger.error(e); }); res.json({ ok: true }); });',
        ].join("\n"),
        "utf8",
      );
      const r = await buildObservabilityReport(d);
      const swallow = r.routes.find((x) => x.path === "/swallow")!;
      const logged = r.routes.find((x) => x.path === "/logged")!;
      assert.equal(swallow.checks["error-handling"], "pass", "the .catch handles the rejection");
      assert.equal(swallow.checks["logs-on-failure"], "fail", "but the empty .catch swallows it");
      assert.equal(logged.checks["logs-on-failure"], "pass", "a .catch that logs passes");
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});

describe("buildObservabilityReport — route disambiguation", () => {
  test("a `cache.get(key, loader)` / `config.get(x, default)` is NOT scored as a route", async () => {
    const d = await mkdtemp(join(tmpdir(), "nd-observability-fp-"));
    try {
      await mkdir(join(d, "src"), { recursive: true });
      await writeFile(
        join(d, "src", "svc.js"),
        [
          "export async function load(cache, db, config) {",
          '  const u = await cache.get("user:1", async () => await db.findUser());',
          '  const port = config.get("port", () => 3000);',
          "  return { u, port };",
          "}",
        ].join("\n"),
        "utf8",
      );
      const r = await buildObservabilityReport(d);
      assert.equal(r.routes.length, 0, "a get-or-load callback is not a (req,res) handler");
      assert.equal(r.score, 100);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});
