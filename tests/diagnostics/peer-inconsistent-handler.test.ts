/**
 * §164 — `no-peer-inconsistent-handler`.
 *
 * The only statistical rule in the catalog, and an adversarial hunt confirmed
 * fifteen ways the first version got it wrong. The silence cases below ARE the
 * specification — above all that the population must be a PROVEN Express router
 * resolved through its binding, because grouping by the name `router` merged
 * every factory in a route file into one fabricated population.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noPeerInconsistentHandler } from "../../src/diagnostics/frameworks/no-peer-inconsistent-handler.ts";

const CAPS = new Set(["node", "esm", "typescript", "express"]);

const findings = (source: string) =>
  lintSource({
    filePath: "/repo/routes.ts",
    sourceText: source,
    diagnostics: [noPeerInconsistentHandler],
    capabilities: CAPS,
  }).findings.filter((f) => f.diagnostic === "no-peer-inconsistent-handler");

const fires = (source: string) => {
  const found = findings(source);
  assert.ok(found.length > 0, `expected a FIRE on:\n${source}`);
  return found;
};

const silent = (source: string): void => {
  const found = findings(source);
  assert.equal(
    found.length,
    0,
    `expected SILENCE, got ${found.length}:\n${found.map((f) => `  - ${f.message}`).join("\n")}\n--- source ---\n${source}`,
  );
};

const EXPRESS = `import express, { Router } from "express";\nimport asyncHandler from "express-async-handler";\n`;

/** n wrapped routes on `receiver`. */
const wrapped = (n: number, receiver = "router"): string =>
  Array.from(
    { length: n },
    (_, i) => `${receiver}.get("/w${i}", asyncHandler(async (req, res) => res.json(${i})));`,
  ).join("\n");

/** A proven Express router with n wrapped routes, plus extra lines. */
const router = (n: number, extra = ""): string =>
  `${EXPRESS}const router = Router();\n${wrapped(n)}` + (extra ? `\n${extra}` : "");

describe("no-peer-inconsistent-handler — fires", () => {
  test("one bare async handler among a wrapped majority", () => {
    const [f] = fires(router(19, `router.get("/audit", async (req, res) => res.json(1));`));
    assert.match(f!.message, /19 of 20 routes/);
    assert.match(f!.message, /`asyncHandler`/);
    assert.match(f!.message, /`\/audit`/);
  });

  test("an `express()` app is a router too", () => {
    fires(`${EXPRESS}const app = express();\n${wrapped(19, "app")}\napp.post("/audit", async (req, res) => res.json(1));`);
  });

  test("every route verb counts toward the same group", () => {
    fires(
      `${EXPRESS}const router = Router();\n` +
        Array.from({ length: 19 }, (_, i) => `router.post("/w${i}", wrap(async (req, res) => res.json(${i})));`).join("\n") +
        `\nrouter.delete("/x", async (req, res) => res.json(1));`,
    );
  });

  test("each deviant is reported", () => {
    const found = fires(
      router(18, `router.get("/a", async (req, res) => res.json(1));\nrouter.get("/b", async (req, res) => res.json(2));`),
    );
    assert.equal(found.length, 2);
  });
});

describe("no-peer-inconsistent-handler — the population must be a PROVEN router", () => {
  test("separate factories that reuse the name `router` are separate populations", () => {
    // The worst finding the hunt produced: four factories, none with enough
    // routes to qualify, merged into one fabricated population of ten.
    silent(
      EXPRESS +
        ["usersRouter", "ordersRouter", "billingRouter"]
          .map((f) => `export function ${f}() {\n const router = Router();\n${wrapped(3)}\n return router;\n}`)
          .join("\n") +
        `\nexport function statusRouter() {\n const router = Router();\n router.get("/status", async (req, res) => res.json(1));\n return router;\n}`,
    );
  });

  test("two routers with the same local name never merge", () => {
    silent(
      `${EXPRESS}export function a() { const router = Router();\n${wrapped(9)}\n return router; }\n` +
        `export function b() { const router = Router();\n router.get("/healthz", async (req, res) => res.json(1));\n return router; }`,
    );
  });

  test("sibling routers on a namespace object are not one receiver", () => {
    silent(
      `${EXPRESS}const api = { v1: Router(), v2: Router() };\n${wrapped(9, "api.v1")}\n` +
        `api.v2.get("/metrics", async (req, res) => res.json(1));`,
    );
  });

  test("a receiver that is not a proven Express router is never judged", () => {
    // Koa, Fastify, an HTTP client, a cache — all have a `.get(path, fn)` shape.
    silent(`const router = makeRouter();\n${wrapped(9)}\nrouter.get("/x", async (req, res) => res.json(1));`);
    silent(
      `import got from "got";\nconst client = got.extend({});\n${wrapped(9, "client")}\n` +
        `client.get("/v1/health", async (r) => r.body);`,
    );
  });

  test("a chained `router.route(p).get(h)` has no identifier receiver", () => {
    silent(router(9, `router.route("/x").get(async (req, res) => res.json(1));`));
  });

  test("`this.get(...)` has no binding to group by", () => {
    silent(router(19, `class C { init() { this.get("/x", async (req, res) => res.json(1)); } }`));
  });
});

