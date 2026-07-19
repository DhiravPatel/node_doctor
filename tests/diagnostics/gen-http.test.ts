import { describe, test } from "node:test";
import { expectFires, expectSilent } from "../helpers.ts";

const express = { capabilities: ["node", "esm", "express"] };
const fastify = { capabilities: ["node", "esm", "fastify"] };
const nest = { capabilities: ["node", "esm", "nest"] };

describe("no-missing-body-size-limit", () => {
  test("silent: limit is present", () => {
    expectSilent(
      "no-missing-body-size-limit",
      `import express from "express";
       const app = express();
       app.use(express.json({ limit: "1mb" }));
       app.use(express.urlencoded({ extended: true, limit: "200kb" }));`,
      express,
    );
  });

  test("silent: res.json() and unrelated .json() are untouched", () => {
    expectSilent(
      "no-missing-body-size-limit",
      `app.get("/", (req, res) => res.json({ ok: true }));
       const data = await fetch(url).then((r) => r.json());`,
      express,
    );
  });

  test("fires: express.json() with no options", () => {
    expectFires(
      "no-missing-body-size-limit",
      `import express from "express";
       const app = express();
       app.use(express.json());`,
      express,
    );
  });

  test("fires: express.urlencoded with options but no limit", () => {
    expectFires(
      "no-missing-body-size-limit",
      `import express from "express";
       const app = express();
       app.use(express.urlencoded({ extended: true }));`,
      express,
    );
  });
});

describe("no-send-after-next", () => {
  test("silent: next() is returned", () => {
    expectSilent(
      "no-send-after-next",
      `function mw(req, res, next) {
         if (!req.user) return next(new Error("unauth"));
         res.json({ ok: true });
       }`,
      express,
    );
  });

  test("silent: next() is the last statement", () => {
    expectSilent(
      "no-send-after-next",
      `function mw(req, res, next) {
         req.startTime = Date.now();
         next();
       }`,
      express,
    );
  });

  test("fires: response sent after a bare next()", () => {
    expectFires(
      "no-send-after-next",
      `function mw(req, res, next) {
         next(err);
         res.status(500).json({ error: "boom" });
       }`,
      express,
    );
  });
});

describe("require-error-handling-middleware", () => {
  test("silent: routes plus a 4-arg error handler", () => {
    expectSilent(
      "require-error-handling-middleware",
      `import express from "express";
       const app = express();
       app.get("/users", (req, res) => res.json([]));
       app.post("/users", (req, res) => res.status(201).end());
       app.use((err, req, res, next) => res.status(500).json({ error: "internal" }));`,
      express,
    );
  });

  test("silent: file registers no routes", () => {
    expectSilent(
      "require-error-handling-middleware",
      `import express from "express";
       const app = express();
       app.use(express.json({ limit: "1mb" }));`,
      express,
    );
  });

  test("fires: routes with no error handler", () => {
    expectFires(
      "require-error-handling-middleware",
      `import express from "express";
       const app = express();
       app.get("/users", (req, res) => res.json([]));
       app.post("/orders", (req, res) => res.status(201).end());`,
      express,
    );
  });
});

describe("no-trust-proxy-true", () => {
  test("silent: a specific hop count", () => {
    expectSilent(
      "no-trust-proxy-true",
      `const app = express();
       app.set("trust proxy", 1);`,
      express,
    );
  });

  test("silent: a subnet allowlist string", () => {
    expectSilent(
      "no-trust-proxy-true",
      `const app = express();
       app.set("trust proxy", "loopback, 10.0.0.0/8");`,
      express,
    );
  });

  test("fires: trust proxy set to true", () => {
    expectFires(
      "no-trust-proxy-true",
      `const app = express();
       app.set("trust proxy", true);`,
      express,
    );
  });
});

describe("fastify-missing-schema", () => {
  test("silent: method form with a schema", () => {
    expectSilent(
      "fastify-missing-schema",
      `const fastify = require("fastify")();
       fastify.get("/users/:id", { schema: { params: S } }, async (req, reply) => reply.send({}));`,
      fastify,
    );
  });

  test("silent: two-arg method form has no options object", () => {
    expectSilent(
      "fastify-missing-schema",
      `const fastify = require("fastify")();
       fastify.get("/health", async (req, reply) => reply.send({ ok: true }));`,
      fastify,
    );
  });

  test("silent: route() form with a schema", () => {
    expectSilent(
      "fastify-missing-schema",
      `fastify.route({ method: "POST", url: "/users", schema: { body: S }, handler: h });`,
      fastify,
    );
  });

  test("fires: method form (path, options, handler) with no schema", () => {
    expectFires(
      "fastify-missing-schema",
      `const fastify = require("fastify")();
       fastify.post("/users", { onRequest: auth }, async (req, reply) => reply.send({}));`,
      fastify,
    );
  });

  test("fires: route() form with no schema", () => {
    expectFires(
      "fastify-missing-schema",
      `fastify.route({ method: "POST", url: "/users", handler: h });`,
      fastify,
    );
  });
});

describe("nest-missing-validation-pipe", () => {
  test("silent: file wires up a ValidationPipe", () => {
    expectSilent(
      "nest-missing-validation-pipe",
      `import { ValidationPipe } from "@nestjs/common";
       @Controller("users")
       class UsersController {
         @Post()
         create(@Body() dto) { return dto; }
       }`,
      nest,
    );
  });

  test("silent: @Body('field') binds a sub-field, not the whole body", () => {
    expectSilent(
      "nest-missing-validation-pipe",
      `@Controller("users")
       class UsersController {
         @Post()
         create(@Body("id") id) { return id; }
       }`,
      nest,
    );
  });

  test("fires: bare @Body() with no validation in the file", () => {
    expectFires(
      "nest-missing-validation-pipe",
      `@Controller("users")
       class UsersController {
         @Post()
         create(@Body() dto) { return dto; }
       }`,
      nest,
    );
  });
});
