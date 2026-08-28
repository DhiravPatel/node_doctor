/**
 * `no-express4-removed-api`.
 *
 * MEASURED against Express 5.2.1 by enumerating the live objects inside a running
 * handler, rather than reading a changelog:
 *
 *   req.param              → undefined      req.acceptsCharsets   → function
 *   req.acceptsCharset     → undefined      req.acceptsEncodings  → function
 *   req.acceptsEncoding    → undefined      req.acceptsLanguages  → function
 *   req.acceptsLanguage    → undefined      res.sendFile          → function
 *   res.sendfile           → undefined
 *   req.query = {…}        → TypeError      req.params = {…}      → ok
 *   res.redirect("back")   → 302, Location: "back"
 *
 * Only the SINGULAR accessor forms went; the plurals survive. `res.sendfile`
 * versus `res.sendFile` is the same trap in case rather than number.
 *
 * Everything here fails when the route RUNS, not at boot — which is the line
 * that decides membership. Express 5 also removed `app.del(…)` and the route
 * patterns `'/files/*'` / `'/:id?'`, but those throw at boot (`TypeError`,
 * `PathError`), the server never starts, and nobody needs a linter for them.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noExpress4RemovedApi } from "../../src/diagnostics/http/no-express4-removed-api.ts";
import { capabilitiesSatisfied } from "../../src/core/project.ts";

const EXPRESS5 = new Set(["node", "esm", "express", "express:5"]);
const findings = (body: string) =>
  lintSource({
    filePath: "/repo/src/routes.js",
    sourceText: `app.get("/x", (req, res) => { ${body} });`,
    diagnostics: [noExpress4RemovedApi],
    capabilities: EXPRESS5,
  }).findings.filter((f) => f.diagnostic === "no-express4-removed-api");

const fires = (body: string) => {
  const found = findings(body);
  assert.ok(found.length > 0, `expected a FIRE on:\n${body}`);
  return found;
};
const silent = (body: string): void =>
  assert.equal(findings(body).length, 0, `expected SILENCE on:\n${body}`);

describe("no-express4-removed-api", () => {
  describe("removed request methods", () => {
    test("req.param(name)", () => {
      const [found] = fires(`const id = req.param("id");`);
      assert.match(found!.message, /typeof req\.param/);
      assert.match(found!.message, /RUNTIME, not at boot/);
    });

    test("the singular accepts* forms, whose plurals survive", () => {
      for (const method of ["acceptsCharset", "acceptsEncoding", "acceptsLanguage"]) {
        const [found] = fires(`if (req.${method}("x")) {}`);
        assert.match(found!.message, /Only the singular form went/);
      }
    });

    test("`request` roots it too", () => {
      fires(`const id = request.param("id");`);
    });
  });

  describe("removed response methods", () => {
    test("res.sendfile — lowercase f", () => {
      const [found] = fires(`res.sendfile("/srv/a.pdf");`);
      assert.match(found!.message, /sendFile.*capital F/);
    });

    test("`response` roots it too", () => {
      fires(`response.sendfile("/srv/a.pdf");`);
    });
  });

  describe("res.redirect('back') — the one that does not throw", () => {
    test("the one-argument form", () => {
      const [found] = fires(`res.redirect("back");`);
      assert.match(found!.message, /302 with `Location: back`/);
      assert.match(found!.message, /does not throw/);
    });

    test("the status-first form", () => {
      fires(`res.redirect(302, "back");`);
    });

    test("a template literal with no interpolation is still the literal", () => {
      fires("res.redirect(`back`);");
    });
  });

  describe("req.query is a getter in Express 5", () => {
    test("assigning to it throws — the sanitizing-middleware shape", () => {
      const [found] = fires(`req.query = sanitize(req.query);`);
      assert.match(found!.message, /getter in Express 5/);
      assert.match(found!.message, /sanitize/);
    });

    test("req.params and req.body assignment still work, and stay silent", () => {
      // Measured: both are `ok`, only `query` throws.
      silent(`req.params = { a: 1 };`);
      silent(`req.body = { a: 1 };`);
    });
  });

  describe("silence — the Express 5 spellings", () => {
    test("the surviving replacements", () => {
      silent(`const id = req.params.id;`);
      silent(`if (req.acceptsCharsets("utf-8")) {}`);
      silent(`if (req.acceptsEncodings("gzip")) {}`);
      silent(`if (req.acceptsLanguages("en")) {}`);
      silent(`res.sendFile("/srv/a.pdf");`);
    });

    test("an ordinary redirect", () => {
      silent(`res.redirect("/home");`);
      silent(`res.redirect(url);`);
      silent(`res.redirect(301, "/home");`);
      silent(`res.redirect(req.get("Referrer") || "/");`);
    });
  });

  describe("precision guards", () => {
    test("these are ordinary words on anything that is not req/res", () => {
      silent(`router.param("id", handler);`);
      silent(`mailer.sendfile("/a");`);
      silent(`cache.query = build();`);
      silent(`nav.redirect("back");`);
    });

    test("gated to Express 5 — all of these work on Express 4", () => {
      assert.equal(
        capabilitiesSatisfied(noExpress4RemovedApi, new Set(["node", "esm", "express"])),
        false,
        "an Express 4 project must never see this",
      );
      assert.ok(capabilitiesSatisfied(noExpress4RemovedApi, EXPRESS5));
      assert.equal(capabilitiesSatisfied(noExpress4RemovedApi, new Set(["node", "esm"])), false);
    });
  });
});
