/**
 * Shared test-suite reasoning (§173–§177).
 *
 * The catalog analyzes production code exhaustively and treats tests only as a
 * coverage number. But tests are code, and a bad test is worse than no test — it
 * is false confidence that ships. This module is the substrate the test-quality
 * rules stand on: is this file a test, where are its test bodies, and what counts
 * as an assertion inside one.
 *
 * PRECISION MODEL. Every rule built on this fires only inside a PROVEN test file,
 * because a false positive here lands on code that is already correct and makes
 * the tool look like it does not understand the project:
 *
 *   - A file qualifies only when it imports a known runner (`node:test`, vitest,
 *     jest, mocha, ava, bun:test, @jest/globals) **or** its path matches a test
 *     convention (`*.test.*`, `*.spec.*`, `__tests__/`, `/test/`, `/tests/`)
 *     AND it actually contains `describe`/`it`/`test` calls. A `utils.ts` that
 *     happens to define a function called `test` is never a test file.
 *   - Assertions are recognized across the ecosystem's dialects, and the
 *     recognizer is deliberately GENEROUS: anything that plausibly asserts counts
 *     as an assertion, because the cost of missing one (a false "this test
 *     asserts nothing" claim) is far higher than the cost of staying silent on a
 *     genuinely vacuous test.
 */

import type { AstNode } from "./types.ts";
import { getCalleeName, getStaticStringValue, staticMemberPath } from "./ast.ts";
import { collectDescendants } from "./walk.ts";

/** Packages whose import proves this file is a test. */
const RUNNER_SOURCES = new Set([
  "node:test",
  "test",
  "vitest",
  "jest",
  "@jest/globals",
  "mocha",
  "ava",
  "bun:test",
  "chai",
  "expect",
  "supertest",
  "@testing-library/react",
  "@testing-library/dom",
  "node:assert",
  "node:assert/strict",
  "assert",
  "assert/strict",
]);

/** Path shapes that conventionally mark a test file. */
const TEST_PATH = /(^|\/)(__tests__|__specs__|test|tests|spec|specs)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;

/** The functions that declare a test case. */
const TEST_DECLARATORS = new Set(["it", "test", "fit", "xit", "specify", "bench"]);
/** The functions that declare a group (not a case — a group has no assertions of its own). */
const SUITE_DECLARATORS = new Set(["describe", "context", "suite", "fdescribe", "xdescribe"]);

/**
 * Assertion entry points, across dialects. Deliberately broad — see the module
 * docstring: over-recognizing an assertion only costs recall, while
 * under-recognizing one produces a false "vacuous test" claim.
 */
const ASSERTION_ROOTS = new Set([
  "expect",
  "assert",
  "should",
  "chai",
  "sinon",
  "supertest",
  "request",
  "cy",
  "unexpected",
  "must",
  "demand",
]);

/** Node's `assert` module surface, used as `assert.equal(...)` etc. */
const ASSERT_METHODS = new Set([
  "ok", "equal", "notEqual", "strictEqual", "notStrictEqual", "deepEqual", "notDeepEqual",
  "deepStrictEqual", "notDeepStrictEqual", "throws", "doesNotThrow", "rejects", "doesNotReject",
  "match", "doesNotMatch", "fail", "ifError", "partialDeepStrictEqual",
]);

/** `t.assert(...)` / `t.is(...)` — the runner-context assertion styles (ava, node:test). */
const CONTEXT_ASSERT_METHODS = new Set([
  "assert", "is", "not", "true", "false", "truthy", "falsy", "deepEqual", "like",
  "throws", "throwsAsync", "notThrows", "notThrowsAsync", "snapshot", "pass", "fail", "regex",
]);

export interface TestCase {
  /** The `it("…", fn)` / `test("…", fn)` call node. */
  call: AstNode;
  /** The case's name, when statically readable. */
  name: string | null;
  /** The function body node (arrow/function expression). Null when the case has no callback. */
  fn: AstNode | null;
  /** True for `it.skip`/`it.todo`/`xit` — a skipped case asserts nothing by design. */
  skipped: boolean;
}

/**
 * Is this file provably a test file? Requires either a runner import or a test
 * path convention, and in the path-only case also requires real test calls.
 */
export const isTestFile = (program: AstNode, normalizedFilePath: string): boolean => {
  let importsRunner = false;
  for (const stmt of (program.body as AstNode[] | undefined) ?? []) {
    if (stmt.type === "ImportDeclaration" && typeof stmt.source?.value === "string") {
      if (RUNNER_SOURCES.has(stmt.source.value)) importsRunner = true;
    }
  }
  if (!importsRunner) {
    for (const call of collectDescendants(
      program,
      (n) => n.type === "CallExpression" && getCalleeName(n.callee as AstNode) === "require",
      undefined,
      true,
    )) {
      const spec = getStaticStringValue(((call.arguments as AstNode[] | undefined) ?? [])[0]);
      if (spec !== null && RUNNER_SOURCES.has(spec)) importsRunner = true;
    }
  }
  if (importsRunner) return true;

  // No import: a globals-style runner (jest/mocha/bun). Require BOTH the path
  // convention and actual test declarations, so a helper named `test` is safe.
  if (!TEST_PATH.test(normalizedFilePath)) return false;
  return collectDescendants(program, (n) => n.type === "CallExpression", undefined, true).some((call) => {
    const name = declaratorName(call);
    return name !== null && (TEST_DECLARATORS.has(name) || SUITE_DECLARATORS.has(name));
  });
};

