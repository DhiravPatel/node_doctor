/**
 * Type-aware analysis (§46, `--typed`).
 *
 * The compiler adapter is exercised against a faithful stub of the exact
 * TypeScript API surface it calls, so the contract is pinned without requiring a
 * particular compiler to be installed — and so a change to which API calls are
 * made shows up here rather than at a user's first `--typed` run.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { createTypeSource, typeNameIsPromise } from "../../src/core/type-source.ts";
import { lintSource } from "../../src/core/scan.ts";
import { noFloatingPromise } from "../../src/diagnostics/typed/no-floating-promise.ts";
import type { TypeSource } from "../../src/core/type-source.ts";

// ---------------------------------------------------------------------------
// The promise classifier
// ---------------------------------------------------------------------------

describe("typeNameIsPromise", () => {
  test("recognizes the promise shapes a checker actually prints", () => {
    for (const name of ["Promise<void>", "Promise<string>", "PromiseLike<number>", "Thenable<x>", "Bluebird<T>", "Promise"]) {
      assert.equal(typeNameIsPromise(name), "promise", name);
    }
  });

  test("plain values are not promises", () => {
    for (const name of ["string", "number", "void", "User[]", "{ id: string }"]) {
      assert.equal(typeNameIsPromise(name), "not-promise", name);
    }
  });

  // `any` is the important one: a rule that treats `any` as a promise fires on
  // every untyped call in the codebase, which is the fastest way to get a
  // type-aware ruleset switched off permanently.
  test("any/unknown/error yield no answer rather than a guess", () => {
    for (const name of ["any", "unknown", "error", ""]) {
      assert.equal(typeNameIsPromise(name), "unknown", name);
    }
  });

  test("a union counts only when every arm is a promise", () => {
    assert.equal(typeNameIsPromise("Promise<void> | Promise<string>"), "promise");
    assert.equal(typeNameIsPromise("string | number"), "not-promise");
    assert.equal(typeNameIsPromise("string | Promise<void>"), "not-promise");
    assert.equal(typeNameIsPromise("any | Promise<void>"), "unknown");
  });
});

// ---------------------------------------------------------------------------
// The compiler adapter — failure paths must be loud and actionable
// ---------------------------------------------------------------------------

describe("createTypeSource", () => {
  test("missing typescript reports what to install", async () => {
    const result = await createTypeSource("/tmp/x", async () => {
      throw new Error("Cannot find module 'typescript'");
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.failure.reason, /could not be resolved/);
    assert.match(result.failure.remedy, /npm install --save-dev typescript/);
  });

  // TypeScript 7's native build ships no JS compiler API. Silently degrading
  // here would mean every typed finding vanishes with no explanation.
  test("a compiler without createProgram is refused, naming the version", async () => {
    const result = await createTypeSource("/tmp/x", async () => ({ version: "7.0.2" }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.failure.reason, /7\.0\.2/);
    assert.match(result.failure.reason, /createProgram/);
    assert.match(result.failure.remedy, /typescript@\^5/);
  });

  test("an unreadable tsconfig is refused rather than assumed", async () => {
    const result = await createTypeSource("/tmp/x", async () => ({
      version: "5.6.0",
      createProgram: () => ({ getTypeChecker: () => ({}), getSourceFile: () => undefined }),
      readConfigFile: () => ({}),
      sys: { readFile: () => undefined },
    }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.failure.reason, /tsconfig/);
  });

  /** A stub with the exact shape the adapter calls, standing in for tsc. */
  const stubCompiler = (returnTypeName: string, offsetOfCall: number) => {
    const callNode = { kind: "call", getStart: () => offsetOfCall, forEachChild: () => {} };
    return {
      version: "5.6.0",
      sys: { readFile: () => "{}" },
      readConfigFile: () => ({ config: {} }),
      parseJsonConfigFileContent: () => ({ fileNames: ["/p/a.ts"], options: {} }),
      createProgram: () => ({
        getTypeChecker: () => ({
          getTypeAtLocation: () => ({
            getCallSignatures: () => [{ getReturnType: () => ({ __ret: true }) }],
          }),
          typeToString: () => returnTypeName,
        }),
        getSourceFile: (f: string) =>
          f === "/p/a.ts"
            ? {
                forEachChild: (cb: (n: unknown) => void) => cb(callNode),
              }
            : undefined,
      }),
    };
  };

  test("resolves a call's return type through the checker", async () => {
    const result = await createTypeSource("/p", async () => stubCompiler("Promise<void>", 42));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.source.promiseKindAt("/p/a.ts", 42), "promise");
    assert.equal(result.source.promiseKindAt("/p/a.ts", 999), "unknown", "an unindexed offset must not guess");
    assert.equal(result.source.promiseKindAt("/p/other.ts", 42), "unknown", "an unknown file must not guess");
    result.source.dispose();
  });

  test("a non-promise return type is reported as such", async () => {
    const result = await createTypeSource("/p", async () => stubCompiler("string", 7));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.source.promiseKindAt("/p/a.ts", 7), "not-promise");
  });
});

// ---------------------------------------------------------------------------
// no-floating-promise
// ---------------------------------------------------------------------------

/** A type source that calls everything at `promiseOffsets` a promise. */
const sourceSaying = (kindFor: (offset: number) => "promise" | "not-promise" | "unknown"): TypeSource => ({
  promiseKindAt: (_f, offset) => kindFor(offset),
  dispose: () => {},
});

const findings = (source: string, everythingIsPromise = true) =>
  lintSource({
    filePath: "a.ts",
    sourceText: source,
    diagnostics: [noFloatingPromise],
    capabilities: new Set(["node", "esm", "typescript"]),
    typeSource: sourceSaying(() => (everythingIsPromise ? "promise" : "not-promise")),
  }).findings;

describe("no-floating-promise", () => {
  test("fires on a discarded promise-returning call", () => {
    assert.equal(findings(`function save(u: string): Promise<void> { return Promise.resolve(); }\nexport function run() { save("a"); }`).length, 1);
  });

  test("silent when the value is consumed", () => {
    assert.equal(findings(`export async function run() { await save("a"); }`).length, 0);
    assert.equal(findings(`export function run() { return save("a"); }`).length, 0);
    assert.equal(findings(`export function run() { const p = save("a"); return p; }`).length, 0);
  });

  // The documented ways to say "deliberately not awaited" must not be punished —
  // a rule that flags its own recommended fix gets disabled.
  test("silent on the explicit fire-and-forget forms", () => {
    assert.equal(findings(`export function run() { void save("a"); }`).length, 0);
    assert.equal(findings(`export function run() { save("a").catch(report); }`).length, 0);
    assert.equal(findings(`export function run() { save("a").then(ok, err); }`).length, 0);
    assert.equal(findings(`export function run() { save("a").finally(done); }`).length, 0);
  });

  test("silent when the checker says it is not a promise", () => {
    assert.equal(findings(`export function run() { compute(1); }`, false).length, 0);
  });

  // Without a type source the diagnostic must produce nothing rather than fall
  // back to a guess — the selector normally keeps it out entirely.
  test("silent with no type source at all", () => {
    const { findings: f } = lintSource({
      filePath: "a.ts",
      sourceText: `export function run() { save("a"); }`,
      diagnostics: [noFloatingPromise],
      capabilities: new Set(["node", "esm"]),
    });
    assert.equal(f.length, 0);
  });

  test("declares requiresTypes so the selector can gate it", () => {
    assert.equal(noFloatingPromise.requiresTypes, true);
  });
});
