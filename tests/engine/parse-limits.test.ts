/**
 * The pre-parse nesting guard.
 *
 * A stack overflow inside the native parser is a SIGSEGV: the process dies with
 * no output and no `try`/`catch` can intercept it, so a single pathological file
 * takes the entire scan with it. The guard measures depth on the raw text before
 * the parser ever sees it and calls such a file unparseable — which is the honest
 * answer, and one the report can carry.
 *
 * The tests that matter most are the SILENCE ones: brackets in strings, comments
 * and template literals are not structure, and mistaking them for structure would
 * quietly stop analyzing ordinary files.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseSource } from "../../src/core/parse.ts";
import { scanProject } from "../../src/core/scan.ts";

const parses = (source: string): boolean => !parseSource("/repo/a.ts", source).parseFailed;

describe("nesting guard — refuses only what would kill the process", () => {
  test("a file nested past the parser's stack limit is a parse failure, not a crash", () => {
    const result = parseSource("/repo/generated.ts", "(".repeat(2000) + ")".repeat(2000));
    assert.equal(result.parseFailed, true);
    assert.match(result.errors[0]!, /nesting deeper than \d+ brackets/);
    assert.deepEqual(result.program.body, [], "an empty program, so every rule sees nothing");
  });

  test("the guard runs before the parser, so the process survives", () => {
    // The point of the whole mechanism: this line used to end the process.
    assert.doesNotThrow(() => parseSource("/repo/deep.js", "[".repeat(6000)));
  });
});

describe("nesting guard — brackets that are not structure", () => {
  test("brackets inside string literals do not count", () => {
    assert.ok(parses(`const s = "((((((((((";\n`.repeat(400)));
    assert.ok(parses(`const s = '{{{{{{{{{{';\n`.repeat(400)));
  });

  test("brackets inside comments do not count", () => {
    assert.ok(parses(`// (((((((((((\n`.repeat(400)));
    assert.ok(parses(`/* [[[[[[[[[[[ */\n`.repeat(400)));
  });

  test("template literals stay balanced, including nested ones", () => {
    assert.ok(parses("const a = `x${ `y${ z }` }w`;\n".repeat(300)));
    assert.ok(parses("const a = `text ( with ( parens`;\n".repeat(600)));
  });

  test("ordinary code is untouched", () => {
    assert.ok(parses(`export const f = (a: number) => ({ b: [a, { c: 1 }] });`));
    assert.ok(parses(`function deep() { return { a: { b: { c: [1, [2, [3]]] } } }; }`));
  });
});

describe("nesting guard — a scan containing such a file still completes", () => {
  test("the pathological file is reported, the rest of the project is still analyzed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-deep-"));
    try {
      await writeFile(join(dir, "package.json"), `{ "name": "d", "version": "1.0.0", "type": "module" }`);
      await writeFile(join(dir, "deep.js"), "[".repeat(6000));
      await writeFile(
        join(dir, "app.js"),
        `import { createHash } from "node:crypto";\n` +
          `export const hashPassword = (password) => createHash("md5").update(password).digest("hex");\n`,
      );

      const report = await scanProject({ rootDirectory: dir });
      assert.equal(report.project.complete, false, "a file we could not read is a coverage gap");
      const failure = report.project.parseFailures.find((f) => f.normalizedFilePath.endsWith("deep.js"));
      assert.ok(failure, "the file that could not be analyzed is named");
      assert.match(failure.message, /nesting deeper than/, "…and the reason is stated");
      assert.ok(
        report.findings.some((f) => f.diagnostic === "no-weak-hash-for-password"),
        "the rest of the project was still scanned",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
