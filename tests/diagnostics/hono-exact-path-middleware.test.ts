/**
 * `no-hono-exact-path-middleware`.
 *
 * Express's `app.use(path, …)` is a PREFIX mount; Hono's `use()` takes an
 * ordinary route pattern. The two read identically and behave differently.
 *
 * MEASURED — the same middleware and routes on both frameworks, requested
 * without the required header so a guarded route must answer 401:
 *
 *   Hono 4.13.5    use("/admin")    GET /admin              → 401 guarded
 *                                   GET /admin/users        → 200 UNGUARDED
 *                                   GET /admin/users/1/keys → 200 UNGUARDED
 *                  use("/admin/*")  all three               → 401 guarded
 *   Express 5.2.1  use("/admin")    GET /admin/users        → 401 guarded
 *                                   GET /admin/users/1/keys → 401 guarded
 *
 * A mounted sub-app does not change it: `use("/admin", auth)` followed by
 * `route("/admin", adminRoutes)` leaves `/admin/users` answering 200, while
 * `use("/admin/*", auth)` guards it.
 *
 * Nothing errors and the guarded parent path behaves exactly as intended, so a
 * smoke test of `/admin` passes while every page under it is open.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noHonoExactPathMiddleware } from "../../src/diagnostics/frameworks/no-hono-exact-path-middleware.ts";

const CAPS = new Set(["node", "esm", "typescript", "hono"]);
const HONO = `import { Hono } from "hono";\nconst app = new Hono();\n`;

const findings = (source: string) =>
  lintSource({
    filePath: "/repo/src/app.ts",
    sourceText: source,
    diagnostics: [noHonoExactPathMiddleware],
    capabilities: CAPS,
  }).findings.filter((f) => f.diagnostic === "no-hono-exact-path-middleware");

const fires = (source: string) => {
  const found = findings(source);
  assert.ok(found.length > 0, `expected a FIRE on:\n${source}`);
  return found;
};
const silent = (source: string): void =>
  assert.equal(findings(source).length, 0, `expected SILENCE on:\n${source}`);

describe("no-hono-exact-path-middleware", () => {
  describe("the defect", () => {
    test("a child route registered beneath the mount", () => {
      fires(`${HONO}app.use("/admin", requireAdmin);\napp.get("/admin/users", listUsers);`);
    });

    test("a mounted sub-app, which is equally unguarded", () => {
      // Measured: use("/admin") + route("/admin", sub) leaves /admin/users at 200.
      fires(`${HONO}app.use("/admin", requireAdmin);\napp.route("/admin", adminRoutes);`);
    });

    test("a deeply nested child", () => {
      fires(`${HONO}app.use("/api/v1", auth);\napp.get("/api/v1/users/:id/keys", keys);`);
    });

    test("the message contrasts the two frameworks and names the fix", () => {
      const [found] = fires(`${HONO}app.use("/admin", requireAdmin);\napp.get("/admin/users", listUsers);`);
      assert.match(found!.message, /nothing beneath it/);
      assert.match(found!.message, /200, unguarded/);
      assert.match(found!.message, /use\("\/admin\/\*"/);
      assert.match(found!.recommendation ?? "", /Express's `app\.use\(path/);
    });
  });

  describe("silence — the mount already covers its children", () => {
    test("a trailing wildcard", () => {
      silent(`${HONO}app.use("/admin/*", requireAdmin);\napp.get("/admin/users", listUsers);`);
    });

    test("a bare wildcard, and no path at all", () => {
      silent(`${HONO}app.use("*", requireAdmin);\napp.get("/admin/users", listUsers);`);
      silent(`${HONO}app.use(requireAdmin);\napp.get("/admin/users", listUsers);`);
    });
  });

  describe("silence — nothing is proven to be underneath", () => {
    test("the mounted path is the only route there is", () => {
      silent(`${HONO}app.use("/admin", requireAdmin);\napp.get("/admin", adminPage);`);
    });

    test("child routes in another file — the documented recall gap", () => {
      // Under-reports rather than guessing, which is the accepted direction.
      silent(`${HONO}app.use("/admin", requireAdmin);`);
    });

    test("a sibling path is not a child", () => {
      silent(`${HONO}app.use("/admin", requireAdmin);\napp.get("/administrators", list);`);
    });
  });

  describe("precision guards — it must be a Hono app", () => {
    test("an Express app in a Hono project, where this spelling is CORRECT", () => {
      // The `hono` capability is project-wide, so without the receiver check
      // this would report the framework on which the code is right.
      silent(`import express from "express";\nconst app = express();\napp.use("/admin", auth);\napp.get("/admin/users", list);`);
    });

    test("a receiver that is not a `new Hono()` binding", () => {
      silent(`${HONO}router.use("/admin", auth);\nrouter.get("/admin/users", list);`);
    });

    test("no hono import at all", () => {
      silent(`const app = new Hono();\napp.use("/admin", auth);\napp.get("/admin/users", list);`);
    });

    test("a non-literal path cannot be compared", () => {
      silent(`${HONO}app.use(prefix, auth);\napp.get("/admin/users", list);`);
    });

    test("an OpenAPIHono app still counts", () => {
      silent(
        `import { OpenAPIHono } from "@hono/zod-openapi";\nconst app = new OpenAPIHono();\napp.use("/admin/*", auth);\napp.get("/admin/users", list);`,
      );
      fires(
        `import { OpenAPIHono } from "@hono/zod-openapi";\nconst app = new OpenAPIHono();\napp.use("/admin", auth);\napp.get("/admin/users", list);`,
      );
    });
  });
});
