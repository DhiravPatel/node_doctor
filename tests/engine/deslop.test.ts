import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { runDeslop } from "../../src/deslop/index.ts";

const app = fileURLToPath(new URL("../fixtures/deslop-app", import.meta.url));

describe("deslop", () => {
  test("finds the unused file, export, and dependency", async () => {
    const r = await runDeslop(app);
    assert.ok(r.unusedFiles.includes("src/orphan.js"), "orphan.js should be an unused file");
    assert.ok(
      r.unusedExports.some((e) => e.file === "src/helper.js" && e.name === "unusedHelper"),
      "unusedHelper should be an unused export",
    );
    assert.ok(r.unusedDependencies.includes("left-pad"), "left-pad should be an unused dependency");
  });

  test("does not flag used file/export/dependency", async () => {
    const r = await runDeslop(app);
    assert.ok(!r.unusedFiles.includes("src/helper.js"), "helper.js is imported — used");
    assert.ok(!r.unusedExports.some((e) => e.name === "helper"), "helper is imported — used");
    assert.ok(!r.unusedDependencies.includes("picocolors"), "picocolors is imported — used");
    // The entry point (main) is never reported as unused.
    assert.ok(!r.unusedFiles.includes("src/index.js"));
  });

  test("does not double-report exports of an already-unused file", async () => {
    const r = await runDeslop(app);
    assert.ok(!r.unusedExports.some((e) => e.file === "src/orphan.js"), "orphan.js is already flagged wholesale");
  });
});