describe("no-peer-inconsistent-handler — the wrapper must be a wrapper", () => {
  test("a handler FACTORY is not an error wrapper", () => {
    // `makeHandler(db, path)` produces the handler rather than wrapping one —
    // a perfectly good convention that used to produce a wall of findings.
    silent(
      `${EXPRESS}const router = Router();\n` +
        Array.from({ length: 9 }, (_, i) => `router.get("/a${i}", makeHandler(db, "${i}"));`).join("\n") +
        `\nrouter.get("/x", async (req, res) => res.json(1));`,
    );
  });

  test("a decorator taking options is not a wrapper either", () => {
    silent(
      `${EXPRESS}const router = Router();\n` +
        Array.from({ length: 9 }, (_, i) => `router.get("/a${i}", cache(60)(async (req, res) => res.json(${i})));`).join("\n") +
        `\nrouter.get("/x", async (req, res) => res.json(1));`,
    );
  });

  test("a member-path wrapper is not a plainly-named one", () => {
    silent(
      `${EXPRESS}const router = Router();\n` +
        Array.from({ length: 9 }, (_, i) => `router.get("/a${i}", wrappers.async(async (req, res) => res.json(${i})));`).join("\n") +
        `\nrouter.get("/x", async (req, res) => res.json(1));`,
    );
  });

  test("two competing wrappers are not one convention", () => {
    silent(
      router(9) +
        `\nrouter.get("/b", catchAsync(async (req, res) => res.json(1)));` +
        `\nrouter.get("/c", async (req, res) => res.json(1));`,
    );
  });
});

describe("no-peer-inconsistent-handler — legitimate outliers", () => {
  test("a SYNCHRONOUS handler cannot reject, so it needs no wrapper", () => {
    silent(router(19, `router.get("/ping", (req, res) => res.send("ok"));`));
    silent(router(19, `router.get("/health", function (req, res) { res.json({ ok: true }); });`));
  });

  test("a handler that catches everything it can throw cannot reject", () => {
    // The webhook receiver that must always answer 200, and the handler that
    // calls `next(err)` itself. The rejection claim is false for both.
    silent(
      router(9, `router.post("/stripe-webhook", async (req, res, next) => { try { await handle(req.body); res.json({ ok: true }); } catch (err) { next(err); } });`),
    );
  });

  test("a bare IDENTIFIER handler may be wrapped where it is defined", () => {
    silent(router(19, `router.get("/audit", listAudit);`));
    silent(router(19, `router.get("/audit", handlers.audit);`));
  });
});

describe("no-peer-inconsistent-handler — thresholds", () => {
  test("a group below the minimum says nothing", () => {
    // At 90% conformity a group of 5 could never produce a deviant anyway.
    silent(router(4, `router.get("/x", async (req, res) => res.json(1));`));
    silent(router(8, `router.get("/x", async (req, res) => res.json(1));`));
  });

  test("the minimum group size is honoured exactly", () => {
    silent(router(8, `router.get("/x", async (req, res) => res.json(1));`));
    fires(router(9, `router.get("/x", async (req, res) => res.json(1));`));
  });

  test("a split convention is a migration, not a mistake", () => {
    silent(
      router(6) +
        "\n" +
        Array.from({ length: 4 }, (_, i) => `router.get("/b${i}", async (req, res) => res.json(${i}));`).join("\n"),
    );
  });

  test("all-wrapped and none-wrapped both have nothing to say", () => {
    silent(router(20));
    silent(
      `${EXPRESS}const router = Router();\n` +
        Array.from({ length: 20 }, (_, i) => `router.get("/a${i}", async (req, res) => res.json(${i}));`).join("\n"),
    );
  });

  test("a dynamic route path is not a registration this can group", () => {
    silent(router(19, `router.get(pathFor("audit"), async (req, res) => res.json(1));`));
  });
});

describe("no-peer-inconsistent-handler — determinism", () => {
  test("identical source yields identical findings", () => {
    const source = router(18, `router.get("/a", async (req, res) => res.json(1));\nrouter.get("/b", async (req, res) => res.json(2));`);
    assert.equal(JSON.stringify(findings(source)), JSON.stringify(findings(source)));
  });
});
