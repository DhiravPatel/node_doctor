import { describe, test } from "node:test";
import { expectFires, expectSilent } from "../helpers.ts";

describe("no-eval-with-input", () => {
  test("silent: eval of a static string literal (out of scope)", () => {
    expectSilent("no-eval-with-input", `const r = eval("1 + 1");`);
  });
  test("fires: eval of caller-controlled input", () => {
    expectFires(
      "no-eval-with-input",
      `app.post("/run", (req, res) => { const r = eval(req.body.expr); res.json({ r }); });`,
    );
  });
  test("fires: eval of a dynamically-built string", () => {
    expectFires("no-eval-with-input", `const r = eval("(" + payload + ")");`);
  });
});

describe("no-function-constructor-with-input", () => {
  test("silent: Function constructor with only static literals", () => {
    expectSilent(
      "no-function-constructor-with-input",
      `const add = new Function("a", "b", "return a + b");`,
    );
  });
  test("fires: new Function built from request input", () => {
    expectFires(
      "no-function-constructor-with-input",
      `app.post("/f", (req, res) => { const fn = new Function("x", req.body.code); res.end(); });`,
    );
  });
  test("fires: Function() called with a dynamic body", () => {
    expectFires("no-function-constructor-with-input", `const fn = Function("return " + expr);`);
  });
});

describe("no-vm-run-untrusted", () => {
  test("silent: vm runs a static code string", () => {
    expectSilent("no-vm-run-untrusted", `vm.runInNewContext("1 + 1", sandbox);`);
  });
  test("fires: vm.runInNewContext with caller-controlled code", () => {
    expectFires(
      "no-vm-run-untrusted",
      `app.post("/eval", (req, res) => { vm.runInNewContext(req.body.script, {}); res.end(); });`,
    );
  });
  test("fires: new vm.Script built from a dynamic string", () => {
    expectFires("no-vm-run-untrusted", `const s = new vm.Script("return " + expr);`);
  });
});

describe("no-unsafe-regexp-from-input", () => {
  test("silent: RegExp from a fixed literal pattern", () => {
    expectSilent("no-unsafe-regexp-from-input", `const re = new RegExp("^[a-z0-9_]+$");`);
  });
  test("silent: RegExp from a non-tainted internal variable", () => {
    expectSilent(
      "no-unsafe-regexp-from-input",
      `const pattern = "^v\\\\d+$"; const re = new RegExp(pattern);`,
    );
  });
  test("fires: RegExp from caller-controlled input", () => {
    expectFires(
      "no-unsafe-regexp-from-input",
      `app.get("/find", (req, res) => { const re = new RegExp(req.query.q); res.end(); });`,
    );
  });
});

describe("no-nosql-object-injection", () => {
  test("silent: explicit scalar field cast from input", () => {
    expectSilent(
      "no-nosql-object-injection",
      `app.post("/login", (req, res) => { User.findOne({ email: String(req.body.email) }); res.end(); });`,
    );
  });
  test("silent: findById with a scalar id", () => {
    expectSilent(
      "no-nosql-object-injection",
      `app.get("/u/:id", (req, res) => { User.findById(req.params.id); res.end(); });`,
    );
  });
  test("fires: raw request object used as a filter", () => {
    expectFires(
      "no-nosql-object-injection",
      `app.post("/login", (req, res) => { User.findOne(req.body); res.end(); });`,
    );
  });
  test("fires: caller data spread into the filter", () => {
    expectFires(
      "no-nosql-object-injection",
      `app.post("/s", (req, res) => { User.find({ ...req.query }); res.end(); });`,
    );
  });
  test("fires: $where built from input", () => {
    expectFires(
      "no-nosql-object-injection",
      "app.get('/w', (req, res) => { User.find({ $where: \"this.n == '\" + req.query.n + \"'\" }); res.end(); });",
    );
  });
});

describe("no-open-redirect", () => {
  test("silent: redirect to a fixed path", () => {
    expectSilent(
      "no-open-redirect",
      `app.get("/home", (req, res) => { res.redirect("/dashboard"); });`,
    );
  });
  test("silent: redirect validated against an allowlist", () => {
    expectSilent(
      "no-open-redirect",
      `app.get("/go", (req, res) => { const t = req.query.url; if (ALLOW.includes(t)) { res.redirect(t); } });`,
    );
  });
  test("fires: redirect to a caller-controlled URL", () => {
    expectFires(
      "no-open-redirect",
      `app.get("/go", (req, res) => { res.redirect(req.query.url); });`,
    );
  });
});

describe("no-ssrf-unvalidated-url", () => {
  test("silent: fetch of a static URL", () => {
    expectSilent(
      "no-ssrf-unvalidated-url",
      `app.get("/h", (req, res) => { fetch("https://api.internal/health").then(() => res.end()); });`,
    );
  });
  test("silent: fetch validated against a host allowlist", () => {
    expectSilent(
      "no-ssrf-unvalidated-url",
      `app.get("/p", (req, res) => { const u = req.query.url; if (ALLOW_HOSTS.has(new URL(u).host)) { fetch(u); } res.end(); });`,
    );
  });
  test("fires: fetch of a caller-controlled URL", () => {
    expectFires(
      "no-ssrf-unvalidated-url",
      `app.get("/fetch", (req, res) => { fetch(req.query.url).then(() => res.end()); });`,
    );
  });
});