/** The base name of a test declarator call, unwrapping `it.each(…)`/`test.skip`. */
const declaratorName = (call: AstNode): string | null => {
  const callee = call.callee as AstNode | undefined;
  if (!callee) return null;
  if (callee.type === "Identifier") return callee.name as string;
  if (callee.type === "MemberExpression") {
    // `it.skip(...)`, `test.concurrent(...)`, `describe.each(...)(...)`
    const path = staticMemberPath(callee);
    if (path) return path.split(".")[0] ?? null;
    const object = callee.object as AstNode | undefined;
    if (object?.type === "Identifier") return object.name as string;
  }
  // `it.each([...])("name", fn)` — the callee is itself a call.
  if (callee.type === "CallExpression") return declaratorName(callee);
  return null;
};

/** Modifiers that mean "this case does not run": skip / todo / failing. */
const isSkipped = (call: AstNode): boolean => {
  const callee = call.callee as AstNode | undefined;
  const name = declaratorName(call);
  if (name === "xit" || name === "xdescribe") return true;
  const path = callee?.type === "MemberExpression" ? staticMemberPath(callee) : null;
  if (!path) return false;
  return /\.(skip|todo|failing)\b/.test(path);
};

/** Every test CASE in the file (not suites — a suite body holds cases, not assertions). */
export const collectTestCases = (program: AstNode): TestCase[] => {
  const cases: TestCase[] = [];
  for (const call of collectDescendants(program, (n) => n.type === "CallExpression", undefined, true)) {
    const name = declaratorName(call);
    if (name === null || !TEST_DECLARATORS.has(name)) continue;

    const args = (call.arguments as AstNode[] | undefined) ?? [];
    // `it("name", fn)` — but also `it(fn)` and `test("name", { …opts }, fn)`.
    let fn: AstNode | null = null;
    for (const arg of args) {
      if (arg?.type === "ArrowFunctionExpression" || arg?.type === "FunctionExpression") {
        fn = arg;
        break;
      }
    }
    cases.push({
      call,
      name: getStaticStringValue(args[0]),
      fn,
      skipped: isSkipped(call),
    });
  }
  return cases;
};

/**
 * Does this node contain something that plausibly asserts? Broad by design.
 * Recognizes: `expect(...)`, `assert(...)`/`assert.equal(...)`, `x.should.…`,
 * `t.is(...)`, `sinon.assert.…`, `.toEqual(...)`-style matcher chains, supertest
 * `.expect(...)`, and snapshot assertions.
 */
export const containsAssertion = (node: AstNode | null | undefined): boolean => {
  if (!node) return false;

  for (const call of collectDescendants(node, (n) => n.type === "CallExpression", undefined, true)) {
    const callee = call.callee as AstNode | undefined;

    // Bare `expect(...)` / `assert(...)` / `should(...)`.
    if (callee?.type === "Identifier" && ASSERTION_ROOTS.has(callee.name as string)) return true;

    if (callee?.type === "MemberExpression") {
      const path = staticMemberPath(callee);
      const property =
        (callee.property as AstNode | undefined)?.type === "Identifier"
          ? ((callee.property as AstNode).name as string)
          : null;

      if (path) {
        const root = path.split(".")[0]!;
        // `assert.equal(...)`, `sinon.assert.calledOnce(...)`, `chai.expect(...)`
        if (ASSERTION_ROOTS.has(root)) return true;
        if (ASSERT_METHODS.has(path)) return true;
      }
      // A matcher on any receiver: `expect(x).toEqual(y)`, `res.should.have.status(200)`,
      // `x.must.be.true()`. Matching on the METHOD name keeps this dialect-agnostic.
      if (property && (property.startsWith("to") || property.startsWith("should"))) {
        // `toString`/`toJSON` etc. are not matchers — require a capital after `to`.
        if (property.startsWith("should") || /^to[A-Z]/.test(property)) return true;
      }
      if (property === "expect") return true; // supertest `.expect(200)`
      if (property && CONTEXT_ASSERT_METHODS.has(property)) {
        // `t.is(...)` — only when the receiver looks like a runner context.
        const object = callee.object as AstNode | undefined;
        if (object?.type === "Identifier" && /^(t|ctx|assert|a)$/.test(object.name as string)) return true;
      }
    }
  }

  // Property-level recognition, for chains a static path cannot resolve:
  // `getUser(1).should.have.property("id")` roots at a CALL, so `staticMemberPath`
  // returns null — but the `.should` is unmistakable. Also covers `expect(x).to.be.ok`
  // (a chain with no trailing call) and `x.should.equal(y)`.
  for (const member of collectDescendants(node, (n) => n.type === "MemberExpression", undefined, true)) {
    const property =
      !member.computed && (member.property as AstNode | undefined)?.type === "Identifier"
        ? ((member.property as AstNode).name as string)
        : null;
    if (property === "should" || property === "expect") return true;
    // A matcher reached on any chain: `.toBe`, `.toEqual`, `.toHaveBeenCalled`.
    if (property && /^to[A-Z]/.test(property)) return true;
    const path = staticMemberPath(member);
    if (path && /(^|\.)(should|expect)(\.|$)/.test(path)) return true;
  }
  return false;
};
