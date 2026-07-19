import { describe, test } from "node:test";
import { expectFires, expectSilent } from "../helpers.ts";

describe("no-large-json-parse-in-request-path", () => {
  test("silent: JSON.parse of a bounded config at module scope", () => {
    expectSilent(
      "no-large-json-parse-in-request-path",
      `const config = JSON.parse(fs.readFileSync("./config.json", "utf8"));`,
    );
  });
  test("silent: JSON.parse of a static string literal on the request path", () => {
    expectSilent(
      "no-large-json-parse-in-request-path",
      `app.post("/x", (req, res) => { const cfg = JSON.parse('{"a":1}'); res.json(cfg); });`,
    );
  });
  test("silent: JSON.parse of non-caller data on the request path", () => {
    expectSilent(
      "no-large-json-parse-in-request-path",
      `app.get("/x", (req, res) => { const d = JSON.parse(defaults); res.json(d); });`,
    );
  });
  test("fires: JSON.parse of req.body on a request path", () => {
    expectFires(
      "no-large-json-parse-in-request-path",
      `app.post("/import", (req, res) => { const rows = JSON.parse(req.body.raw); res.json(rows); });`,
    );
  });
});

describe("no-redos-prone-regex", () => {
  test("silent: an anchored single-quantifier regex", () => {
    expectSilent("no-redos-prone-regex", `const re = /^\\w+@\\w+\\.\\w+$/;`);
  });
  test("silent: a bounded date regex", () => {
    expectSilent("no-redos-prone-regex", `const re = /^\\d{4}-\\d{2}-\\d{2}$/;`);
  });
  test("fires: nested-quantifier literal (a+)+", () => {
    expectFires("no-redos-prone-regex", `const re = /^(a+)+$/;`);
  });
  test("fires: RegExp constructor with (\\w+)* shape", () => {
    expectFires("no-redos-prone-regex", `const re = new RegExp("^(\\\\w+)*$");`);
  });
});

describe("no-sync-bcrypt-in-request-path", () => {
  test("silent: async bcrypt.compare on the request path", () => {
    expectSilent(
      "no-sync-bcrypt-in-request-path",
      `app.post("/login", async (req, res) => { const ok = await bcrypt.compare(req.body.pw, hash); res.json({ ok }); });`,
    );
  });
  test("silent: bcrypt.hashSync at module scope (one-time seed)", () => {
    expectSilent("no-sync-bcrypt-in-request-path", `const seedHash = bcrypt.hashSync(SEED, 10);`);
  });
  test("fires: bcrypt.compareSync inside a login handler", () => {
    expectFires(
      "no-sync-bcrypt-in-request-path",
      `app.post("/login", (req, res) => { const ok = bcrypt.compareSync(req.body.pw, hash); res.json({ ok }); });`,
    );
  });
});

describe("require-pagination-limit", () => {
  const caps = { capabilities: ["node", "esm", "prisma"] };

  test("silent: findMany with a take", () => {
    expectSilent(
      "require-pagination-limit",
      `app.get("/u", async (req, res) => { const u = await prisma.user.findMany({ where: { active: true }, take: 50 }); res.json(u); });`,
      caps,
    );
  });
  test("silent: findMany with no options object", () => {
    expectSilent(
      "require-pagination-limit",
      `app.get("/u", async (req, res) => { const u = await prisma.user.findMany(); res.json(u); });`,
      caps,
    );
  });
  test("silent: findMany on a non-db receiver", () => {
    expectSilent(
      "require-pagination-limit",
      `const rows = queue.jobs.findMany({ where: { pending: true } });`,
      caps,
    );
  });
  test("fires: unbounded findMany on a db receiver", () => {
    expectFires(
      "require-pagination-limit",
      `app.get("/u", async (req, res) => { const u = await prisma.user.findMany({ where: { active: true } }); res.json(u); });`,
      caps,
    );
  });
});
