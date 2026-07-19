import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fixSource, FIXABLE_DIAGNOSTICS } from "../../src/fix/index.ts";

describe("autofix", () => {
  test("adds the node: prefix to core-module imports", () => {
    const { fixed, applied } = fixSource(
      "a.js",
      `import fs from "fs";\nimport { join } from "path";\n`,
    );
    assert.equal(applied, 2);
    assert.ok(fixed.includes('from "node:fs"'));
    assert.ok(fixed.includes('from "node:path"'));
  });

  test("handles require() and dynamic import()", () => {
    const { fixed, applied } = fixSource("a.js", `const cp = require("child_process");\nconst m = import("os");\n`);
    assert.equal(applied, 2);
    assert.ok(fixed.includes('require("node:child_process")'));
    assert.ok(fixed.includes('import("node:os")'));
  });

  test("leaves already-prefixed, third-party, and relative imports alone", () => {
    const src = `import fs from "node:fs";\nimport express from "express";\nimport x from "./local.js";\n`;
    const { fixed, applied } = fixSource("a.js", src);
    assert.equal(applied, 0);
    assert.equal(fixed, src);
  });

  test("does not touch a file that fails to parse", () => {
    const src = `import fs from "fs" const (;`;
    const { applied } = fixSource("a.js", src);
    assert.equal(applied, 0);
  });

  test("exposes the fixable diagnostic set", () => {
    assert.ok(FIXABLE_DIAGNOSTICS.includes("prefer-node-protocol-imports"));
  });
});
