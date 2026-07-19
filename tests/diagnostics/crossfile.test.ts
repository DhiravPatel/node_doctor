import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { scanProject } from "../../src/core/scan.ts";

const crossfile = fileURLToPath(new URL("../fixtures/crossfile", import.meta.url));

describe("no-sync-io-reachable-from-handler (Phase B, cross-file)", () => {
  test("flags a sync read in a helper reachable from a handler (through two files)", async () => {
    const report = await scanProject({ rootDirectory: crossfile });
    const hits = report.findings.filter((d) => d.diagnostic === "no-sync-io-reachable-from-handler");
    assert.equal(hits.length, 1, "exactly one cross-file sync-IO site should be flagged");
    assert.equal(hits[0]!.normalizedFilePath, "src/cache.js");
  });

  test("does NOT flag the same sync read in a helper only called at module scope", async () => {
    const report = await scanProject({ rootDirectory: crossfile });
    const bootHits = report.findings.filter((d) => d.normalizedFilePath === "src/boot.js");
    assert.equal(bootHits.length, 0, "bootOnly() is not reachable from a handler — it must stay silent");
  });

  test("the whole crossfile fixture has exactly one finding", async () => {
    const report = await scanProject({ rootDirectory: crossfile });
    assert.equal(report.findings.length, 1);
  });
});
