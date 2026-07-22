import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseSource } from "../../src/core/parse.ts";
import { createLocator } from "../../src/core/location.ts";
import { attachParents } from "../../src/core/walk.ts";
import {
  extractRoutes,
  buildApiSurface,
  diffApiSurface,
  sortRoutes,
  routeKey,
  type RouteEntry,
} from "../../src/core/api-surface.ts";

const routesOf = (src: string): RouteEntry[] => {
  const parsed = parseSource("routes.ts", src);
  attachParents(parsed.program);
  return extractRoutes(parsed.program, "routes.ts", createLocator(src));
};

// ---------------------------------------------------------------------------
// §70 — extraction + auth posture
// ---------------------------------------------------------------------------

describe("extractRoutes", () => {
  test("extracts method, path, guard chain, and location", () => {
    const [r] = routesOf('app.get("/admin/users", requireAuth, listUsers);');
    assert.equal(r!.method, "GET");
    assert.equal(r!.path, "/admin/users");
    assert.deepEqual(r!.middleware, ["requireAuth", "listUsers"]);
    assert.equal(r!.authenticated, true);
    assert.equal(r!.line, 1);
  });

  test("normalizes `del` to DELETE", () => {
    assert.equal(routesOf('router.del("/x", h);')[0]!.method, "DELETE");
  });

  test("recognizes call- and member-form guards", () => {
    const [a] = routesOf('app.post("/o", passport.authenticate("jwt"), create);');
    assert.equal(a!.authenticated, true);
    assert.deepEqual(a!.middleware, ["passport.authenticate", "create"]);
    const [b] = routesOf('app.get("/p", auth.required, show);');
    assert.equal(b!.authenticated, true);
  });

  test("a route with no guard is unauthenticated", () => {
    const [r] = routesOf('app.get("/health", ok);');
    assert.equal(r!.authenticated, false);
  });

  test("fastify object-route form", () => {
    const [r] = routesOf('fastify.route({ method: "PUT", url: "/cfg", preHandler: verifyToken, handler: setCfg });');
    assert.equal(r!.method, "PUT");
    assert.equal(r!.path, "/cfg");
    assert.equal(r!.authenticated, true);
  });

  // The precision cases: these look like routes but are not.
  test("map/cache lookups are NOT routes", () => {
    assert.equal(routesOf("cache.get(key);").length, 0);
    assert.equal(routesOf('map.delete("x");').length, 0);
    assert.equal(routesOf("store.get(a, b);").length, 0, "two args still is not a route without a string path");
  });

  test("a bare-variable path is deliberately not recorded (indistinguishable from a lookup)", () => {
    assert.equal(routesOf("app.get(buildPath(), handler);").length, 0);
  });

  test("a template-literal path is recorded as <dynamic>", () => {
    const [r] = routesOf("app.get(`/users/${id}`, handler);");
    assert.equal(r!.path, "<dynamic>");
  });

  test("a route registration with no handler argument is not a route", () => {
    assert.equal(routesOf('app.get("/x");').length, 0);
  });
});

describe("buildApiSurface", () => {
  test("separates unauthenticated routes and sorts deterministically", () => {
    const src = [
      'app.get("/health", ok);',
      'app.get("/admin", requireAuth, adminPage);',
      'app.delete("/items/:id", removeItem);',
    ].join("\n");
    const s = buildApiSurface(routesOf(src));
    assert.equal(s.routes.length, 3);
    assert.equal(s.unauthenticated.length, 2);
    assert.deepEqual(
      s.routes.map((r) => r.path),
      ["/admin", "/health", "/items/:id"],
      "sorted by path",
    );
    const again = buildApiSurface(routesOf(src));
    assert.deepEqual(s.routes.map(routeKey), again.routes.map(routeKey));
  });
});

// ---------------------------------------------------------------------------
// §78 — breaking-change detection
// ---------------------------------------------------------------------------

describe("diffApiSurface", () => {
  const base = routesOf(
    ['app.get("/health", ok);', 'app.get("/admin", requireAuth, adminPage);', 'app.delete("/items/:id", removeItem);'].join("\n"),
  );

  test("a removed route is breaking", () => {
    const now = routesOf(['app.get("/health", ok);', 'app.get("/admin", requireAuth, adminPage);'].join("\n"));
    const changes = diffApiSurface(base, now);
    const removed = changes.find((c) => c.kind === "removed-route");
    assert.ok(removed);
    assert.equal(removed!.route, "DELETE /items/:id");
    assert.equal(removed!.breaking, true);
  });

  test("newly requiring auth is breaking for existing consumers", () => {
    const now = routesOf(
      ['app.get("/health", requireAuth, ok);', 'app.get("/admin", requireAuth, adminPage);', 'app.delete("/items/:id", removeItem);'].join("\n"),
    );
    const changes = diffApiSurface(base, now);
    const added = changes.find((c) => c.kind === "auth-added");
    assert.ok(added);
    assert.equal(added!.route, "GET /health");
    assert.equal(added!.breaking, true);
  });

  test("removing an auth guard is reported but not breaking for consumers", () => {
    const now = routesOf(
      ['app.get("/health", ok);', 'app.get("/admin", adminPage);', 'app.delete("/items/:id", removeItem);'].join("\n"),
    );
    const changes = diffApiSurface(base, now);
    const relaxed = changes.find((c) => c.kind === "auth-removed");
    assert.ok(relaxed);
    assert.equal(relaxed!.breaking, false, "consumers keep working — but it warrants review");
  });

  test("an added route is not breaking", () => {
    const now = routesOf(
      [
        'app.get("/health", ok);',
        'app.get("/admin", requireAuth, adminPage);',
        'app.delete("/items/:id", removeItem);',
        'app.get("/new", handler);',
      ].join("\n"),
    );
    assert.deepEqual(diffApiSurface(base, now), []);
  });

  test("no change → no diff", () => {
    assert.deepEqual(diffApiSurface(base, base), []);
  });

  test("diff output is deterministically ordered", () => {
    const now = routesOf('app.get("/admin", requireAuth, adminPage);');
    const a = diffApiSurface(base, now);
    const b = diffApiSurface(base, now);
    assert.deepEqual(a, b);
    assert.deepEqual(a.map((c) => c.route), [...a.map((c) => c.route)].sort());
  });
});

describe("sortRoutes", () => {
  test("is stable and total", () => {
    const rs = routesOf(['app.post("/a", h);', 'app.get("/a", h);', 'app.get("/b", h);'].join("\n"));
    assert.deepEqual(
      sortRoutes(rs).map(routeKey),
      ["GET /a", "POST /a", "GET /b"],
      "path first, then method",
    );
  });
});
