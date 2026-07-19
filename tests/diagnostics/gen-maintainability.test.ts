import { describe, test } from "node:test";
import { expectFires, expectSilent } from "../helpers.ts";

describe("prefer-node-protocol-imports", () => {
  test("silent when core modules already use node: or are third-party/relative", () => {
    expectSilent(
      "prefer-node-protocol-imports",
      `import fs from "node:fs";
       import { join } from "node:path/posix";
       import express from "express";
       import { asyncHandler } from "./middleware.js";
       const cluster = require("node:cluster");`,
    );
  });

  test("fires on a bare core-module import", () => {
    expectFires("prefer-node-protocol-imports", `import crypto from "crypto";`);
  });

  test("fires on a bare core-module require and a subpath", () => {
    expectFires("prefer-node-protocol-imports", `const { readFile } = require("fs/promises");`);
  });
});

describe("no-console-log-in-committed-code", () => {
  test("silent for console.error/console.warn and for CLI scripts", () => {
    expectSilent(
      "no-console-log-in-committed-code",
      `function charge(user) {
         console.error("charge failed", user.id);
         console.warn("retrying");
       }`,
    );
    expectSilent(
      "no-console-log-in-committed-code",
      `#!/usr/bin/env node
       console.log("usage: mytool <cmd>");`,
    );
  });

  test("fires on a stray console.log", () => {
    expectFires(
      "no-console-log-in-committed-code",
      `function handler(req) {
         console.log("got request", req.body);
         return req.body;
       }`,
    );
  });

  test("fires on console.debug", () => {
    expectFires("no-console-log-in-committed-code", `console.debug({ payload: 1 });`);
  });
});

describe("no-redundant-try-catch-rethrow", () => {
  test("silent when the catch logs, wraps, or a finally does work", () => {
    expectSilent(
      "no-redundant-try-catch-rethrow",
      `async function save(order) {
         try {
           await db.write(order);
         } catch (err) {
           logger.error(err);
           throw err;
         }
       }`,
    );
    expectSilent(
      "no-redundant-try-catch-rethrow",
      `async function save(order) {
         try {
           await db.write(order);
         } catch (err) {
           throw new SaveError("failed", { cause: err });
         }
       }`,
    );
    expectSilent(
      "no-redundant-try-catch-rethrow",
      `async function save(order) {
         try {
           await db.write(order);
         } finally {
           release();
         }
       }`,
    );
  });

  test("fires when the catch only rethrows the caught error", () => {
    expectFires(
      "no-redundant-try-catch-rethrow",
      `async function save(order) {
         try {
           await db.write(order);
         } catch (err) {
           throw err;
         }
       }`,
    );
  });
});

describe("no-dead-async", () => {
  test("silent when the function awaits or returns a possible promise", () => {
    expectSilent(
      "no-dead-async",
      `async function save(order) {
         await db.write(order);
       }`,
    );
    expectSilent(
      "no-dead-async",
      `async function fetchUser(id) {
         return db.user.find(id);
       }`,
    );
    expectSilent("no-dead-async", `async function noop() {}`);
  });

  test("fires on an async function that never awaits and returns a plain object", () => {
    expectFires(
      "no-dead-async",
      `async function currentUser(req) {
         const id = req.user.id;
         return { id, role: "user" };
       }`,
    );
  });
});

describe("no-duplicate-route-definition", () => {
  test("silent for distinct method/path/router combinations", () => {
    expectSilent(
      "no-duplicate-route-definition",
      `router.get("/users", list);
       router.post("/users", create);
       router.get("/orders", listOrders);
       adminRouter.get("/users", adminList);`,
    );
  });

  test("fires when the same method + path is registered twice", () => {
    expectFires(
      "no-duplicate-route-definition",
      `router.get("/users", listA);
       router.get("/users", listB);`,
    );
  });
});
