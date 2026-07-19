import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { DIAGNOSTICS } from "../../src/core/registry.ts";

const caps = new Set(["node", "esm", "express"]);
const scan = (source: string) =>
  lintSource({ filePath: "app.js", sourceText: source, diagnostics: DIAGNOSTICS, capabilities: caps }).findings;

describe("inline suppression", () => {
  test("disable-next-line with a reason suppresses the finding", () => {
    const diags = scan(
      `app.get("/r", (req, res) => {
  // node-doctor-disable-next-line no-sync-io-in-request-path -- one-time warmup behind a flag
  const t = require("fs").readFileSync("x", "utf8");
  res.send(t);
});`,
    );
    assert.equal(diags.filter((d) => d.diagnostic === "no-sync-io-in-request-path").length, 0);
    assert.equal(diags.filter((d) => d.diagnostic === "suppression-without-reason").length, 0);
  });

  test("disable-next-line WITHOUT a reason is itself reported", () => {
    const diags = scan(
      `app.get("/r", (req, res) => {
  // node-doctor-disable-next-line no-sync-io-in-request-path
  const t = require("fs").readFileSync("x", "utf8");
  res.send(t);
});`,
    );
    // The original finding is suppressed...
    assert.equal(diags.filter((d) => d.diagnostic === "no-sync-io-in-request-path").length, 0);
    // ...but a suppression-without-reason finding is raised.
    assert.equal(diags.filter((d) => d.diagnostic === "suppression-without-reason").length, 1);
  });

  test("block disable/enable range", () => {
    const diags = scan(
      `/* node-doctor-disable no-sync-io-in-request-path -- migration shim */
app.get("/r", (req, res) => { const t = require("fs").readFileSync("x", "utf8"); res.send(t); });
/* node-doctor-enable no-sync-io-in-request-path */`,
    );
    assert.equal(diags.filter((d) => d.diagnostic === "no-sync-io-in-request-path").length, 0);
  });

  test("a suppression for a different diagnostic does not hide the finding", () => {
    const diags = scan(
      `app.get("/r", (req, res) => {
  // node-doctor-disable-next-line no-query-in-loop -- unrelated
  const t = require("fs").readFileSync("x", "utf8");
  res.send(t);
});`,
    );
    assert.equal(diags.filter((d) => d.diagnostic === "no-sync-io-in-request-path").length, 1);
  });
});
