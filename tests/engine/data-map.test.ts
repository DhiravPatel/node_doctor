/**
 * §143 — Data Access Map & Route → Entity Lineage.
 *
 * Covers the route → entity → op mapping precisely across the ORM shapes the
 * extractor understands (Prisma model calls, cross-file raw SQL, a Knex builder
 * chain), the inverse entity → routes index, the unresolved-query counter, a
 * db-free handler, and the hard determinism invariant.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildDataAccessMap, type DataAccessMap, type RouteAccess } from "../../src/core/data-map.ts";

/** Write a set of files (relative path → source) into a fresh temp directory. */
const makeProject = async (files: Record<string, string>): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "nd-datamap-"));
  for (const [rel, src] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, src);
  }
  return dir;
};

const findRoute = (map: DataAccessMap, method: string, path: string): RouteAccess => {
  const r = map.routes.find((x) => x.method === method && x.path === path);
  assert.ok(r, `expected a ${method} ${path} route`);
  return r;
};

/** A route touches exactly these `entity → ops` pairs (order-independent input). */
const assertEntities = (route: RouteAccess, expected: Record<string, string[]>): void => {
  const actual: Record<string, string[]> = {};
  for (const e of route.entities) actual[e.entity] = e.ops;
  assert.deepEqual(actual, expected, `entities for ${route.method} ${route.path}`);
};

// The comprehensive fixture: one route file plus a same-dir service module.
const APP = `
import { Router } from "express";
import { purgeSessions } from "./svc.ts";

const router = Router();

router.get("/orders", async (req, res) => {
  const orders = await prisma.order.findMany();
  await prisma.user.update({ where: { id: 1 }, data: { seen: true } });
  res.json(orders);
});

router.post("/audit", async (req, res) => {
  await db("audit_log").insert({ action: req.body.action });
  res.sendStatus(201);
});

router.post("/logout", async (req, res) => {
  await purgeSessions(req.body.userId);
  res.sendStatus(204);
});

router.get("/health", (req, res) => {
  res.json({ ok: true });
});

export default router;
`;

const SVC = `
export async function purgeSessions(userId) {
  await db.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
}
`;

