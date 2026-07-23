/**
 * §147 HTTP Caching & Privacy:
 *   - no-shared-cache-authenticated-response (Security, opt-in)
 *
 * Self-contained: the diagnostic is imported directly and linted with an
 * explicit diagnostic list, so these tests do not depend on the generated
 * registry (the rule is `defaultEnabled: false` and would otherwise not be
 * selected). Capabilities mirror an Express project so request-handler
 * detection runs. Each MUST-be-silent case is a precision guard for the exact
 * false positive the rule promises to avoid.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noSharedCacheAuthenticatedResponse } from "../../src/diagnostics/http/no-shared-cache-authenticated-response.ts";
import type { Diagnostic } from "../../src/core/types.ts";

const CAPS = new Set(["node", "esm", "express"]);

const findingsFor = (diagnostic: Diagnostic, source: string): number => {
  const { findings, parseFailed } = lintSource({
    filePath: "test.ts",
    sourceText: source,
    diagnostics: [diagnostic],
    capabilities: CAPS,
  });
  assert.ok(!parseFailed, `source failed to parse:\n${source}`);
  return findings.filter((f) => f.diagnostic === diagnostic.id).length;
};

const fires = (diagnostic: Diagnostic, source: string): void =>
  assert.ok(findingsFor(diagnostic, source) > 0, `expected ${diagnostic.id} to FIRE on:\n${source}`);

const silent = (diagnostic: Diagnostic, source: string): void =>
  assert.equal(findingsFor(diagnostic, source), 0, `expected ${diagnostic.id} to STAY SILENT on:\n${source}`);

describe("no-shared-cache-authenticated-response", () => {
  const D = noSharedCacheAuthenticatedResponse;

  // FIRES ------------------------------------------------------------------
  test("fires: express req.user + res.set public", () => {
    fires(
      D,
      `app.get("/me", (req, res) => { const u = req.user; res.set("Cache-Control", "public, max-age=60"); res.json(u); });`,
    );
  });
  test("fires: res.setHeader s-maxage + req.session serialized into the body", () => {
    fires(
      D,
      `app.get("/dash", (req, res) => { const s = req.session; res.setHeader("Cache-Control", "s-maxage=300"); res.json(s); });`,
    );
  });
  test("fires: object form res.set({ 'Cache-Control': 'public' }) + req.user", () => {
    fires(
      D,
      `app.get("/me", (req, res) => { const u = req.user; res.set({ "Cache-Control": "public, max-age=60" }); res.json(u); });`,
    );
  });
  test("fires: koa ctx.set public + ctx.session read", () => {
    fires(
      D,
      `router.get("/me", async (ctx) => { const s = ctx.session; ctx.set("Cache-Control", "public"); ctx.body = s; });`,
    );
  });
  test("fires: fastify reply.header public + request.user read", () => {
    fires(
      D,
      `fastify.get("/me", (request, reply) => { const u = request.user; reply.header("Cache-Control", "public, max-age=5"); reply.send(u); });`,
    );
  });
  test("fires: req.headers.authorization serialized into the body + res.set public", () => {
    fires(
      D,
      `app.get("/x", (req, res) => { res.set("Cache-Control", "public"); res.json({ token: req.headers.authorization }); });`,
    );
  });
  test("fires: req.get('authorization') reaches the body + res.set s-maxage", () => {
    fires(
      D,
      `app.get("/x", (req, res) => { const a = req.get("authorization"); res.set("Cache-Control", "s-maxage=60"); res.json(a); });`,
    );
  });
  test("fires: req.cookies serialized into the body + res.setHeader public", () => {
    fires(
      D,
      `app.get("/x", (req, res) => { const c = req.cookies; res.setHeader("Cache-Control", "public"); res.json(c); });`,
    );
  });
  test("fires: koa ctx.state.user serialized into ctx.body (idiomatic koa identity)", () => {
    fires(
      D,
      `router.get("/me", async (ctx) => { ctx.set("Cache-Control", "public, max-age=60"); ctx.body = { user: ctx.state.user }; });`,
    );
  });
  test("fires: destructured `const { user } = req` reaches the body", () => {
    fires(
      D,
      `app.get("/me", (req, res) => { const { user } = req; res.set("Cache-Control", "public, max-age=60"); res.json(user); });`,
    );
  });
  test("fires: signature-fallback handler (no registration) reading req.userId", () => {
    fires(
      D,
      `function handler(req, res) { const id = req.userId; res.set("Cache-Control", "public, max-age=10"); res.json({ id }); }`,
    );
  });
  test("fires: lowercase 'cache-control' header name still matches", () => {
    fires(
      D,
      `app.get("/x", (req, res) => { const u = req.currentUser; res.set("cache-control", "public"); res.json(u); });`,
    );
  });
  test("fires: res.status().set() chained receiver + req.auth in the body", () => {
    fires(
      D,
      `app.get("/x", (req, res) => { const a = req.auth; res.status(200).set("Cache-Control", "public, max-age=30"); res.json(a); });`,
    );
  });

  // MUST BE SILENT ---------------------------------------------------------
  // The identity must reach the RESPONSE BODY — an identity read used only to gate
  // access or validate a CSRF token does not personalize the payload.
  test("silent: identity read only gates access (401), body is a public catalog", () => {
    silent(
      D,
      `app.get("/catalog", (req, res) => { if (!req.user) return res.sendStatus(401); res.set("Cache-Control", "public, max-age=3600"); res.json(PUBLIC_CATALOG); });`,
    );
  });
  test("silent: CSRF cookie read only, public asset manifest in the body", () => {
    silent(
      D,
      `app.get("/m", (req, res) => { const csrf = req.cookies["XSRF-TOKEN"]; res.set("Cache-Control", "public, max-age=60"); res.json(ASSET_MANIFEST); });`,
    );
  });
  test("silent: identity read but empty body (res.end with no payload)", () => {
    silent(
      D,
      `app.get("/x", (req, res) => { const s = req.session; res.setHeader("Cache-Control", "s-maxage=300"); res.end(); });`,
    );
  });
  test("silent: response keyed per user with Vary: Authorization (the rule's own fix)", () => {
    silent(
      D,
      `app.get("/me", (req, res) => { res.set("Vary", "Authorization"); res.set("Cache-Control", "public, max-age=30"); res.json(req.user); });`,
    );
  });
  test("silent: res.vary('Authorization') keys per user", () => {
    silent(
      D,
      `app.get("/me", (req, res) => { res.vary("Authorization"); res.set("Cache-Control", "public"); res.json(req.user); });`,
    );
  });
  test("silent: a later Cache-Control private/no-store overrides the public value", () => {
    silent(
      D,
      `app.get("/feed", (req, res) => { res.set("Cache-Control", "public, max-age=60"); res.set("Cache-Control", "private, no-store"); res.json(req.user); });`,
    );
  });
  test("silent: s-maxage=0 is a shared-cache opt-out, not retention", () => {
    silent(
      D,
      `app.get("/me", (req, res) => { res.set("Cache-Control", "s-maxage=0"); res.json(req.user); });`,
    );
  });
  test("silent: private, no-store is the correct header", () => {
    silent(
      D,
      `app.get("/me", (req, res) => { const u = req.user; res.set("Cache-Control", "private, no-store"); res.json(u); });`,
    );
  });
  test("silent: handler reads no user-identity source (truly public payload)", () => {
    silent(
      D,
      `app.get("/pricing", (req, res) => { res.set("Cache-Control", "public, max-age=3600"); res.json(PLANS); });`,
    );
  });
  test("silent: header set at module scope (boot config, no handler)", () => {
    silent(D, `res.set("Cache-Control", "public, max-age=60");`);
  });
  test("silent: setting Content-Type, not Cache-Control", () => {
    silent(
      D,
      `app.get("/me", (req, res) => { const u = req.user; res.set("Content-Type", "application/json"); res.json(u); });`,
    );
  });
  test("silent: max-age alone (browser-private) is not shared-cacheable", () => {
    silent(
      D,
      `app.get("/me", (req, res) => { const u = req.user; res.set("Cache-Control", "max-age=60"); res.json(u); });`,
    );
  });
  test("silent: public but no-store also present errs to the strict directive", () => {
    silent(
      D,
      `app.get("/me", (req, res) => { const u = req.user; res.set("Cache-Control", "public, no-store"); res.json(u); });`,
    );
  });
  test("silent: dynamic (non-string) Cache-Control value cannot be proven", () => {
    silent(
      D,
      `app.get("/me", (req, res) => { const u = req.user; res.set("Cache-Control", cachePolicy); res.json(u); });`,
    );
  });
  test("silent: identity read only inside a NESTED function of the handler", () => {
    silent(
      D,
      `app.get("/x", (req, res) => { res.set("Cache-Control", "public"); setTimeout(() => { const u = req.user; use(u); }, 0); res.end(); });`,
    );
  });
  test("silent: header set on a non-response object", () => {
    silent(
      D,
      `app.get("/x", (req, res) => { const u = req.user; cacheStore.set("Cache-Control", "public"); res.json(u); });`,
    );
  });
  test("silent: res.cookie (not a header-set method)", () => {
    silent(
      D,
      `app.get("/x", (req, res) => { const u = req.user; res.cookie("Cache-Control", "public"); res.json(u); });`,
    );
  });
  test("silent: identity-looking read on a non-request receiver", () => {
    silent(
      D,
      `app.get("/x", (req, res) => { const u = model.user; res.set("Cache-Control", "public"); res.json(u); });`,
    );
  });
  test("silent: req.get('content-type') is not an identity header read", () => {
    silent(
      D,
      `app.get("/x", (req, res) => { const t = req.get("content-type"); res.set("Cache-Control", "public"); res.end(); });`,
    );
  });
});
