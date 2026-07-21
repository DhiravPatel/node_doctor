import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { scanProject } from "../../src/core/scan.ts";
import { confidenceOf, CONFIDENCES } from "../../src/core/types.ts";
import { DIAGNOSTICS } from "../../src/core/registry.ts";
import { TEXT_DIAGNOSTICS } from "../../src/diagnostics/secrets/index.ts";
import { handleMessage } from "../../src/mcp/server.ts";

const agentApp = fileURLToPath(new URL("../fixtures/agent-app", import.meta.url));
const goodApp = fileURLToPath(new URL("../fixtures/good-app", import.meta.url));

const call = (name: string, args: Record<string, unknown>) =>
  handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
const textOf = (r: unknown): string =>
  ((r as { result: { content: Array<{ text: string }> } }).result.content[0]?.text) ?? "";
const isErr = (r: unknown): boolean => !!(r as { result: { isError?: boolean } }).result.isError;

// ---------------------------------------------------------------------------
// §54/§101 — confidence
// ---------------------------------------------------------------------------

describe("confidence", () => {
  test("derivation: opt-in → low, warn → medium, error → high; explicit wins", () => {
    assert.equal(confidenceOf({ severity: "warn", defaultEnabled: false }), "low");
    assert.equal(confidenceOf({ severity: "error", defaultEnabled: false }), "low");
    assert.equal(confidenceOf({ severity: "warn" }), "medium");
    assert.equal(confidenceOf({ severity: "error" }), "high");
    assert.equal(confidenceOf({ severity: "error", confidence: "low" }), "low");
  });
  test("every diagnostic resolves to a valid confidence", () => {
    for (const d of [...DIAGNOSTICS, ...TEXT_DIAGNOSTICS]) {
      assert.ok(CONFIDENCES.includes(confidenceOf(d)), `${d.id} → ${confidenceOf(d)}`);
    }
  });
  test("every finding carries a confidence, and a config severity downgrade does not change it", async () => {
    const base = await scanProject({ rootDirectory: agentApp });
    assert.ok(base.findings.length > 0);
    for (const f of base.findings) assert.ok(CONFIDENCES.includes(f.confidence));

    const target = base.findings.find((f) => f.severity === "error")!;
    const downgraded = await scanProject({
      rootDirectory: agentApp,
      config: { diagnostics: { [target.diagnostic]: "warn" } },
    });
    const same = downgraded.findings.find((f) => f.diagnostic === target.diagnostic)!;
    assert.equal(same.severity, "warn", "severity is downgraded by config");
    assert.equal(same.confidence, target.confidence, "confidence is a property of the analysis, not the config");
  });
});

// ---------------------------------------------------------------------------
// §104 — provenance
// ---------------------------------------------------------------------------

describe("provenance", () => {
  test("report carries toolVersion, ruleset/config hashes, and capabilities", async () => {
    const report = await scanProject({ rootDirectory: goodApp });
    const p = report.provenance;
    assert.match(p.toolVersion, /^\d+\.\d+\.\d+/);
    assert.match(p.rulesetHash, /^[0-9a-f]{16}$/);
    assert.match(p.configHash, /^[0-9a-f]{16}$/);
    assert.ok(Array.isArray(p.capabilities));
    assert.deepEqual(p.capabilities, [...p.capabilities].sort(), "capabilities are sorted");
  });
  test("identical inputs → identical provenance (reproducible)", async () => {
    const a = await scanProject({ rootDirectory: goodApp });
    const b = await scanProject({ rootDirectory: goodApp });
    assert.deepEqual(a.provenance, b.provenance);
  });
  test("changing the ruleset changes rulesetHash; changing config changes configHash", async () => {
    const base = await scanProject({ rootDirectory: goodApp });
    const ruleChanged = await scanProject({
      rootDirectory: goodApp,
      config: { diagnostics: { "no-eval-with-input": "off" } },
    });
    assert.notEqual(base.provenance.rulesetHash, ruleChanged.provenance.rulesetHash);
    assert.notEqual(base.provenance.configHash, ruleChanged.provenance.configHash);
  });
});

// ---------------------------------------------------------------------------
// §49 — MCP check_snippet + scan_diff
// ---------------------------------------------------------------------------

describe("MCP: check_snippet", () => {
  test("is advertised in tools/list", async () => {
    const list = (await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
      result: { tools: Array<{ name: string }> };
    };
    const names = list.result.tools.map((t) => t.name);
    assert.ok(names.includes("node_doctor_check_snippet"));
    assert.ok(names.includes("node_doctor_scan_diff"));
  });
  test("flags a defect in a fragment before it is written, with confidence", async () => {
    const r = await call("node_doctor_check_snippet", {
      code: 'app.get("/x",(req,res)=>{ const o=eval(req.query.c); res.send(o); });',
      filePath: "src/r.ts",
    });
    assert.equal(isErr(r), true);
    assert.match(textOf(r), /no-eval-with-input/);
    assert.match(textOf(r), /\[high confidence\]/);
    assert.match(textOf(r), /BEFORE writing/);
  });
  test("passes clean code", async () => {
    const r = await call("node_doctor_check_snippet", { code: "export const add=(a,b)=>a+b;", filePath: "src/u.ts" });
    assert.equal(isErr(r), false);
    assert.match(textOf(r), /No node\.doctor findings/);
  });
  test("reports a syntax error instead of pretending the snippet is clean", async () => {
    const r = await call("node_doctor_check_snippet", { code: "const x = (((", filePath: "src/b.ts" });
    assert.equal(isErr(r), true);
    assert.match(textOf(r), /did not parse/);
  });
  test("requires code", async () => {
    const r = await call("node_doctor_check_snippet", { code: "   " });
    assert.equal(isErr(r), true);
  });
});

describe("MCP: scan_diff", () => {
  test("reports only introduced findings against a baseline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-mcpdiff-"));
    try {
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src", "a.js"), "export const add=(a,b)=>a+b;\n");
      const baseline = await scanProject({ rootDirectory: dir });
      await writeFile(join(dir, "baseline.json"), JSON.stringify(baseline));

      // introduce a defect
      await writeFile(join(dir, "src", "b.js"), 'app.get("/x",(req,res)=>{ const o=eval(req.query.c); res.send(o); });\n');
      const r = await call("node_doctor_scan_diff", { directory: dir, baselinePath: join(dir, "baseline.json") });
      assert.match(textOf(r), /1 finding\(s\) introduced/);
      assert.match(textOf(r), /no-eval-with-input/);
      assert.equal(isErr(r), true, "blocking=error → isError");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("clean delta when nothing changed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-mcpdiff2-"));
    try {
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src", "a.js"), "export const add=(a,b)=>a+b;\n");
      const baseline = await scanProject({ rootDirectory: dir });
      await writeFile(join(dir, "baseline.json"), JSON.stringify(baseline));
      const r = await call("node_doctor_scan_diff", { directory: dir, baselinePath: join(dir, "baseline.json") });
      assert.match(textOf(r), /No findings introduced/);
      assert.equal(isErr(r), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("missing baseline is a clear error, not a crash", async () => {
    const r = await call("node_doctor_scan_diff", { baselinePath: "/nope/does-not-exist.json" });
    assert.equal(isErr(r), true);
    assert.match(textOf(r), /cannot read baseline/);
  });
});
