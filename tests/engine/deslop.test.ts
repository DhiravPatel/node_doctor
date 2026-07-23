import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("deslop — §154 undeclared / phantom dependencies", () => {
  test("flags imported-but-not-declared packages; excludes builtins, declared, and self", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-undeclared-"));
    try {
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "demo", dependencies: { express: "^4" } }));
      await writeFile(
        join(dir, "src", "index.ts"),
        [
          'import express from "express";', // declared → not undeclared
          'import { z } from "zod";', // undeclared
          'import fs from "node:fs";', // builtin → excluded
          'import _ from "lodash/merge";', // subpath → bare name lodash, undeclared
          'import { thing } from "demo/sub";', // self-name → excluded
          "export const app = express();",
        ].join("\n"),
      );
      const r = await runDeslop(dir);
      assert.deepEqual(r.undeclaredDependencies, ["lodash", "zod"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("respects package.json boundaries — a nested sample app is checked against ITS manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-undeclared-mono-"));
    try {
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "root", dependencies: {} }));
      await writeFile(join(dir, "root.ts"), 'export const x = 1;\n');
      // A fixture app with its OWN manifest importing express — must NOT be attributed
      // to the root manifest.
      await mkdir(join(dir, "fixtures", "app"), { recursive: true });
      await writeFile(join(dir, "fixtures", "app", "package.json"), JSON.stringify({ name: "app", dependencies: { express: "^4" } }));
      await writeFile(join(dir, "fixtures", "app", "server.ts"), 'import express from "express";\nexport default express();\n');
      const r = await runDeslop(dir);
      assert.deepEqual(r.undeclaredDependencies, [], "express belongs to the nested app manifest, not root");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
