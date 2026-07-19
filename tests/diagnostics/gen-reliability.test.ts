import { describe, test } from "node:test";
import { expectFires, expectSilent } from "../helpers.ts";

/**
 * Generated coverage for the reliability/lifecycle diagnostic bucket. Each diagnostic gets a
 * valid case (asserted FIRST, must stay silent) and a violating case.
 */

describe("require-sigterm-handler", () => {
  test("silent: listen paired with a SIGTERM handler that drains", () => {
    expectSilent(
      "require-sigterm-handler",
      `
      import express from "express";
      const app = express();
      const server = app.listen(3000);
      process.on("SIGTERM", () => {
        server.close(() => process.exit(0));
      });
      `,
    );
  });

  test("fires: server listens but nothing handles SIGTERM", () => {
    expectFires(
      "require-sigterm-handler",
      `
      import express from "express";
      const app = express();
      app.listen(process.env.PORT || 3000);
      `,
    );
  });
});

describe("no-uncleared-module-interval", () => {
  test("silent: module interval handle is stored and unref'd", () => {
    expectSilent(
      "no-uncleared-module-interval",
      `
      function flushMetrics() {}
      const timer = setInterval(() => flushMetrics(), 5_000);
      timer.unref();
      `,
    );
  });

  test("silent: interval lives inside a function, not module scope", () => {
    expectSilent(
      "no-uncleared-module-interval",
      `
      export function startPolling(onTick) {
        return setInterval(onTick, 1_000);
      }
      `,
    );
  });

  test("fires: module-scope interval handle discarded, never cleared", () => {
    expectFires(
      "no-uncleared-module-interval",
      `
      function flushMetrics() {}
      setInterval(() => flushMetrics(), 5_000);
      `,
    );
  });
});

describe("no-listener-added-per-request", () => {
  test("silent: listener registered once at module scope", () => {
    expectSilent(
      "no-listener-added-per-request",
      `
      import express from "express";
      import { EventEmitter } from "node:events";
      const app = express();
      const bus = new EventEmitter();
      bus.on("message", (m) => console.log(m));
      app.get("/ping", (req, res) => {
        res.json({ ok: true });
      });
      `,
    );
  });

  test("silent: listener on the per-request res object", () => {
    expectSilent(
      "no-listener-added-per-request",
      `
      import express from "express";
      const app = express();
      app.get("/stream", (req, res) => {
        res.on("close", () => console.log("client gone"));
        res.write("hello");
      });
      `,
    );
  });

  test("fires: listener on a long-lived emitter inside the handler", () => {
    expectFires(
      "no-listener-added-per-request",
      `
      import express from "express";
      import { EventEmitter } from "node:events";
      const app = express();
      const bus = new EventEmitter();
      app.get("/subscribe", (req, res) => {
        bus.on("message", (m) => res.write(m));
        res.end();
      });
      `,
    );
  });
});

describe("no-throw-in-finally", () => {
  test("silent: finally only does side-effect cleanup", () => {
    expectSilent(
      "no-throw-in-finally",
      `
      export async function withTx(tx) {
        try {
          return await tx.commit();
        } finally {
          await tx.release();
        }
      }
      `,
    );
  });

  test("silent: return is inside a nested function, not the finally", () => {
    expectSilent(
      "no-throw-in-finally",
      `
      export function run(items) {
        try {
          doWork();
        } finally {
          items.forEach((i) => {
            return i;
          });
        }
      }
      `,
    );
  });

  test("fires: return inside finally overrides the try result", () => {
    expectFires(
      "no-throw-in-finally",
      `
      export async function withTx(tx) {
        try {
          return await tx.commit();
        } finally {
          return tx.release();
        }
      }
      `,
    );
  });
});

describe("no-missing-stream-error-handler", () => {
  test("silent: source stream has an error handler before piping", () => {
    expectSilent(
      "no-missing-stream-error-handler",
      `
      import fs from "node:fs";
      export function download(src, res) {
        const rs = fs.createReadStream(src);
        rs.on("error", (err) => res.destroy(err));
        rs.pipe(res);
      }
      `,
    );
  });

  test("silent: RxJS observable pipe is not a stream pipe", () => {
    expectSilent(
      "no-missing-stream-error-handler",
      `
      import { map } from "rxjs";
      export function project(obs) {
        return obs.pipe(map((x) => x + 1));
      }
      `,
    );
  });

  test("fires: bare pipe with no error handler can crash the process", () => {
    expectFires(
      "no-missing-stream-error-handler",
      `
      import fs from "node:fs";
      export function download(src, res) {
        fs.createReadStream(src).pipe(res);
      }
      `,
    );
  });
});

describe("no-infinite-retry-without-backoff", () => {
  test("silent: retry loop awaits a backoff between attempts", () => {
    expectSilent(
      "no-infinite-retry-without-backoff",
      `
      import { setTimeout as sleep } from "node:timers/promises";
      export async function connect(client) {
        while (true) {
          try {
            return await client.connect();
          } catch (err) {
            await sleep(1_000);
          }
        }
      }
      `,
    );
  });

  test("silent: bounded loop with an attempt counter", () => {
    expectSilent(
      "no-infinite-retry-without-backoff",
      `
      export async function connect(client) {
        for (let attempt = 0; ; attempt++) {
          try {
            return await client.connect();
          } catch (err) {
            if (attempt > 5) throw err;
            continue;
          }
        }
      }
      `,
    );
  });

  test("fires: tight retry loop with no delay and no cap", () => {
    expectFires(
      "no-infinite-retry-without-backoff",
      `
      export async function connect(client) {
        while (true) {
          try {
            return await client.connect();
          } catch (err) {
            continue;
          }
        }
      }
      `,
    );
  });
});
