/**
 * Framework-specific diagnostics (hapi, restify).
 *
 * These live in a bucket the generated registry may not know about yet, so the
 * diagnostics are imported directly rather than through `tests/helpers.ts`
 * (which resolves ids against `DIAGNOSTICS_BY_ID`). Capability gating is applied
 * here exactly as the real selector applies it, so the "silent without the
 * capability" assertions are meaningful.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { capabilitiesSatisfied } from "../../src/core/project.ts";
import type { Diagnostic, Finding } from "../../src/core/types.ts";
import { hapiRouteMissingValidation } from "../../src/diagnostics/frameworks/hapi-route-missing-validation.ts";
import { hapiRouteAuthDisabled } from "../../src/diagnostics/frameworks/hapi-route-auth-disabled.ts";
import { restifyMissingErrorHandler } from "../../src/diagnostics/frameworks/restify-missing-error-handler.ts";

const findings = (diagnostic: Diagnostic, source: string, caps?: string[]): Finding[] => {
  const capabilities = new Set(["node", "esm", ...(caps ?? diagnostic.requires ?? [])]);
  // Mirror the real selector: an unsatisfied gate means the diagnostic never runs.
  if (!capabilitiesSatisfied(diagnostic, capabilities)) return [];
  return lintSource({
    filePath: "server.ts",
    sourceText: source,
    diagnostics: [diagnostic],
    capabilities,
  }).findings.filter((f) => f.diagnostic === diagnostic.id);
};

const fires = (diagnostic: Diagnostic, source: string, count = 1, caps?: string[]): void => {
  const found = findings(diagnostic, source, caps);
  assert.equal(
    found.length,
    count,
    `expected ${diagnostic.id} to fire ${count}x, got ${found.length}:\n${source}`,
  );
};

const silent = (diagnostic: Diagnostic, source: string, caps?: string[]): void => {
  const found = findings(diagnostic, source, caps);
  assert.equal(
    found.length,
    0,
    `expected ${diagnostic.id} to stay SILENT, got ${found.length}:\n` +
      found.map((f) => `  - ${f.line}:${f.column} ${f.message}`).join("\n") +
      `\n--- source ---\n${source}`,
  );
};

// ---------------------------------------------------------------------------
// hapi-route-missing-validation
// ---------------------------------------------------------------------------

describe("hapi-route-missing-validation", () => {
  test("fires on a POST route with no options at all", () => {
    fires(hapiRouteMissingValidation, `server.route({ method: "POST", path: "/users", handler: create });`);
  });
  test("fires on PUT and PATCH", () => {
    fires(hapiRouteMissingValidation, `server.route({ method: "PUT", path: "/users/{id}", handler: update });`);
    fires(hapiRouteMissingValidation, `server.route({ method: "PATCH", path: "/users/{id}", options: { tags: ["api"] }, handler: patch });`);
  });
  test("fires once per route in the array form", () => {
    fires(
      hapiRouteMissingValidation,
      `server.route([{ method: "POST", path: "/a", handler: a }, { method: "POST", path: "/b", handler: b }]);`,
      2,
    );
  });
  test("fires when the handler lives inside options", () => {
    fires(hapiRouteMissingValidation, `server.route({ method: "POST", path: "/a", options: { handler: a, tags: ["api"] } });`);
  });
  test("fires when every method in the array carries a payload", () => {
    fires(hapiRouteMissingValidation, `server.route({ method: ["POST", "PUT"], path: "/u", handler: h });`);
  });

  test("silent on GET and HEAD — nothing to validate", () => {
    silent(hapiRouteMissingValidation, `server.route({ method: "GET", path: "/users", handler: list });`);
    silent(hapiRouteMissingValidation, `server.route({ method: "HEAD", path: "/users", handler: head });`);
  });
  test("silent on DELETE — no payload by convention", () => {
    silent(hapiRouteMissingValidation, `server.route({ method: "DELETE", path: "/users/{id}", handler: del });`);
  });
  test("silent on the wildcard method — it also serves GET", () => {
    silent(hapiRouteMissingValidation, `server.route({ method: "*", path: "/{p*}", handler: any });`);
  });
  test("silent on a mixed method array containing GET", () => {
    silent(hapiRouteMissingValidation, `server.route({ method: ["GET", "POST"], path: "/u", handler: h });`);
  });
  test("silent when options.validate is present", () => {
    silent(hapiRouteMissingValidation, `server.route({ method: "POST", path: "/u", options: { validate: { payload: S } }, handler: h });`);
  });
  test("silent when the legacy config.validate is present", () => {
    silent(hapiRouteMissingValidation, `server.route({ method: "POST", path: "/u", config: { validate: { payload: S } }, handler: h });`);
  });
  test("silent when options are not a literal object", () => {
    silent(hapiRouteMissingValidation, `server.route({ method: "POST", path: "/u", options: sharedOptions, handler: h });`);
    silent(hapiRouteMissingValidation, `server.route({ method: "POST", path: "/u", options: { ...base }, handler: h });`);
    silent(hapiRouteMissingValidation, `server.route({ ...base, method: "POST", path: "/u", handler: h });`);
  });
  test("silent on a raw payload — a signed webhook or a stream upload", () => {
    silent(hapiRouteMissingValidation, `server.route({ method: "POST", path: "/hooks", options: { payload: { parse: false } }, handler: hook });`);
    silent(hapiRouteMissingValidation, `server.route({ method: "POST", path: "/upload", options: { payload: { output: "stream" } }, handler: up });`);
  });
  test("silent when the method is not statically known", () => {
    silent(hapiRouteMissingValidation, `server.route({ method: verb, path: "/u", handler: h });`);
  });
  test("silent when the routes come from elsewhere", () => {
    silent(hapiRouteMissingValidation, `server.route(routes);`);
  });
  test("silent on a Fastify route object (url, not path)", () => {
    silent(hapiRouteMissingValidation, `fastify.route({ method: "POST", url: "/u", handler: h });`);
  });
  test("silent on a non-route call with a similar options shape", () => {
    silent(hapiRouteMissingValidation, `client.request({ method: "POST", path: "/u", handler: h });`);
  });
  test("silent without the hapi capability", () => {
    silent(hapiRouteMissingValidation, `server.route({ method: "POST", path: "/users", handler: create });`, ["node", "esm", "express"]);
  });
});

// ---------------------------------------------------------------------------
// hapi-route-auth-disabled
// ---------------------------------------------------------------------------

describe("hapi-route-auth-disabled", () => {
  test("fires on POST with auth: false", () => {
    fires(hapiRouteAuthDisabled, `server.route({ method: "POST", path: "/admin/users", options: { auth: false }, handler: h });`);
  });
  test("fires on DELETE with auth: false", () => {
    fires(hapiRouteAuthDisabled, `server.route({ method: "DELETE", path: "/orders/{id}", options: { auth: false }, handler: h });`);
  });
  test("fires through the legacy config key", () => {
    fires(hapiRouteAuthDisabled, `server.route({ method: "PUT", path: "/admin/flags", config: { auth: false }, handler: h });`);
  });

  test("silent on GET — reads are not state changes", () => {
    silent(hapiRouteAuthDisabled, `server.route({ method: "GET", path: "/admin/users", options: { auth: false }, handler: h });`);
  });
  test("silent on paths that are legitimately public", () => {
    for (const path of ["/login", "/register", "/health", "/metrics", "/webhooks/stripe", "/auth/token", "/reset-password"]) {
      silent(hapiRouteAuthDisabled, `server.route({ method: "POST", path: ${JSON.stringify(path)}, options: { auth: false }, handler: h });`);
    }
  });
  test("silent when auth names a strategy or a mode", () => {
    silent(hapiRouteAuthDisabled, `server.route({ method: "POST", path: "/admin", options: { auth: "jwt" }, handler: h });`);
    silent(hapiRouteAuthDisabled, `server.route({ method: "POST", path: "/admin", options: { auth: { mode: "try" } }, handler: h });`);
  });
  test("silent when the route says nothing about auth", () => {
    silent(hapiRouteAuthDisabled, `server.route({ method: "POST", path: "/admin", options: { validate: { payload: S } }, handler: h });`);
  });
  test("silent when the path is built dynamically", () => {
    silent(hapiRouteAuthDisabled, `server.route({ method: "POST", path: prefix + "/x", options: { auth: false }, handler: h });`);
  });
  test("silent without the hapi capability", () => {
    silent(
      hapiRouteAuthDisabled,
      `server.route({ method: "POST", path: "/admin/users", options: { auth: false }, handler: h });`,
      ["node", "esm", "express"],
    );
  });
});

// ---------------------------------------------------------------------------
// restify-missing-error-handler
// ---------------------------------------------------------------------------

const RESTIFY_BARE = `const restify = require("restify");
const server = restify.createServer({ name: "api" });
server.post("/orders", createOrder);
server.listen(8080);`;

describe("restify-missing-error-handler", () => {
  test("fires on a CommonJS server created and listened on with no wiring", () => {
    fires(restifyMissingErrorHandler, RESTIFY_BARE);
  });
  test("fires on the ESM default import", () => {
    fires(
      restifyMissingErrorHandler,
      `import restify from "restify";
       const app = restify.createServer();
       app.get("/", h);
       app.listen(3000, () => {});`,
    );
  });
  test("fires on a named createServer import", () => {
    fires(
      restifyMissingErrorHandler,
      `import { createServer } from "restify";
       const server = createServer();
       server.listen(3000);`,
    );
  });
  test("fires on a destructured require", () => {
    fires(
      restifyMissingErrorHandler,
      `const { createServer } = require("restify");
       const s = createServer();
       s.listen(1);`,
    );
  });
  test("fires when the only listener is a non-error event", () => {
    fires(
      restifyMissingErrorHandler,
      `import restify from "restify";
       const server = restify.createServer();
       server.on("after", audit);
       server.listen(1);`,
    );
  });

  test("silent when restifyError is wired", () => {
    silent(
      restifyMissingErrorHandler,
      `const restify = require("restify");
       const server = restify.createServer();
       server.on("restifyError", (req, res, err, cb) => cb());
       server.listen(8080);`,
    );
  });
  test("silent when uncaughtException is wired", () => {
    silent(
      restifyMissingErrorHandler,
      `import restify from "restify";
       const server = restify.createServer();
       server.on("uncaughtException", (req, res, route, err) => res.send(500));
       server.listen(8080);`,
    );
  });
  test("silent for restify's per-error-class events", () => {
    for (const event of ["InternalServer", "NotFound", "MethodNotAllowed", "BadRequestError"]) {
      silent(
        restifyMissingErrorHandler,
        `import restify from "restify";
         const server = restify.createServer();
         server.on(${JSON.stringify(event)}, h);
         server.listen(8080);`,
      );
    }
  });
  test("silent when the event name is not statically known", () => {
    silent(
      restifyMissingErrorHandler,
      `import restify from "restify";
       const server = restify.createServer();
       server.on(EVENT, h);
       server.listen(1);`,
    );
  });
  test("silent when the server is never listened on in this file", () => {
    silent(
      restifyMissingErrorHandler,
      `import restify from "restify";
       const server = restify.createServer();
       export default server;`,
    );
  });
  test("silent when the server is handed to another function", () => {
    silent(
      restifyMissingErrorHandler,
      `import restify from "restify";
       const server = restify.createServer();
       registerErrorHandlers(server);
       server.listen(8080);`,
    );
  });
  test("silent when the server is exported", () => {
    silent(
      restifyMissingErrorHandler,
      `const restify = require("restify");
       const server = restify.createServer();
       server.listen(8080);
       module.exports = server;`,
    );
  });
  test("silent on a node:http server that merely shares the method name", () => {
    silent(
      restifyMissingErrorHandler,
      `import http from "node:http";
       const server = http.createServer();
       server.listen(8080);`,
    );
  });
  test("silent without the restify capability", () => {
    silent(restifyMissingErrorHandler, RESTIFY_BARE, ["node", "esm", "express"]);
  });
});

// ---------------------------------------------------------------------------
// Determinism — identical input must produce byte-identical output.
// ---------------------------------------------------------------------------

describe("frameworks diagnostics are deterministic", () => {
  test("repeated runs emit identical findings", () => {
    const source = `const restify = require("restify");
      const a = restify.createServer();
      const b = restify.createServer();
      a.listen(1);
      b.listen(2);`;
    const once = JSON.stringify(findings(restifyMissingErrorHandler, source));
    for (let i = 0; i < 3; i++) {
      assert.equal(JSON.stringify(findings(restifyMissingErrorHandler, source)), once);
    }
    assert.equal(findings(restifyMissingErrorHandler, source).length, 2);
  });
});
