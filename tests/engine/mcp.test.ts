import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { handleMessage } from "../../src/mcp/server.ts";

const goodApp = fileURLToPath(new URL("../fixtures/good-app", import.meta.url));

describe("MCP server", () => {
  test("initialize returns serverInfo and tool capability", async () => {
    const r = (await handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    })) as any;
    assert.equal(r.result.serverInfo.name, "node-doctor");
    assert.ok(r.result.capabilities.tools);
    assert.equal(r.result.protocolVersion, "2024-11-05");
  });

  test("tools/list advertises the node.doctor tools", async () => {
    const r = (await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as any;
    const names = r.result.tools.map((t: { name: string }) => t.name);
    assert.ok(names.includes("node_doctor_scan"));
    assert.ok(names.includes("node_doctor_diagnostics"));
    assert.ok(names.includes("node_doctor_explain"));
  });

  test("tools/call node_doctor_scan runs a real scan", async () => {
    const r = (await handleMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "node_doctor_scan", arguments: { directory: goodApp } },
    })) as any;
    assert.ok(!r.result.isError);
    assert.match(r.result.content[0].text, /100\/100 \(healthy\)/);
    assert.match(r.result.content[0].text, /"schemaVersion": 3/);
  });

  test("tools/call node_doctor_explain returns the diagnostic fix", async () => {
    const r = (await handleMessage({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "node_doctor_explain", arguments: { diagnostic: "no-sql-template-interpolation" } },
    })) as any;
    assert.match(r.result.content[0].text, /node-doctor\/no-sql-template-interpolation/);
    assert.match(r.result.content[0].text, /Fix:/);
  });

  test("unknown diagnostic is a tool error, not a crash", async () => {
    const r = (await handleMessage({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "node_doctor_explain", arguments: { diagnostic: "nope" } },
    })) as any;
    assert.equal(r.result.isError, true);
  });

  test("notifications get no reply; unknown methods return JSON-RPC error", async () => {
    assert.equal(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
    const err = (await handleMessage({ jsonrpc: "2.0", id: 9, method: "does/not/exist" })) as any;
    assert.equal(err.error.code, -32601);
  });
});
