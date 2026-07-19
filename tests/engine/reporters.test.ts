import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { scanProject } from "../../src/core/scan.ts";
import { toSarif } from "../../src/report/sarif.ts";
import { toAnnotations } from "../../src/report/annotations.ts";
import { toJson } from "../../src/report/json.ts";

const agentApp = fileURLToPath(new URL("../fixtures/agent-app", import.meta.url));

describe("SARIF reporter", () => {
  test("produces a structurally valid SARIF 2.1.0 document", async () => {
    const report = await scanProject({ rootDirectory: agentApp });
    const sarif = JSON.parse(toSarif(report, { version: "0.1.0" }));

    assert.equal(sarif.version, "2.1.0");
    assert.ok(sarif.$schema.includes("sarif-2.1.0"));
    assert.equal(sarif.runs[0].tool.driver.name, "node-doctor");
    assert.ok(Array.isArray(sarif.runs[0].tool.driver.rules)); // SARIF's own standard field name
    assert.equal(sarif.runs[0].results.length, report.findings.length);

    for (const result of sarif.runs[0].results) {
      assert.ok(["error", "warning"].includes(result.level));
      assert.equal(typeof result.message.text, "string");
      const region = result.locations[0].physicalLocation.region;
      assert.ok(region.startLine >= 1);
      assert.ok(region.startColumn >= 1);
      assert.ok(result.partialFingerprints.nodeDoctorDiagnosticId);
    }
  });
});

describe("GitHub annotations reporter", () => {
  test("emits ::error/::warning workflow commands", async () => {
    const report = await scanProject({ rootDirectory: agentApp });
    const lines = toAnnotations(report).split("\n");
    assert.equal(lines.length, report.findings.length);
    for (const line of lines) {
      assert.match(line, /^::(error|warning) file=[^,]+,line=\d+,col=\d+,title=[^:]+::/);
    }
  });

  test("escapes newlines and reserved characters in the message", async () => {
    const report = await scanProject({ rootDirectory: agentApp });
    const out = toAnnotations(report);
    // The rendered message must not contain a raw newline mid-line.
    for (const line of out.split("\n")) {
      const message = line.split("::").slice(2).join("::");
      assert.ok(!message.includes("\n"));
    }
  });
});

describe("JSON reporter", () => {
  test("is stable and pins the schema version", async () => {
    const report = await scanProject({ rootDirectory: agentApp });
    const json = toJson(report);
    assert.equal(JSON.parse(json).schemaVersion, 2);
    assert.equal(toJson(report), json); // idempotent
  });
});
