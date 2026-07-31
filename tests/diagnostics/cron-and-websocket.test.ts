/**
 * §30 `no-invalid-cron-expression` and §31 `no-missing-websocket-error-handler`.
 *
 * Both rules are opt-in and not in the generated registry for these tests, so we
 * import them directly and drive `lintSource` with an explicit single-rule list.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noInvalidCronExpression, checkCronExpression } from "../../src/diagnostics/reliability/no-invalid-cron-expression.ts";
import { noMissingWebsocketErrorHandler } from "../../src/diagnostics/reliability/no-missing-websocket-error-handler.ts";

const CAPS = new Set(["node", "esm", "typescript", "ws"]);

const findingsFor = (rule: typeof noInvalidCronExpression | typeof noMissingWebsocketErrorHandler, source: string) =>
  lintSource({
    filePath: "test.ts",
    sourceText: source,
    diagnostics: [rule],
    capabilities: CAPS,
  }).findings.filter((f) => f.diagnostic === rule.id);

const makeAsserts = (rule: typeof noInvalidCronExpression | typeof noMissingWebsocketErrorHandler) => ({
  fires: (source: string) => {
    const found = findingsFor(rule, source);
    assert.ok(found.length > 0, `expected ${rule.id} to FIRE on:\n${source}`);
  },
  silent: (source: string) => {
    const found = findingsFor(rule, source);
    assert.equal(
      found.length,
      0,
      `expected ${rule.id} to STAY SILENT, got ${found.length}:\n` +
        found.map((f) => `  - ${f.message}`).join("\n") +
        `\n--- source ---\n${source}`,
    );
  },
});

// ---------------------------------------------------------------------------
// §30 — no-invalid-cron-expression
// ---------------------------------------------------------------------------

const cron = makeAsserts(noInvalidCronExpression);
const CRON_IMPORT = `import cron from "node-cron";\n`;

describe("checkCronExpression — the parser in isolation", () => {
  test("accepts every valid shape", () => {
    for (const expression of [
      "* * * * *",
      "0 0 * * *",
      "*/5 * * * *",
      "0 9-17 * * 1-5",
      "0 0,12 1 */2 *",
      "30 4 1,15 * 5",
      "0 0 29 2 *", // Feb 29 — valid, just rare
      "*/10 * * * * *", // 6-field seconds form
      "59 59 23 31 12 7",
      "@daily",
      "@reboot",
      "0 0 * * SUN", // names — unmodelled, must not be claimed invalid
      "0 0 L * *", // Quartz L — unmodelled
      "0 0 ? * MON#1", // Quartz ? and # — unmodelled
    ]) {
      assert.equal(checkCronExpression(expression), null, `expected \`${expression}\` to be accepted`);
    }
  });

  test("rejects only provable errors", () => {
    for (const [expression, hint] of [
      ["0 25 * * *", "hour 25"],
      ["75 * * * *", "minute 75"],
      ["0 0 32 * *", "day-of-month 32"],
      ["0 0 * 13 *", "month 13"],
      ["0 0 * * 8", "day-of-week 8"],
      ["0 0 * *", "4 fields"],
      ["0 0 * * * * *", "7 fields"],
      ["*/0 * * * *", "zero step"],
      ["0 10-5 * * *", "reversed range"],
      ["0 0 0 * *", "day-of-month 0"],
      ["60 * * * * *", "second 60 in the 6-field form"],
    ] as Array<[string, string]>) {
      assert.notEqual(checkCronExpression(expression), null, `expected \`${expression}\` to be rejected (${hint})`);
    }
  });
});

