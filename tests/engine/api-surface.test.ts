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

// ---------------------------------------------------------------------------
// AdonisJS and NestJS — the two frameworks the surface used to report ZERO
// routes for. Every expectation below was MEASURED against the real
// @adonisjs/core 6.21.0 router by registering routes into it and reading back
// what it committed, rather than taken from documentation.
// ---------------------------------------------------------------------------

describe("extractRoutes — AdonisJS", () => {
  test("the controller tuple is the handler, not a dropped argument", () => {
    // `middlewareName` returned null for an ArrayExpression, so the whole route
    // was discarded — which is how the surface came to report zero routes.
    const [r] = routesOf('router.get("/users/:id", [UsersController, "show"]);');
    assert.equal(r!.method, "GET");
    assert.equal(r!.path, "/users/:id");
    assert.deepEqual(r!.middleware, ["UsersController.show"]);
  });

  test("resource() expands to the seven routes the router commits", () => {
    const routes = sortRoutes(routesOf('router.resource("/users", UsersController);'));
    assert.deepEqual(routes.map((r) => `${r.method} ${r.path}`).sort(), [
      "DELETE /users/:id",
      "GET /users",
      "GET /users/:id",
      "GET /users/:id/edit",
      "GET /users/create",
      "POST /users",
      "PUT /users/:id",
    ]);
    assert.ok(routes.every((r) => r.middleware.some((m) => m.startsWith("UsersController."))));
  });

  test("apiOnly() drops create and edit, leaving five", () => {
    const routes = routesOf('router.resource("/users", UsersController).apiOnly();');
    assert.equal(routes.length, 5);
    assert.ok(!routes.some((r) => r.path.endsWith("/create") || r.path.endsWith("/edit")));
  });

  test("nested group prefixes compose outermost-first", () => {
    const routes = routesOf(
      'router.group(() => { router.group(() => { router.get("/x", [C, "x"]); }).prefix("/v2"); }).prefix("/api");',
    );
    assert.equal(routes[0]!.path, "/api/v2/x");
  });

  test("a group's chained guard protects every route inside it", () => {
    const routes = routesOf(
      'router.group(() => { router.get("/me", [C, "me"]); }).prefix("/api").use(middleware.auth());',
    );
    assert.equal(routes[0]!.path, "/api/me");
    assert.ok(routes[0]!.middleware.includes("middleware.auth"));
    assert.equal(routes[0]!.authenticated, true);
  });

  test("a route outside any group keeps its own path", () => {
    const routes = routesOf('router.group(() => { router.get("/in", [C, "a"]); }).prefix("/api");\nrouter.get("/out", [C, "b"]);');
    assert.deepEqual(sortRoutes(routes).map((r) => r.path), ["/api/in", "/out"]);
  });
});

describe("extractRoutes — NestJS", () => {
  const nest = `
@Controller("users")
export class UsersController {
  @Get() index() { return []; }
  @Get(":id") show(id) { return id; }
  @Post() @UseGuards(JwtAuthGuard) store(b) { return b; }
}
@Controller("admin")
@UseGuards(JwtAuthGuard)
export class AdminController {
  @Delete(":id") destroy(id) { return id; }
}`;

  test("decorators register routes, with the controller prefix joined", () => {
    const routes = sortRoutes(routesOf(nest));
    assert.deepEqual(routes.map((r) => `${r.method} ${r.path}`).sort(), [
      "DELETE /admin/:id",
      "GET /users",
      "GET /users/:id",
      "POST /users",
    ]);
  });

  test("the handler method name is the chain's last entry", () => {
    const routes = routesOf(nest);
    assert.ok(routes.some((r) => r.middleware.includes("index")));
    assert.ok(routes.some((r) => r.middleware.includes("destroy")));
  });

  test("@UseGuards marks a route authenticated, on the method or the class", () => {
    const routes = sortRoutes(routesOf(nest));
    const byKey = new Map(routes.map((r) => [`${r.method} ${r.path}`, r]));
    // camelCase must be split before the segment-aware hint pattern is applied,
    // or `JwtAuthGuard` reads as unauthenticated — the expensive direction.
    assert.equal(byKey.get("POST /users")!.authenticated, true);
    assert.equal(byKey.get("DELETE /admin/:id")!.authenticated, true);
    assert.equal(byKey.get("GET /users")!.authenticated, false);
  });

  test("a bare @Get() on a prefixless controller is the root path", () => {
    const routes = routesOf('@Controller() export class A { @Get() ping() { return 1; } }');
    assert.equal(routes[0]!.path, "/");
  });

  test("a class with no @Controller is not a route source", () => {
    assert.equal(routesOf('export class Service { @Get() helper() { return 1; } }').length, 0);
  });
});

describe("extractRoutes — hapi declares auth on the route object", () => {
  test("`auth: \"jwt\"` at either nesting level marks the route guarded", () => {
    const flat = routesOf('server.route({ method: "POST", path: "/users", auth: "jwt", handler: create });');
    assert.equal(flat[0]!.authenticated, true);
    const nested = routesOf('server.route({ method: "POST", path: "/users", options: { auth: "session" }, handler: create });');
    assert.equal(nested[0]!.authenticated, true);
    const config = routesOf('server.route({ method: "GET", path: "/me", config: { auth: { strategy: "jwt" } }, handler: me });');
    assert.equal(config[0]!.authenticated, true);
  });

  test("a route with no auth declaration stays unguarded", () => {
    const [r] = routesOf('server.route({ method: "GET", path: "/health", handler: ok });');
    assert.equal(r!.authenticated, false);
  });
});

describe("auth posture — the camelCase repair that had to be narrowed", () => {
  test("a NestJS guard with no separators is recognized", () => {
    for (const guard of ["JwtAuthGuard", "AuthGuard", "RolesGuard", "PassportStrategy", "BearerGuard"]) {
      const [r] = routesOf(`@Controller("x") class C { @Get() @UseGuards(${guard}) a() {} }`);
      assert.equal(r!.authenticated, true, `${guard} should read as a guard`);
    }
  });

  test("an ordinary handler name that merely contains an AUTH_HINT word does not", () => {
    // The first repair split camelCase before applying AUTH_HINT, which contains
    // `admin`, `role`, `can`, `login` and `session` — so these all started
    // reading as guards and a removed guard stopped being reported.
    for (const handler of ["adminPage", "canDelete", "loginPage", "sessionList", "roleList"]) {
      const [r] = routesOf(`app.get("/x", ${handler});`);
      assert.equal(r!.authenticated, false, `${handler} is a handler, not a guard`);
    }
  });
});
