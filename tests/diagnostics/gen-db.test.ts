import { describe, test } from "node:test";
import { expectFires, expectSilent } from "../helpers.ts";

describe("no-db-connection-per-request", () => {
  test("silent: client constructed once at module scope", () => {
    expectSilent(
      "no-db-connection-per-request",
      `import { PrismaClient } from "@prisma/client";
       const prisma = new PrismaClient();
       app.post("/u", (req, res) => prisma.user.create({ data: req.body }));`,
    );
  });

  test("silent: pool created at module scope, reused in handler", () => {
    expectSilent(
      "no-db-connection-per-request",
      `const pool = new Pool({ max: 10 });
       app.get("/x", async (req, res) => {
         const r = await pool.query("SELECT 1");
         res.json(r.rows);
       });`,
    );
  });

  test("fires: new PrismaClient() inside a handler", () => {
    expectFires(
      "no-db-connection-per-request",
      `app.post("/u", async (req, res) => {
         const db = new PrismaClient();
         const u = await db.user.create({ data: req.body });
         res.json(u);
       });`,
    );
  });

  test("fires: new Pool() inside a handler", () => {
    expectFires(
      "no-db-connection-per-request",
      `router.get("/x", async (req, res) => {
         const pool = new Pool(config);
         res.json(await pool.query("SELECT 1"));
       });`,
    );
  });

  test("fires: createConnection() inside a handler", () => {
    expectFires(
      "no-db-connection-per-request",
      `app.get("/y", (req, res) => {
         const conn = createConnection(dbUrl);
         res.end();
       });`,
    );
  });

  test("fires: mongoose.connect() inside a handler", () => {
    expectFires(
      "no-db-connection-per-request",
      `app.post("/init", async (req, res) => {
         await mongoose.connect(req.body.uri);
         res.end();
       });`,
    );
  });
});

describe("no-findmany-then-filter-in-js", () => {
  test("silent: query narrows with where", () => {
    expectSilent(
      "no-findmany-then-filter-in-js",
      `const active = await db.user.findMany({ where: { active: true } });`,
    );
  });

  test("silent: plain array filtered in JS", () => {
    expectSilent(
      "no-findmany-then-filter-in-js",
      `const items = [1, 2, 3];
       const fresh = items.filter((i) => i > 1);`,
    );
  });

  test("silent: findMany assigned then used elsewhere (no direct .filter)", () => {
    expectSilent(
      "no-findmany-then-filter-in-js",
      `const users = await db.user.findMany({ take: 50 });
       const names = users.map((u) => u.name);`,
    );
  });

  test("fires: findMany with no where, filtered in JS", () => {
    expectFires(
      "no-findmany-then-filter-in-js",
      `const active = (await db.user.findMany()).filter((u) => u.active);`,
    );
  });

  test("fires: mongoose-style find() then filter", () => {
    expectFires(
      "no-findmany-then-filter-in-js",
      `const admins = (await userModel.find()).filter((u) => u.role === "admin");`,
    );
  });
});

describe("no-missing-await-on-query", () => {
  test("silent: awaited query", () => {
    expectSilent(
      "no-missing-await-on-query",
      `async function f(id) { await db.user.update({ where: { id }, data: { seen: true } }); }`,
    );
  });

  test("silent: returned query promise", () => {
    expectSilent(
      "no-missing-await-on-query",
      `function create(data) { return db.user.create({ data }); }`,
    );
  });

  test("silent: chained with catch", () => {
    expectSilent(
      "no-missing-await-on-query",
      `db.user.create({ data }).catch(next);`,
    );
  });

  test("silent: assigned to a variable", () => {
    expectSilent(
      "no-missing-await-on-query",
      `const p = db.user.findMany({ take: 10 });`,
    );
  });

  test("fires: floating update statement", () => {
    expectFires(
      "no-missing-await-on-query",
      `async function f(id) { db.user.update({ where: { id }, data: { seen: true } }); }`,
    );
  });

  test("fires: floating create statement", () => {
    expectFires(
      "no-missing-await-on-query",
      `function handler(data) { prisma.order.create({ data }); }`,
    );
  });
});

describe("no-external-call-inside-open-transaction", () => {
  test("silent: pure DB work inside the transaction", () => {
    expectSilent(
      "no-external-call-inside-open-transaction",
      `await db.$transaction(async (tx) => {
         const o = await tx.order.create({ data });
         await tx.balance.update({ where: { id }, data: { amount } });
       });`,
    );
  });

  test("silent: network call outside the transaction", () => {
    expectSilent(
      "no-external-call-inside-open-transaction",
      `const o = await db.$transaction((tx) => tx.order.create({ data }));
       await fetch(\`https://pay/\${o.id}\`);`,
    );
  });

  test("fires: fetch inside a $transaction callback", () => {
    expectFires(
      "no-external-call-inside-open-transaction",
      `await db.$transaction(async (tx) => {
         const o = await tx.order.create({ data });
         await fetch(\`https://pay/\${o.id}\`);
       });`,
    );
  });

  test("fires: axios call inside withTransaction callback", () => {
    expectFires(
      "no-external-call-inside-open-transaction",
      `await session.withTransaction(async () => {
         await repo.save(entity);
         await axios.post("https://hook", { entity });
       });`,
    );
  });

  test("fires: http.request nested inside a transaction callback", () => {
    expectFires(
      "no-external-call-inside-open-transaction",
      `await knex.transaction(async (trx) => {
         await trx("orders").insert(row);
         ids.forEach((id) => {
           http.request({ host: "x", path: "/" + id });
         });
       });`,
    );
  });
});
