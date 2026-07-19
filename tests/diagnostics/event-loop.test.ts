import { describe, test } from "node:test";
import { expectFires, expectSilent } from "../helpers.ts";

describe("no-sync-io-in-request-path", () => {
  test("silent: sync IO at module scope (boot)", () => {
    expectSilent(
      "no-sync-io-in-request-path",
      `const config = JSON.parse(fs.readFileSync("./config.json", "utf8"));`,
    );
  });
  test("silent: async IO on the request path", () => {
    expectSilent(
      "no-sync-io-in-request-path",
      `app.get("/r", async (req, res) => { const t = await fs.promises.readFile("x"); res.send(t); });`,
    );
  });
  test("silent: sync IO in a non-handler helper", () => {
    expectSilent(
      "no-sync-io-in-request-path",
      `function loadTemplateAtBoot() { return fs.readFileSync("x", "utf8"); }`,
    );
  });
  test("fires: readFileSync inside a route handler", () => {
    expectFires(
      "no-sync-io-in-request-path",
      `app.get("/r", (req, res) => { const t = fs.readFileSync("x", "utf8"); res.send(t); });`,
    );
  });
  test("fires: execSync inside a (req,res) controller", () => {
    expectFires(
      "no-sync-io-in-request-path",
      `export function handler(req, res) { const out = execSync("ls"); res.send(out); }`,
    );
  });
});

describe("no-process-exit-in-request-path", () => {
  test("silent: process.exit in an uncaughtException handler", () => {
    expectSilent(
      "no-process-exit-in-request-path",
      `process.on("uncaughtException", (err) => { logger.fatal(err); process.exit(1); });`,
    );
  });
  test("silent: process.exit at module scope (startup)", () => {
    expectSilent("no-process-exit-in-request-path", `if (!process.env.DB_URL) process.exit(1);`);
  });
  test("fires: process.exit inside a route handler", () => {
    expectFires(
      "no-process-exit-in-request-path",
      `app.get("/admin/shutdown", (req, res) => { if (req.query.confirm) process.exit(0); res.json({ ok: true }); });`,
    );
  });
});
