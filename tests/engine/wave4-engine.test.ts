import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { DIAGNOSTICS_BY_ID } from "../../src/core/registry.ts";
import { classifyFileContext, isRelaxedInContext } from "../../src/core/file-context.ts";
import { suppressionNearMiss } from "../../src/core/suppress.ts";
import { parseDirectives } from "../../src/core/suppress.ts";
import { createLocator } from "../../src/core/location.ts";
import { parseSource } from "../../src/core/parse.ts";

const CONSOLE = "no-console-log-in-committed-code";
const consoleDiag = () => DIAGNOSTICS_BY_ID.get(CONSOLE)!;

// ---------------------------------------------------------------------------
// file-context classifier
// ---------------------------------------------------------------------------

describe("classifyFileContext", () => {
  test("recognizes test, script, and source roles", () => {
    assert.equal(classifyFileContext("src/user.test.ts", "x"), "test");
    assert.equal(classifyFileContext("src/__tests__/user.ts", "x"), "test");
    assert.equal(classifyFileContext("tests/user.ts", "x"), "test");
    assert.equal(classifyFileContext("bin/cli.ts", "x"), "script");
    assert.equal(classifyFileContext("scripts/build.ts", "x"), "script");
    assert.equal(classifyFileContext("deploy.ts", "#!/usr/bin/env node\n"), "script");
    assert.equal(classifyFileContext("src/service.ts", "x"), "source");
  });
  test("relaxes console.log in test/script but not source", () => {
    assert.equal(isRelaxedInContext(CONSOLE, "test"), true);
    assert.equal(isRelaxedInContext(CONSOLE, "script"), true);
    assert.equal(isRelaxedInContext(CONSOLE, "source"), false);
  });
});

describe("auto-relax through lintSource", () => {
  const src = "export function f() { console.log('debug', x); }";
  test("console.log fires in a source file", () => {
    const { findings } = lintSource({ filePath: "src/a.ts", sourceText: src, diagnostics: [consoleDiag()] });
    assert.equal(findings.length, 1);
  });
  test("console.log is auto-dropped in a test file", () => {
    const { findings } = lintSource({ filePath: "src/a.test.ts", sourceText: src, diagnostics: [consoleDiag()] });
    assert.equal(findings.length, 0);
  });
});

// ---------------------------------------------------------------------------
// suppression near-miss
// ---------------------------------------------------------------------------

const directivesOf = (src: string) => {
  const parsed = parseSource("a.ts", src);
  return parseDirectives(parsed.comments, createLocator(src));
};

describe("suppressionNearMiss", () => {
  test("flags a wrong diagnostic id on the target line", () => {
    const src = "// node-doctor-disable-next-line no-eval -- typo\nconst x = eval(inp);";
    const hint = suppressionNearMiss({ diagnostic: "no-eval-with-input", line: 2 }, directivesOf(src));
    assert.match(hint!, /targets `no-eval`, not `no-eval-with-input`/);
  });
  test("flags a disable-next-line that is a few lines too high", () => {
    const src = "// node-doctor-disable-next-line no-eval-with-input -- moved\nconst a = 1;\nconst x = eval(inp);";
    const hint = suppressionNearMiss({ diagnostic: "no-eval-with-input", line: 3 }, directivesOf(src));
    assert.match(hint!, /too high — move it directly above line 3/);
  });
  test("no hint when the disable is correct", () => {
    const src = "// node-doctor-disable-next-line no-eval-with-input -- reviewed\nconst x = eval(inp);";
    assert.equal(suppressionNearMiss({ diagnostic: "no-eval-with-input", line: 2 }, directivesOf(src)), null);
  });
});

describe("near-miss surfaces on a real finding", () => {
  test("a fired finding carries the near-miss hint", () => {
    const diag = DIAGNOSTICS_BY_ID.get("no-eval-with-input")!;
    const src = "// node-doctor-disable-next-line no-eval -- wrong id\nconst x = eval(userInput);";
    const { findings } = lintSource({ filePath: "a.ts", sourceText: src, diagnostics: [diag] });
    assert.equal(findings.length, 1);
    assert.match(findings[0]!.suppressionHint!, /did you mean `node-doctor\/no-eval-with-input`/);
  });
});