describe("no-invalid-cron-expression", () => {
  test("fires: node-cron schedule with an out-of-range hour", () => {
    cron.fires(CRON_IMPORT + `cron.schedule("0 25 * * *", rollup);`);
  });

  test("fires: wrong field count via new CronJob", () => {
    cron.fires(`import { CronJob } from "cron";\nnew CronJob("0 0 * *", cleanup);`);
  });

  test("fires: CronJob({ cronTime }) object form", () => {
    cron.fires(`import { CronJob } from "cron";\nnew CronJob({ cronTime: "0 0 * 13 *", onTick: f });`);
  });

  test("fires: node-schedule scheduleJob", () => {
    cron.fires(`import schedule from "node-schedule";\nschedule.scheduleJob("75 * * * *", job);`);
  });

  test("fires: node-schedule named form scheduleJob(name, expr, fn)", () => {
    cron.fires(`import schedule from "node-schedule";\nschedule.scheduleJob("nightly", "0 0 32 * *", job);`);
  });

  test("fires: BullMQ repeat pattern", () => {
    cron.fires(`import { Queue } from "bullmq";\nqueue.add("sweep", {}, { repeat: { pattern: "0 0 * * 8" } });`);
  });

  test("fires: a zero step", () => {
    cron.fires(CRON_IMPORT + `cron.schedule("*/0 * * * *", tick);`);
  });

  test("silent: every valid expression", () => {
    for (const expression of ["* * * * *", "0 23 * * *", "*/5 * * * *", "0 9-17 * * 1-5", "*/10 * * * * *", "@daily"]) {
      cron.silent(CRON_IMPORT + `cron.schedule(${JSON.stringify(expression)}, job);`);
    }
  });

  test("silent: unmodelled grammar (names, Quartz L/W/#/?)", () => {
    cron.silent(CRON_IMPORT + `cron.schedule("0 0 * * SUN", job);`);
    cron.silent(CRON_IMPORT + `cron.schedule("0 0 L * *", job);`);
    cron.silent(CRON_IMPORT + `cron.schedule("0 0 ? * MON#1", job);`);
    cron.silent(CRON_IMPORT + `cron.schedule("0 0 15W * *", job);`);
  });

  test("silent: a dynamic expression is never guessed at", () => {
    cron.silent(CRON_IMPORT + `cron.schedule(config.cronExpression, job);`);
    cron.silent(CRON_IMPORT + "cron.schedule(`0 ${hour} * * *`, job);");
  });

  test("silent: no scheduler import — a cron-shaped string elsewhere is not ours", () => {
    cron.silent(`const label = "0 25 * * *";\nrender(label);`);
    cron.silent(`myThing.schedule("0 25 * * *", job);`);
  });

  test("silent: an unrelated .schedule() in a cron-importing file with a non-cron string", () => {
    cron.silent(CRON_IMPORT + `meeting.schedule("tomorrow at noon", invite);`);
  });
});

// ---------------------------------------------------------------------------
// §31 — no-missing-websocket-error-handler
// ---------------------------------------------------------------------------

const ws = makeAsserts(noMissingWebsocketErrorHandler);

describe("no-missing-websocket-error-handler", () => {
  test("fires: message + close listeners but no error listener", () => {
    ws.fires(`
      wss.on("connection", (socket) => {
        socket.on("message", handle);
        socket.on("close", cleanup);
      });
    `);
  });

  test("fires: a single message listener with no error path", () => {
    ws.fires(`
      wss.on("connection", function (socket, req) {
        socket.on("message", (data) => socket.send(process(data)));
      });
    `);
  });

  test("silent: an error listener is registered", () => {
    ws.silent(`
      wss.on("connection", (socket) => {
        socket.on("message", handle);
        socket.on("error", (err) => logger.error({ err }, "socket error"));
      });
    `);
  });

  test("silent: the socket is handed off — the handler may be attached there", () => {
    ws.silent(`
      wss.on("connection", (socket) => {
        socket.on("message", handle);
        registerSocket(socket);
      });
    `);
    ws.silent(`
      wss.on("connection", (socket) => {
        socket.on("message", handle);
        clients.add(socket);
      });
    `);
  });

  test("silent: no listener registrations at all (not wiring this emitter here)", () => {
    ws.silent(`
      wss.on("connection", (socket) => {
        socket.send("hello");
      });
    `);
  });

  test("silent: a dynamic event name", () => {
    ws.silent(`
      wss.on("connection", (socket) => {
        socket.on(eventName, handle);
      });
    `);
  });

  test("silent: addEventListener (a listener API we do not model)", () => {
    ws.silent(`
      wss.on("connection", (socket) => {
        socket.addEventListener("message", handle);
      });
    `);
  });

  test("silent: a non-connection event", () => {
    ws.silent(`
      emitter.on("data", (chunk) => {
        chunk.on("end", done);
      });
    `);
  });

  test("silent: the socket parameter is destructured (not a plain binding)", () => {
    ws.silent(`
      wss.on("connection", ({ socket }) => {
        socket.on("message", handle);
      });
    `);
  });

  test("silent: `once` counts as a registration and `once(\"error\")` satisfies it", () => {
    ws.silent(`
      wss.on("connection", (socket) => {
        socket.on("message", handle);
        socket.once("error", onErr);
      });
    `);
  });
});
