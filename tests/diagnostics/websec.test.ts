/**
 * Web-security diagnostics (FEATURE.md §7): XSS and CSRF.
 *
 * These two rules are driven through `lintSource` directly rather than the
 * shared `findingsFor` helper, so they are exercised against the diagnostic
 * modules themselves and not the generated registry.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import type { Diagnostic, Finding } from "../../src/core/types.ts";
import { noXssInHtmlResponse } from "../../src/diagnostics/security/no-xss-in-html-response.ts";
import { noStateChangeOnGet } from "../../src/diagnostics/security/no-state-change-on-get.ts";

const CAPABILITIES = new Set(["node", "esm", "express"]);

const findingsFor = (diagnostic: Diagnostic, source: string): Finding[] =>
  lintSource({
    filePath: "test.ts",
    sourceText: source,
    diagnostics: [diagnostic],
    capabilities: CAPABILITIES,
  }).findings.filter((f) => f.diagnostic === diagnostic.id);

const fires = (diagnostic: Diagnostic, source: string): Finding[] => {
  const found = findingsFor(diagnostic, source);
  assert.ok(found.length > 0, `expected ${diagnostic.id} to FIRE on:\n${source}`);
  return found;
};

const silent = (diagnostic: Diagnostic, source: string): void => {
  const found = findingsFor(diagnostic, source);
  assert.equal(
    found.length,
    0,
    `expected ${diagnostic.id} to STAY SILENT, got ${found.length}:\n` +
      found.map((f) => `  - ${f.message} @ ${f.line}:${f.column}`).join("\n") +
      `\n--- source ---\n${source}`,
  );
};

// ---------------------------------------------------------------------------
// no-xss-in-html-response
// ---------------------------------------------------------------------------

describe("no-xss-in-html-response", () => {
  test("fires on a request value interpolated into an HTML template sent with res.send", () => {
    fires(noXssInHtmlResponse, 'app.get("/hi", (req, res) => res.send(`<h1>${req.query.name}</h1>`));');
  });

  test("fires on HTML concatenation written with res.write", () => {
    fires(
      noXssInHtmlResponse,
      'app.post("/c", (req, res) => { res.write("<div>" + req.body.comment + "</div>"); res.end(); });',
    );
  });

  test("fires through a local that holds the built HTML", () => {
    fires(
      noXssInHtmlResponse,
      'app.get("/p", (req, res) => { const name = req.query.name; const html = `<p>${name}</p>`; res.send(html); });',
    );
  });

  test("fires on a chained res.status(...).send", () => {
    fires(
      noXssInHtmlResponse,
      'app.get("/a", (req, res) => res.status(200).send(`<a href="${req.query.url}">go</a>`));',
    );
  });

  test("fires on a full document written with res.end", () => {
    fires(
      noXssInHtmlResponse,
      'app.get("/e", (req, res) => res.end(`<!doctype html><body>${req.params.id}</body>`));',
    );
  });

  test("reports the interpolated expression and names the sink", () => {
    const [finding] = fires(
      noXssInHtmlResponse,
      'app.get("/hi", (req, res) => res.send(`<h1>${req.query.name}</h1>`));',
    );
    assert.match(finding!.message, /res\.send/);
    assert.equal(finding!.severity, "error");
    assert.equal(finding!.category, "Security");
  });

  // --- MUST be silent ---

  test("silent on res.json — JSON is not an HTML sink", () => {
    silent(noXssInHtmlResponse, 'app.post("/x", (req, res) => res.json(req.body));');
  });

  test("silent on markup inside a JSON payload", () => {
    silent(noXssInHtmlResponse, 'app.get("/x", (req, res) => res.json({ echo: `<b>${req.query.q}</b>` }));');
  });

  test("silent on a bare tainted string with no markup", () => {
    silent(noXssInHtmlResponse, 'app.get("/x", (req, res) => res.send(req.query.name));');
    silent(noXssInHtmlResponse, 'app.get("/x", (req, res) => res.send(`Hello ${req.query.name}`));');
  });

  test("silent on a template engine render — the engine escapes", () => {
    silent(noXssInHtmlResponse, 'app.get("/x", (req, res) => res.render("page", { name: req.query.name }));');
  });

  test("silent when the value is escaped/sanitized inline", () => {
    silent(noXssInHtmlResponse, 'app.get("/x", (req, res) => res.send(`<h1>${escapeHtml(req.query.name)}</h1>`));');
    silent(noXssInHtmlResponse, 'app.get("/x", (req, res) => res.send("<b>" + DOMPurify.sanitize(req.body.html) + "</b>"));');
    silent(noXssInHtmlResponse, 'app.get("/x", (req, res) => res.send(`<h1>${xss(req.query.q)}</h1>`));');
    silent(noXssInHtmlResponse, 'app.get("/x", (req, res) => res.send(`<p>${striptags(req.body.bio)}</p>`));');
    silent(
      noXssInHtmlResponse,
      'app.get("/x", (req, res) => res.send(`<a href="/s?q=${encodeURIComponent(req.query.q)}">s</a>`));',
    );
  });

  test("silent when the value was escaped into a local first", () => {
    silent(
      noXssInHtmlResponse,
      'app.get("/x", (req, res) => { const safe = escape(req.query.q); res.send(`<p>${safe}</p>`); });',
    );
  });

  test("silent when the interpolated value is not caller-controlled", () => {
    silent(noXssInHtmlResponse, 'const title = config.title; app.get("/x", (req, res) => res.send(`<h1>${title}</h1>`));');
    silent(noXssInHtmlResponse, 'app.get("/x", (req, res) => res.send(`<h1>Report</h1>`));');
  });

  test("silent on a non-response receiver", () => {
    silent(noXssInHtmlResponse, 'stream.write("<div>" + req.body.x + "</div>");');
  });

  test("silent when the argument is an object, not an HTML string", () => {
    silent(noXssInHtmlResponse, 'app.get("/x", (req, res) => res.send({ html: "<b>" + req.query.q + "</b>" }));');
  });

  test("silent on a stray `<` in plain text", () => {
    silent(noXssInHtmlResponse, 'const n = 3; app.get("/x", (req, res) => res.send("count " + n + " < " + req.query.max));');
  });

  test("silent on interpolations that cannot carry markup", () => {
    silent(noXssInHtmlResponse, 'app.get("/x", (req, res) => res.send(`<p>Page ${Number(req.query.page)}</p>`));');
    silent(
      noXssInHtmlResponse,
      'app.get("/x", async (req, res) => { const rows = await db.find(req.query.q); res.send(`<p>${rows.length} results</p>`); });',
    );
    silent(noXssInHtmlResponse, 'app.get("/x", (req, res) => res.send(`<h1>${req.t("welcome")}</h1>`));');
  });

  test("still fires when a caller value only passes through a non-escaping call", () => {
    fires(noXssInHtmlResponse, 'app.get("/x", (req, res) => res.send(`<h1>${req.query.name.toUpperCase()}</h1>`));');
    fires(noXssInHtmlResponse, 'app.get("/x", (req, res) => res.send(`<div>${req.t(req.query.key)}</div>`));');
  });

  test("silent when the body comes from disk", () => {
    silent(
      noXssInHtmlResponse,
      'app.get("/x", (req, res) => { const html = fs.readFileSync("index.html", "utf8"); res.send(html); });',
    );
  });
});

// ---------------------------------------------------------------------------
// no-state-change-on-get
// ---------------------------------------------------------------------------

describe("no-state-change-on-get", () => {
  test("fires on an ORM delete inside a GET handler", () => {
    fires(
      noStateChangeOnGet,
      'app.get("/users/:id/delete", async (req, res) => { await db.users.deleteMany({ where: { id: req.params.id } }); res.redirect("/"); });',
    );
  });

  test("fires on a prisma update inside a router GET", () => {
    fires(
      noStateChangeOnGet,
      'router.get("/p/:id/publish", async (req, res) => { await prisma.post.update({ where: { id }, data: { published: true } }); });',
    );
  });

  test("fires on a raw DELETE statement", () => {
    fires(
      noStateChangeOnGet,
      'app.get("/purge", async (req, res) => { await db.query("DELETE FROM sessions WHERE expired = true"); res.end(); });',
    );
  });

  test("fires on a raw UPDATE in a tagged sql template", () => {
    fires(
      noStateChangeOnGet,
      'app.get("/x", asyncHandler(async (req, res) => { await sql`DELETE FROM audit WHERE id = 1`; }));',
    );
  });

  test("fires on an awaited model write", () => {
    fires(
      noStateChangeOnGet,
      'app.get("/u/:id", async (req, res) => { await User.destroy({ where: { id: req.params.id } }); });',
    );
  });

  test("fires on a @Get() controller method that hits a repository", () => {
    fires(
      noStateChangeOnGet,
      'class C { @Get(":id/remove") async remove(id) { await this.userRepository.delete(id); } }',
    );
  });

  test("fires through a named handler reference", () => {
    fires(
      noStateChangeOnGet,
      'function handler(req, res) { db.orders.insertMany(rows); }\napp.get("/seed", handler);',
    );
  });

  test("names the sink and stays a warning", () => {
    const [finding] = fires(
      noStateChangeOnGet,
      'app.get("/d", async (req, res) => { await db.users.deleteMany({ where: { id } }); });',
    );
    assert.match(finding!.message, /db\.users\.deleteMany/);
    assert.equal(finding!.severity, "warn");
    assert.equal(finding!.category, "Security");
  });

  // --- MUST be silent ---

  test("silent on the same write under a non-GET method", () => {
    silent(noStateChangeOnGet, 'app.post("/u/:id/delete", async (req, res) => { await db.users.deleteMany({ where: { id } }); });');
    silent(noStateChangeOnGet, 'app.put("/u", async (req, res) => { await prisma.user.update({ where: { id }, data }); });');
    silent(noStateChangeOnGet, 'app.patch("/u", async (req, res) => { await userRepository.save(u); });');
    silent(noStateChangeOnGet, 'app.delete("/u/:id", async (req, res) => { await db.users.deleteMany({ where: { id } }); });');
    silent(noStateChangeOnGet, 'class C { @Post(":id") async remove(id) { await this.userRepository.delete(id); } }');
  });

  test("silent on read-only ORM calls", () => {
    silent(noStateChangeOnGet, 'app.get("/u", async (req, res) => { const u = await db.users.findMany({ take: 10 }); res.json(u); });');
    silent(noStateChangeOnGet, 'app.get("/u/:id", async (req, res) => { const u = await prisma.user.findUnique({ where: { id } }); res.json(u); });');
    silent(noStateChangeOnGet, 'app.get("/n", async (req, res) => { const n = await db.users.count(); res.json({ n }); });');
    silent(noStateChangeOnGet, 'app.get("/a", async (req, res) => { const a = await Order.aggregate([{ $match: {} }]); res.json(a); });');
  });

  test("silent on a SELECT query", () => {
    silent(
      noStateChangeOnGet,
      'app.get("/r", async (req, res) => { const r = await db.query("SELECT * FROM users WHERE id = $1", [req.params.id]); res.json(r); });',
    );
  });

  test("silent on cache, cookie and session writes", () => {
    silent(noStateChangeOnGet, 'app.get("/c", async (req, res) => { const v = await load(); cache.set("k", v); res.json(v); });');
    silent(noStateChangeOnGet, 'app.get("/l", (req, res) => { res.cookie("sid", sid, { httpOnly: true }); req.session.save(); res.end(); });');
    silent(noStateChangeOnGet, 'app.get("/o", (req, res) => { req.session.destroy(); res.redirect("/"); });');
  });

  test("silent on logging and metrics", () => {
    silent(noStateChangeOnGet, 'app.get("/m", (req, res) => { logger.info("hit"); metrics.counter.update(1); res.end(); });');
  });

  test("silent on same-named non-persistence receivers", () => {
    silent(
      noStateChangeOnGet,
      'app.get("/h", (req, res) => { const h = crypto.createHash("sha256"); hash.update(req.query.q); res.end(h.digest("hex")); });',
    );
    silent(
      noStateChangeOnGet,
      'app.get("/x", (req, res) => { const o = Object.create(null); const m = new Map(); m.delete("k"); res.json(o); });',
    );
    silent(noStateChangeOnGet, 'app.get("/e", (req, res) => { emitter.remove("x"); socket.destroy(); res.end(); });');
  });

  test("silent on a synchronous PascalCase factory", () => {
    silent(noStateChangeOnGet, 'app.get("/p", (req, res) => { const price = Money.create(10); res.json(price); });');
    silent(
      noStateChangeOnGet,
      'app.get("/dl", async (req, res) => { const rows = await db.report.findMany(); const wb = Workbook.create(rows); res.send(wb); });',
    );
  });

  test("silent on non-route `.get` calls", () => {
    silent(noStateChangeOnGet, 'const v = cache.get("key", fallback);');
    silent(noStateChangeOnGet, 'app.get("view engine");\napp.get("/x", (req, res) => res.end());');
  });

  test("silent on a string that merely contains a SQL-looking word", () => {
    silent(noStateChangeOnGet, 'app.get("/status", (req, res) => { res.json({ update: "update available" }); });');
  });
});