describe("buildDataAccessMap — route → entity → op", () => {
  test("direct Prisma model calls: order(read) + user(write)", async () => {
    const dir = await makeProject({ "app.ts": APP, "svc.ts": SVC });
    try {
      const map = await buildDataAccessMap(dir);
      assertEntities(findRoute(map, "GET", "/orders"), {
        order: ["read"],
        user: ["write"],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("cross-file: route → service → db.query('DELETE FROM sessions') = sessions(delete)", async () => {
    const dir = await makeProject({ "app.ts": APP, "svc.ts": SVC });
    try {
      const map = await buildDataAccessMap(dir);
      assertEntities(findRoute(map, "POST", "/logout"), { sessions: ["delete"] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("Knex builder chain: db('audit_log').insert() = audit_log(write)", async () => {
    const dir = await makeProject({ "app.ts": APP, "svc.ts": SVC });
    try {
      const map = await buildDataAccessMap(dir);
      assertEntities(findRoute(map, "POST", "/audit"), { audit_log: ["write"] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a handler with no database access has no entities", async () => {
    const dir = await makeProject({ "app.ts": APP, "svc.ts": SVC });
    try {
      const map = await buildDataAccessMap(dir);
      assert.deepEqual(findRoute(map, "GET", "/health").entities, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("summary counts every resolved route/entity; nothing is unresolved here", async () => {
    const dir = await makeProject({ "app.ts": APP, "svc.ts": SVC });
    try {
      const map = await buildDataAccessMap(dir);
      assert.equal(map.summary.routes, 4);
      // audit_log, order, sessions, user
      assert.equal(map.summary.entities, 4);
      assert.equal(map.summary.unresolvedQueries, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("buildDataAccessMap — inverse entity → routes index", () => {
  test("an entity lists the routes (and ops) that touch it", async () => {
    const dir = await makeProject({ "app.ts": APP, "svc.ts": SVC });
    try {
      const map = await buildDataAccessMap(dir);

      const sessions = map.entities.find((e) => e.entity === "sessions");
      assert.ok(sessions, "expected a sessions entity");
      assert.deepEqual(sessions.ops, ["delete"]);
      assert.deepEqual(sessions.routes, [{ method: "POST", path: "/logout" }]);

      const order = map.entities.find((e) => e.entity === "order");
      assert.ok(order, "expected an order entity");
      assert.deepEqual(order.ops, ["read"]);
      assert.deepEqual(order.routes, [{ method: "GET", path: "/orders" }]);

      // Entities are sorted alphabetically.
      assert.deepEqual(
        map.entities.map((e) => e.entity),
        ["audit_log", "order", "sessions", "user"],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("buildDataAccessMap — unresolved queries", () => {
  test("a dynamically-built SQL string is counted, not guessed", async () => {
    const dir = await makeProject({
      "dyn.ts": `
import { Router } from "express";
const router = Router();
router.get("/report", async (req, res) => {
  const sql = "SELECT * FROM " + req.query.table;
  await db.query(sql);
  res.end();
});
export default router;
`,
    });
    try {
      const map = await buildDataAccessMap(dir);
      assert.equal(map.summary.routes, 1);
      assert.equal(map.summary.entities, 0);
      assert.equal(map.summary.unresolvedQueries, 1);
      assert.deepEqual(findRoute(map, "GET", "/report").entities, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("buildDataAccessMap — raw-SQL template literals", () => {
  // The table-bearing keyword lives in a static part of the template even when the
  // query interpolates a value; the extractor reads it from the static quasis.
  const RAW = `
import { Router } from "express";
const router = Router();

// call form, template arg with a value hole
router.get("/raw", async (req, res) => {
  const rows = await prisma.$queryRawUnsafe(\`SELECT * FROM users WHERE id = \${req.query.id}\`);
  res.json(rows);
});

// tagged-template form — Prisma's typed $queryRaw
router.get("/tagged", async (req, res) => {
  const rows = await prisma.$queryRaw\`SELECT id FROM orders WHERE id = \${req.query.id}\`;
  res.json(rows);
});

// tagged-template $executeRaw DELETE → delete op
router.post("/logout", async (req, res) => {
  await prisma.$executeRaw\`DELETE FROM sessions WHERE token = \${req.body.t}\`;
  res.sendStatus(204);
});

// INSERT INTO with a value hole → write op
router.post("/audit", async (req, res) => {
  await db.query(\`INSERT INTO audit_log (msg) VALUES (\${req.body.msg})\`);
  res.sendStatus(201);
});

// interpolated TABLE position → must stay unresolved, never guessed
router.get("/dyn", async (req, res) => {
  await db.query(\`SELECT * FROM \${req.query.table} WHERE id = 1\`);
  res.end();
});

// a bare sql\`...\` tag is deliberately NOT attributed (precision over recall)
router.get("/pg", async (req, res) => {
  const rows = await sql\`SELECT * FROM widgets\`;
  res.json(rows);
});

export default router;
`;

  test("call-form template with a value hole resolves the FROM table", async () => {
    const dir = await makeProject({ "raw.ts": RAW });
    try {
      const map = await buildDataAccessMap(dir);
      assertEntities(findRoute(map, "GET", "/raw"), { users: ["read"] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("tagged-template $queryRaw / $executeRaw resolve entity and op", async () => {
    const dir = await makeProject({ "raw.ts": RAW });
    try {
      const map = await buildDataAccessMap(dir);
      assertEntities(findRoute(map, "GET", "/tagged"), { orders: ["read"] });
      assertEntities(findRoute(map, "POST", "/logout"), { sessions: ["delete"] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("INSERT INTO with a value hole is a write", async () => {
    const dir = await makeProject({ "raw.ts": RAW });
    try {
      const map = await buildDataAccessMap(dir);
      assertEntities(findRoute(map, "POST", "/audit"), { audit_log: ["write"] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an interpolated table position stays unresolved (never guessed)", async () => {
    const dir = await makeProject({ "raw.ts": RAW });
    try {
      const map = await buildDataAccessMap(dir);
      assert.deepEqual(findRoute(map, "GET", "/dyn").entities, []);
      // /dyn contributes the single unresolved query; /pg's bare sql tag is not
      // attributed at all, so it adds nothing.
      assert.equal(map.summary.unresolvedQueries, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a bare sql`...` tag is not attributed as database access", async () => {
    const dir = await makeProject({ "raw.ts": RAW });
    try {
      const map = await buildDataAccessMap(dir);
      assert.deepEqual(findRoute(map, "GET", "/pg").entities, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("buildDataAccessMap — raw-SQL FP hardening (adversarial hunt regressions)", () => {
  // Every case below produced a WRONG table or op before hardening; a wrong entity
  // in a data map is a release blocker, so each is pinned.
  const cases: Array<{ name: string; sql: string; expect: Record<string, string[]> }> = [
    // (1) FOR UPDATE / SHARE row-locking clauses: the `UPDATE` inside `FOR UPDATE OF`
    //     used to capture the next keyword (OF/SKIP/NOWAIT) as a phantom write.
    {
      name: "FOR UPDATE OF is a locking read, not a write of `OF`",
      sql: "SELECT o.* FROM orders o JOIN users u ON o.user_id = u.id FOR UPDATE OF o",
      expect: { orders: ["read"] },
    },
    {
      name: "FOR UPDATE SKIP LOCKED is a queue-poll read of the FROM table",
      sql: "SELECT id FROM jobs WHERE status = 1 ORDER BY id LIMIT 5 FOR UPDATE SKIP LOCKED",
      expect: { jobs: ["read"] },
    },
    {
      name: "FOR UPDATE NOWAIT is a locking read",
      sql: "SELECT * FROM inventory WHERE sku = 5 FOR UPDATE NOWAIT",
      expect: { inventory: ["read"] },
    },
    {
      name: "a bare trailing FOR UPDATE still resolves the FROM table",
      sql: "SELECT * FROM shipments WHERE id = 1 FOR UPDATE",
      expect: { shipments: ["read"] },
    },
    // (2) Keywords hidden in comments and string literals.
    {
      name: "a -- line comment containing DELETE FROM is ignored",
      sql: "-- DELETE FROM secrets\nSELECT id FROM users WHERE id = 1",
      expect: { users: ["read"] },
    },
    {
      name: "a /* block comment */ containing FROM is ignored",
      sql: "/* audit note: FROM ghosts */ SELECT id FROM users",
      expect: { users: ["read"] },
    },
    {
      name: "a keyword inside a string literal is ignored (real op is INSERT)",
      sql: "INSERT INTO logs (msg) VALUES ('DELETE FROM secrets')",
      expect: { logs: ["write"] },
    },
    {
      name: "the word from inside a string literal does not shadow the real FROM",
      sql: "SELECT 'shipped from warehouse' AS status FROM orders",
      expect: { orders: ["read"] },
    },
    // (3) Quoted / schema-qualified / bracketed identifiers → the bare table name.
    { name: "pg double-quoted schema.table", sql: 'SELECT * FROM "public"."Users" WHERE id = 1', expect: { Users: ["read"] } },
    { name: "pg quoted DELETE", sql: 'DELETE FROM "public"."Orders" WHERE id = 1', expect: { Orders: ["delete"] } },
    { name: "pg quoted UPDATE", sql: 'UPDATE "public"."accounts" SET balance = 0 WHERE id = 1', expect: { accounts: ["write"] } },
    { name: "mysql backtick schema.table", sql: "SELECT * FROM `shop`.`items` WHERE id = 1", expect: { items: ["read"] } },
    { name: "mssql bracketed schema.table", sql: "SELECT * FROM [dbo].[Orders] WHERE id = 1", expect: { Orders: ["read"] } },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const dir = await makeProject({
        "app.ts": `import { Router } from "express";\nconst r = Router();\nr.get("/x", (req, res) => { db.query(${JSON.stringify(c.sql)}); res.end(); });\nexport default r;\n`,
      });
      try {
        const map = await buildDataAccessMap(dir);
        assertEntities(findRoute(map, "GET", "/x"), c.expect);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

describe("buildDataAccessMap — SQL lexer hardening (hunt-2 regressions)", () => {
  const cases: Array<{ name: string; sql: string; expect: Record<string, string[]> }> = [
    {
      name: "MERGE: SET is never a table; the MERGE INTO target resolves as a write",
      sql: "MERGE INTO accounts a USING staging s ON a.id = s.id WHEN MATCHED THEN UPDATE SET bal = s.bal",
      expect: { accounts: ["write"] },
    },
    {
      name: "a FROM-less CTE body never leaks its alias as a table",
      sql: "WITH nums AS (SELECT 1 AS n) SELECT * FROM nums",
      expect: {},
    },
    {
      name: "a CTE over a real table resolves through the alias to the base table",
      sql: "WITH r AS (SELECT id FROM refunds) SELECT * FROM r",
      expect: { refunds: ["read"] },
    },
    {
      name: "a data-modifying CTE resolves its DELETE",
      sql: "WITH del AS (DELETE FROM sessions WHERE old = 1 RETURNING id) SELECT count(*) FROM del",
      expect: { sessions: ["delete"] },
    },
    {
      name: "a backslash-escaped quote inside a string does not leak its content",
      sql: "SELECT 'Bob\\'s notes from archive' AS label, id FROM contacts",
      expect: { contacts: ["read"] },
    },
    {
      name: "a double-quoted (MySQL) string value containing from is not a table",
      sql: 'SELECT "shipped from ghosts" AS c, id FROM payments',
      expect: { payments: ["read"] },
    },
    {
      name: "EXTRACT(MONTH FROM col) does not shadow the real FROM",
      sql: 'SELECT EXTRACT(MONTH FROM created_at) AS m FROM "public"."orders" WHERE id = $1',
      expect: { orders: ["read"] },
    },
    {
      name: "a quoted identifier containing a dot survives whole",
      sql: 'SELECT * FROM "public"."Order.Items" WHERE id = $1',
      expect: { "Order.Items": ["read"] },
    },
    {
      name: "a string value with FROM <word> before the real FROM is masked",
      sql: "SELECT id, 'shipped FROM warehouse #42' AS status FROM real_orders",
      expect: { real_orders: ["read"] },
    },
    {
      name: "a string value with UPDATE <word> is not a write",
      sql: "SELECT id, 'please UPDATE catalog #now' AS msg FROM real_products",
      expect: { real_products: ["read"] },
    },
    {
      name: "a string value with DELETE FROM <word> is not a delete",
      sql: "SELECT id, 'items to DELETE FROM cart #urgent' AS note FROM real_wishlist",
      expect: { real_wishlist: ["read"] },
    },
    {
      name: "a string value containing -- does not comment out the rest",
      sql: "SELECT id, 'moved from promos -- archived' AS note FROM real_cart",
      expect: { real_cart: ["read"] },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const dir = await makeProject({
        "app.ts": `import { Router } from "express";\nconst r = Router();\nr.get("/x", (req, res) => { db.query(${JSON.stringify(c.sql)}); res.end(); });\nexport default r;\n`,
      });
      try {
        const map = await buildDataAccessMap(dir);
        assertEntities(findRoute(map, "GET", "/x"), c.expect);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  test("a template hole fused into the table token stays unresolved (schema, infix)", async () => {
    const dir = await makeProject({
      "app.ts": [
        'import { Router } from "express";',
        "const r = Router();",
        'r.get("/r9", (req, res) => { db.query(`SELECT * FROM public.${req.query.t} WHERE id = 1`); res.end(); });',
        'r.patch("/r10", (req, res) => { db.query(`UPDATE public.${req.query.t} SET flag = 1`); res.end(); });',
        'r.get("/r11", (req, res) => { db.query(`SELECT * FROM us${req.query.x}ers WHERE id = 1`); res.end(); });',
        "export default r;",
      ].join("\n"),
    });
    try {
      const map = await buildDataAccessMap(dir);
      assert.deepEqual(findRoute(map, "GET", "/r9").entities, []);
      assert.deepEqual(findRoute(map, "PATCH", "/r10").entities, []);
      assert.deepEqual(findRoute(map, "GET", "/r11").entities, []);
      assert.equal(map.summary.unresolvedQueries, 3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("getRepository: closed method vocabulary (createQueryBuilder reads; non-query methods silent)", async () => {
    const dir = await makeProject({
      "app.ts": [
        'import { Router } from "express";',
        "const r = Router();",
        'r.get("/people", (req, res) => { getRepository(Person).createQueryBuilder("p").where("x").getMany(); res.end(); });',
        'r.delete("/unhook", (req, res) => { getRepository(Session).removeListener("evict", req.body.cb); res.end(); });',
        'r.get("/inspect", (req, res) => { getRepository(Cache).destroyer(); res.end(); });',
        'r.post("/init", (req, res) => { getRepository(Account).setup(); res.end(); });',
        'r.post("/save", (req, res) => { getRepository(Ticket).save(req.body); res.end(); });',
        'r.delete("/soft", (req, res) => { getRepository(Invoice).softDelete(1); res.end(); });',
        "export default r;",
      ].join("\n"),
    });
    try {
      const map = await buildDataAccessMap(dir);
      assertEntities(findRoute(map, "GET", "/people"), { Person: ["read"] });
      assert.deepEqual(findRoute(map, "DELETE", "/unhook").entities, []);
      assert.deepEqual(findRoute(map, "GET", "/inspect").entities, []);
      assert.deepEqual(findRoute(map, "POST", "/init").entities, []);
      assertEntities(findRoute(map, "POST", "/save"), { Ticket: ["write"] });
      assertEntities(findRoute(map, "DELETE", "/soft"), { Invoice: ["delete"] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a knex scoping call in a mutating chain is not double-counted as a read", async () => {
    const dir = await makeProject({
      "app.ts": [
        'import { Router } from "express";',
        "const r = Router();",
        'r.delete("/b", (req, res) => { db.table("orders").where("id", 1).delete(); res.end(); });',
        'r.delete("/e", (req, res) => { knex.from("contacts").where("x", 1).del(); res.end(); });',
        'r.patch("/u", (req, res) => { db.from("prices").where("id", 1).update({ v: 1 }); res.end(); });',
        // a pure-read chain keeps its read
        'r.get("/ro", (req, res) => { db.from("accounts").where("id", 1).first(); res.end(); });',
        "export default r;",
      ].join("\n"),
    });
    try {
      const map = await buildDataAccessMap(dir);
      assertEntities(findRoute(map, "DELETE", "/b"), { orders: ["delete"] });
      assertEntities(findRoute(map, "DELETE", "/e"), { contacts: ["delete"] });
      assertEntities(findRoute(map, "PATCH", "/u"), { prices: ["write"] });
      assertEntities(findRoute(map, "GET", "/ro"), { accounts: ["read"] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("buildDataAccessMap — SQL lexer hardening (hunt-3 regressions)", () => {
  const cases: Array<{ name: string; sql: string; expect: Record<string, string[]> }> = [
    {
      name: "nested block comments (PG) mask as one comment",
      sql: "/* outer /* inner */ FROM phantom_a */ SELECT * FROM customers WHERE id = $1",
      expect: { customers: ["read"] },
    },
    {
      name: "a doubled-quote-escaped identifier is rejected, never truncated",
      sql: 'SELECT * FROM "say ""hi"" tbl" WHERE id = 1',
      expect: {},
    },
    {
      name: "a derived-table alias without AS is not a table",
      sql: "SELECT * FROM (SELECT id FROM inner_orders) sub WHERE sub.id > 5",
      expect: {},
    },
    {
      name: "a recursive CTE's self-reference never leaks the alias",
      sql: "WITH RECURSIVE tree AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM tree WHERE n < 5) SELECT * FROM tree",
      expect: {},
    },
    {
      name: "a recursive CTE with a column list resolves the base table",
      sql: "WITH RECURSIVE tree(id, parent_id) AS (SELECT id, parent_id FROM nodes WHERE parent_id IS NULL UNION ALL SELECT n.id, n.parent_id FROM tree t JOIN nodes n ON n.parent_id = t.id) SELECT * FROM tree",
      expect: { nodes: ["read"] },
    },
    {
      name: "a chained CTE referencing an earlier alias stays unresolved",
      sql: "WITH base AS (SELECT 1 AS x), derived AS (SELECT x FROM base) SELECT * FROM derived",
      expect: {},
    },
    {
      name: "AS MATERIALIZED resolves through to the base table",
      sql: "WITH cached AS MATERIALIZED (SELECT * FROM reports) SELECT * FROM cached",
      expect: { reports: ["read"] },
    },
    {
      name: "a quoted CTE alias is recognized as an alias",
      sql: 'WITH "tree" AS (SELECT id FROM nodes) SELECT * FROM "tree"',
      expect: { nodes: ["read"] },
    },
    {
      name: "static INSERT with ON DUPLICATE KEY UPDATE keeps the insert target",
      sql: "INSERT INTO upsert_ok (a) VALUES (1) ON DUPLICATE KEY UPDATE a = 2",
      expect: { upsert_ok: ["write"] },
    },
    {
      name: "INSERT INTO t(a, b) with no space before the paren still captures t",
      sql: "INSERT INTO t(a, b) VALUES (1, 2)",
      expect: { t: ["write"] },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const dir = await makeProject({
        "app.ts": `import { Router } from "express";\nconst r = Router();\nr.get("/x", (req, res) => { db.query(${JSON.stringify(c.sql)}); res.end(); });\nexport default r;\n`,
      });
      try {
        const map = await buildDataAccessMap(dir);
        assertEntities(findRoute(map, "GET", "/x"), c.expect);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  test("a rejected INSERT hole never falls through to ON DUPLICATE KEY UPDATE", async () => {
    const dir = await makeProject({
      "app.ts": [
        'import { Router } from "express";',
        "const r = Router();",
        'r.get("/x", (req, res) => { db.query(`INSERT INTO ${req.query.t} (a, b) VALUES (?, ?) ON DUPLICATE KEY UPDATE a = \'x\'`); res.end(); });',
        "export default r;",
      ].join("\n"),
    });
    try {
      const map = await buildDataAccessMap(dir);
      assert.deepEqual(findRoute(map, "GET", "/x").entities, []);
      assert.equal(map.summary.unresolvedQueries, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("getRepository(...).query(rawSql) targets the SQL's table, not the entity", async () => {
    const dir = await makeProject({
      "app.ts": [
        'import { Router } from "express";',
        "const r = Router();",
        'r.post("/sweep", (req, res) => { dataSource.getRepository(User).query("DELETE FROM sessions WHERE expires_at < now()"); res.end(); });',
        'r.post("/stage", (req, res) => { dataSource.getRepository(User).preload({ id: 1 }); res.end(); });',
        "export default r;",
      ].join("\n"),
    });
    try {
      const map = await buildDataAccessMap(dir);
      assertEntities(findRoute(map, "POST", "/sweep"), { sessions: ["delete"] });
      assertEntities(findRoute(map, "POST", "/stage"), { User: ["read"] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a non-DB '<x>Client' receiver (twilio/openai) is never a database", async () => {
    const dir = await makeProject({
      "app.ts": [
        'import { Router } from "express";',
        "const r = Router();",
        'r.post("/notify", (req, res) => { twilioClient.messages.create({ to: req.body.to }); res.end(); });',
        'r.post("/ai", (req, res) => { openaiClient.chat.completions.create({ model: "m", messages: [] }); res.end(); });',
        // a bare `client` (the idiomatic PrismaClient binding) still counts
        'r.get("/users", (req, res) => { client.user.findMany(); res.end(); });',
        'r.get("/pg", (req, res) => { pgClient.orders.findMany(); res.end(); });',
        "export default r;",
      ].join("\n"),
    });
    try {
      const map = await buildDataAccessMap(dir);
      assert.deepEqual(findRoute(map, "POST", "/notify").entities, []);
      assert.deepEqual(findRoute(map, "POST", "/ai").entities, []);
      assertEntities(findRoute(map, "GET", "/users"), { user: ["read"] });
      assertEntities(findRoute(map, "GET", "/pg"), { orders: ["read"] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("buildDataAccessMap — non-DB receiver hardening", () => {
  test("JS globals (Buffer/Array/Object) are never mistaken for tables", async () => {
    const dir = await makeProject({
      "app.ts": [
        'import { Router } from "express";',
        "const r = Router();",
        'r.post("/util", (req, res) => {',
        '  const b = Buffer.from("SGVsbG8=", "base64");',
        '  const c = Array.from("abcdef");',
        "  const o = Object.create(null);",
        "  res.json({ b, c, o });",
        "});",
        "export default r;",
      ].join("\n"),
    });
    try {
      const map = await buildDataAccessMap(dir);
      assert.deepEqual(findRoute(map, "POST", "/util").entities, []);
      assert.equal(map.summary.unresolvedQueries, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a non-query method on a db-hint receiver is not a write/delete", async () => {
    const dir = await makeProject({
      "app.ts": [
        'import { Router } from "express";',
        "const r = Router();",
        'r.post("/setup", (req, res) => { db("config").setup(); res.end(); });',
        'r.post("/cleanup", (req, res) => { db("sessions").destroyer(); res.end(); });',
        'r.post("/detach", (req, res) => { db("events").removeListener("data", () => {}); res.end(); });',
        // controls: real knex ops must still resolve
        'r.post("/insert", (req, res) => { db("audit_log").insert({ a: 1 }); res.end(); });',
        'r.get("/first", (req, res) => { db("widgets").where({ id: 1 }).first(); res.end(); });',
        'r.post("/into", (req, res) => { db.insert({ x: 1 }).into("events_log"); res.end(); });',
        "export default r;",
      ].join("\n"),
    });
    try {
      const map = await buildDataAccessMap(dir);
      assert.deepEqual(findRoute(map, "POST", "/setup").entities, []);
      assert.deepEqual(findRoute(map, "POST", "/cleanup").entities, []);
      assert.deepEqual(findRoute(map, "POST", "/detach").entities, []);
      assertEntities(findRoute(map, "POST", "/insert"), { audit_log: ["write"] });
      assertEntities(findRoute(map, "GET", "/first"), { widgets: ["read"] });
      assertEntities(findRoute(map, "POST", "/into"), { events_log: ["write"] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("buildDataAccessMap — determinism", () => {
  test("identical input yields byte-identical JSON across runs", async () => {
    const dir = await makeProject({ "app.ts": APP, "svc.ts": SVC });
    try {
      const a = await buildDataAccessMap(dir);
      const b = await buildDataAccessMap(dir);
      assert.equal(JSON.stringify(a), JSON.stringify(b));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
