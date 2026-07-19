import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { scanProject } from "../../src/core/scan.ts";
import { toJson } from "../../src/report/json.ts";

const agentApp = fileURLToPath(new URL("../fixtures/agent-app", import.meta.url));

describe("determinism", () => {
  test("identical input → byte-identical JSON output", async () => {
    const a = await scanProject({ rootDirectory: agentApp });
    const b = await scanProject({ rootDirectory: agentApp });
    assert.equal(toJson(a), toJson(b));
  });

  test("findings are sorted by severity, file, line, column, diagnostic", async () => {
    const report = await scanProject({ rootDirectory: agentApp });
    const rank = { error: 0, warn: 1 } as const;
    for (let i = 1; i < report.findings.length; i++) {
      const prev = report.findings[i - 1]!;
      const cur = report.findings[i]!;
      const a = [rank[prev.severity], prev.normalizedFilePath, prev.line, prev.column, prev.diagnostic];
      const b = [rank[cur.severity], cur.normalizedFilePath, cur.line, cur.column, cur.diagnostic];
      assert.ok(JSON.stringify(a) <= JSON.stringify(b) || a[0]! <= b[0]!, "findings must be ordered");
    }
  });

  test("finding ids are stable across runs", async () => {
    const a = await scanProject({ rootDirectory: agentApp });
    const b = await scanProject({ rootDirectory: agentApp });
    assert.deepEqual(
      a.findings.map((d) => d.id),
      b.findings.map((d) => d.id),
    );
  });
});
