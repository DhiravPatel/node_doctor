import { describe, test } from "node:test";
import { expectFires, expectSilent } from "../helpers.ts";

describe("express-async-handler-unprotected", () => {
  test("silent: wrapped in asyncHandler", () => {
    expectSilent(
      "express-async-handler-unprotected",
      `app.get("/u/:id", asyncHandler(async (req, res) => { const u = await db.find(req.params.id); res.json(u); }));`,
    );
  });
  test("silent: try/catch inline", () => {
    expectSilent(
      "express-async-handler-unprotected",
      `app.get("/u/:id", async (req, res, next) => { try { const u = await db.find(1); res.json(u); } catch (e) { next(e); } });`,
    );
  });
  test("silent: no await (no post-await window)", () => {
    expectSilent("express-async-handler-unprotected", `app.get("/u", async (req, res) => { res.json({ ok: true }); });`);
  });
  test("silent: retired on Express 5", () => {
    expectSilent(
      "express-async-handler-unprotected",
      `app.get("/u/:id", async (req, res) => { const u = await db.find(1); res.json(u); });`,
      { capabilities: ["node", "esm", "express", "express:5"] },
    );
  });
  test("silent: not an Express project", () => {
    expectSilent(
      "express-async-handler-unprotected",
      `app.get("/u/:id", async (req, res) => { const u = await db.find(1); res.json(u); });`,
      { capabilities: ["node", "esm"] },
    );
  });
  test("fires: bare async handler with an await", () => {
    expectFires(
      "express-async-handler-unprotected",
      `app.get("/u/:id", async (req, res) => { const u = await db.find(req.params.id); res.json(u); });`,
    );
  });
});

describe("express-missing-return-after-response", () => {
  test("silent: guard returns the response", () => {
    expectSilent(
      "express-missing-return-after-response",
      `app.post("/login", async (req, res) => { if (!req.body.email) { return res.status(400).json({ e: 1 }); } res.json({ ok: 1 }); });`,
    );
  });
  test("silent: response is the last statement (no fall-through)", () => {
    expectSilent(
      "express-missing-return-after-response",
      `app.post("/login", async (req, res) => { if (req.body.email) { res.json({ ok: 1 }); } });`,
    );
  });
  test("silent: guard has an else", () => {
    expectSilent(
      "express-missing-return-after-response",
      `app.post("/x", (req, res) => { if (a) { res.json(1); } else { res.json(2); } });`,
    );
  });
  test("fires: guard responds without return, then more code runs", () => {
    expectFires(
      "express-missing-return-after-response",
      `app.post("/login", async (req, res) => {
         if (!req.body.email) { res.status(400).json({ error: "email required" }); }
         const user = await db.user.findUnique({ where: { email: req.body.email } });
         res.json(user);
       });`,
    );
  });

  /**
   * The same bug on Fastify. The rule's logic always covered it — `reply` is in
   * `RESPONSE_ROOTS`, `send` is in `TERMINAL` — but `requires: ["express"]` meant
   * it never ran on a Fastify project. MEASURED against Fastify 5.12.1 through
   * `app.inject()`: a handler that calls `reply.send(a)` and then returns `b`
   * answers with **`a`**, silently discarding the return. Fastify 5 does not
   * throw, which is exactly why it survives — nothing in the logs marks it.
   */
  test("fires on Fastify, whose capability the family gate now admits", () => {
    expectFires(
      "express-missing-return-after-response",
      `fastify.post("/orders", async (req, reply) => {
         if (!req.body.sku) { reply.code(400).send({ error: "sku required" }); }
         const order = await createOrder(req.body);
         return order;
       });`,
      { capabilities: ["node", "esm", "fastify"] },
    );
  });

  test("silent on Fastify when the guard returns", () => {
    expectSilent(
      "express-missing-return-after-response",
      `fastify.post("/orders", async (req, reply) => {
         if (!req.body.sku) { return reply.code(400).send({ error: "sku required" }); }
         return createOrder(req.body);
       });`,
      { capabilities: ["node", "esm", "fastify"] },
    );
  });
});

describe("cors-credentials-reflect", () => {
  test("silent: explicit allowlist origin", () => {
    expectSilent(
      "cors-credentials-reflect",
      `app.use(cors({ origin: ["https://app.example.com"], credentials: true }));`,
    );
  });
  test("silent: validating origin function", () => {
    expectSilent(
      "cors-credentials-reflect",
      `app.use(cors({ origin: (o, cb) => cb(null, ALLOWED.includes(o)), credentials: true }));`,
    );
  });
  test("silent: credentials not enabled", () => {
    expectSilent("cors-credentials-reflect", `app.use(cors({ origin: true }));`);
  });
  test("fires: origin true + credentials true", () => {
    expectFires("cors-credentials-reflect", `app.use(cors({ origin: true, credentials: true }));`);
  });
  test("fires: origin * + credentials true", () => {
    expectFires("cors-credentials-reflect", `app.use(cors({ origin: "*", credentials: true }));`);
  });
  test("fires: origin function that always allows", () => {
    expectFires(
      "cors-credentials-reflect",
      `app.use(cors({ origin: (o, cb) => cb(null, true), credentials: true }));`,
    );
  });
});
