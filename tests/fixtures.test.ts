import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { scanProject } from "../src/core/scan.ts";
import { DIAGNOSTICS } from "../src/core/registry.ts";

const goodApp = fileURLToPath(new URL("./fixtures/good-app", import.meta.url));
const agentApp = fileURLToPath(new URL("./fixtures/agent-app", import.meta.url));

describe("fixture canaries", () => {
  test("good-app stays clean (the false-positive canary)", async () => {
    const report = await scanProject({ rootDirectory: goodApp });
    assert.equal(
      report.findings.length,
      0,
      "good-app must have ZERO findings — a false positive here is a release blocker:\n" +
        report.findings.map((d) => `  ${d.normalizedFilePath}:${d.line} ${d.diagnostic}`).join("\n"),
    );
    assert.equal(report.project.complete, true);
    assert.equal(report.score.score, 100);
    assert.equal(report.score.label, "healthy");
  });

  // The 17 "planted-bug" diagnostics agent-app was built to exercise. New diagnostics are
  // covered by their own valid/invalid tests, not by this fixture.
  const PLANTED_RULES = [
    "express-async-handler-unprotected",
    "express-missing-return-after-response",
    "cors-credentials-reflect",
    "no-sync-io-in-request-path",
    "no-process-exit-in-request-path",
    "no-async-array-callback",
    "no-unbounded-promise-all",
    "require-fetch-timeout",
    "no-exec-with-interpolation",
    "no-sql-template-interpolation",
    "secret-in-env-fallback",
    "no-timing-unsafe-secret-compare",
    "no-jwt-decode-as-verify",
    "no-weak-hash-for-password",
    "no-path-traversal",
    "no-query-in-loop",
    "no-unbounded-module-cache",
  ];

  test("agent-app is critical and catches every planted bug", async () => {
    const report = await scanProject({ rootDirectory: agentApp });
    assert.equal(report.score.label, "critical");

    const fired = new Set(report.findings.map((d) => d.diagnostic));
    const missing = PLANTED_RULES.filter((id) => !fired.has(id));
    assert.equal(missing.length, 0, `these planted diagnostics did not fire on agent-app: ${missing.join(", ")}`);
  });

  test("every registered diagnostic id is unique and well-formed", () => {
    const ids = DIAGNOSTICS.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, "duplicate diagnostic ids");
    for (const r of DIAGNOSTICS) {
      assert.match(r.id, /^[a-z0-9-]+$/, `diagnostic id not kebab-case: ${r.id}`);
      assert.ok(r.recommendation.length > 0, `diagnostic ${r.id} missing recommendation`);
    }
  });
});
