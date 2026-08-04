import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { scanProject } from "../../src/core/scan.ts";
import { toHtml } from "../../src/report/html.ts";

const agentApp = fileURLToPath(new URL("../fixtures/agent-app", import.meta.url));

describe("HTML report", () => {
  test("produces a self-contained document with the score and findings", async () => {
    const report = await scanProject({ rootDirectory: agentApp });
    const html = toHtml(report, { version: "0.1.0" });

    assert.ok(html.startsWith("<!doctype html>"));
    assert.ok(html.includes("<style>") && !html.includes("<link"), "styles are inlined, no external requests");
    assert.ok(html.includes("/100"), "shows the score");
    assert.ok(html.includes("node-doctor/no-exec-with-interpolation"), "lists diagnostic ids");
    assert.ok(html.includes(String(report.score.score)));
  });

  test("escapes HTML in messages", () => {
    const report = {
      schemaVersion: 2,
      provenance: { toolVersion: "0.0.0", rulesetHash: "t", configHash: "t", capabilities: [] },
      project: { name: "x", rootDirectory: "/x", capabilities: ["node"], analyzedFileCount: 1, totalLines: 10, complete: true, parseFailures: [], suppressedKeys: [] },
      diagnosticsRun: 1,
      diagnosticsAvailable: 1,
      findings: [
        {
          id: "1", filePath: "/x/a.js", normalizedFilePath: "a.js", line: 1, column: 1,
          plugin: "node-doctor", diagnostic: "r", title: "<script>", category: "Bugs" as const, severity: "error" as const,
          message: "<img onerror=1>", recommendation: "fix & <it>", tags: [], confidence: "high" as const,
        },
      ],
      score: { score: 0, label: "critical" as const, weighted: 0, perThousandLines: 0, byCategory: { Security: 0, Reliability: 0, Bugs: 1, Performance: 0, Maintainability: 0 } },
    };
    const html = toHtml(report);
    assert.ok(!html.includes("<script>"), "raw <script> must be escaped");
    assert.ok(html.includes("&lt;script&gt;"));
  });
});
