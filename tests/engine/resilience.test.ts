import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { DIAGNOSTICS } from "../../src/core/registry.ts";
import { defineDiagnostic } from "../../src/core/types.ts";

const caps = new Set(["node", "esm"]);

describe("engine resilience", () => {
  test("a syntax error is a coverage gap, not a crash", () => {
    const result = lintSource({ filePath: "broken.js", sourceText: "const x = (;", diagnostics: DIAGNOSTICS, capabilities: caps });
    assert.equal(result.parseFailed, true);
    assert.ok(Array.isArray(result.findings)); // did not throw
  });

  test("empty file is clean", () => {
    const result = lintSource({ filePath: "empty.js", sourceText: "", diagnostics: DIAGNOSTICS, capabilities: caps });
    assert.equal(result.parseFailed, false);
    assert.equal(result.findings.length, 0);
  });

  test("deep nesting does not blow the stack", () => {
    const deep = "a" + "[0]".repeat(5000) + ";";
    assert.doesNotThrow(() => lintSource({ filePath: "deep.js", sourceText: deep, diagnostics: DIAGNOSTICS, capabilities: caps }));
  });

  test("a diagnostic that throws is skipped, not fatal", () => {
    const boom = defineDiagnostic({
      id: "boom",
      title: "explodes",
      severity: "warn",
      category: "Bugs",
      recommendation: "n/a",
      create: () => ({
        Identifier: () => {
          throw new Error("boom");
        },
      }),
    });
    const good = DIAGNOSTICS.find((r) => r.id === "no-sync-io-in-request-path")!;
    const result = lintSource({
      filePath: "app.js",
      sourceText: `app.get("/r", (req, res) => { require("fs").readFileSync("x"); });`,
      diagnostics: [boom, good],
      capabilities: caps,
    });
    // The scan completed and the good diagnostic still fired despite `boom` throwing.
    assert.ok(result.findings.some((d) => d.diagnostic === "no-sync-io-in-request-path"));
  });
});
