import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { scanProject } from "../../src/core/scan.ts";

const agentApp = fileURLToPath(new URL("../fixtures/agent-app", import.meta.url));

describe("config", () => {
  test("diagnostics: { <id>: 'off' } disables a diagnostic", async () => {
    const base = await scanProject({ rootDirectory: agentApp });
    assert.ok(base.findings.some((d) => d.diagnostic === "no-sync-io-in-request-path"));

    const configured = await scanProject({
      rootDirectory: agentApp,
      config: { diagnostics: { "no-sync-io-in-request-path": "off" } },
    });
    assert.ok(!configured.findings.some((d) => d.diagnostic === "no-sync-io-in-request-path"));
  });

  test("diagnostics: { <id>: 'error' } upgrades a warning", async () => {
    const configured = await scanProject({
      rootDirectory: agentApp,
      config: { diagnostics: { "require-fetch-timeout": "error" } },
    });
    const fetchFindings = configured.findings.filter((d) => d.diagnostic === "require-fetch-timeout");
    assert.ok(fetchFindings.length > 0);
    assert.ok(fetchFindings.every((d) => d.severity === "error"));
  });

  test("ignoreTags disables a whole family", async () => {
    const configured = await scanProject({
      rootDirectory: agentApp,
      config: { ignoreTags: ["injection"] },
    });
    assert.ok(!configured.findings.some((d) => d.tags.includes("injection")));
  });

  test("ignoredTags option (from --ignore-tag) also works", async () => {
    const configured = await scanProject({
      rootDirectory: agentApp,
      ignoredTags: new Set(["async"]),
    });
    assert.ok(!configured.findings.some((d) => d.tags.includes("async")));
  });
});
