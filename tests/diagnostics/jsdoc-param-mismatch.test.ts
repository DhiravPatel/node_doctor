/**
 * §178 — `jsdoc-param-mismatch`.
 *
 * The association between a comment and the node it documents is the whole
 * risk: a module header read as the first function's doc, a trailing comment
 * stolen from the line above, a TypeScript overload set where one JSDoc sits
 * above several declarations that differ in parameters. Every one of those
 * produces a claim that is simply false, so the silent block below is the spec.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { jsdocParamMismatch } from "../../src/diagnostics/maintainability/jsdoc-param-mismatch.ts";

const CAPS = new Set(["node", "esm", "typescript"]);

const findings = (source: string) =>
  lintSource({
    filePath: "/repo/a.ts",
    sourceText: source,
    diagnostics: [jsdocParamMismatch],
    capabilities: CAPS,
  }).findings.filter((f) => f.diagnostic === "jsdoc-param-mismatch");

const fires = (source: string): void => {
  assert.ok(findings(source).length > 0, `expected jsdoc-param-mismatch to FIRE on:\n${source}`);
};

const silent = (source: string): void => {
  const found = findings(source);
  assert.equal(
    found.length,
    0,
    `expected jsdoc-param-mismatch to STAY SILENT, got ${found.length}:\n` +
      found.map((f) => `  - ${f.message}`).join("\n") +
      `\n--- source ---\n${source}`,
  );
};

describe("jsdoc-param-mismatch — silent", () => {
  test("the doc matches the signature", () => {
    silent(`/**\n * @param a first\n * @param b second\n */\nfunction f(a, b) {}`);
    silent(`/**\n * @param {string} name the name\n */\nexport function greet(name) {}`);
  });

  test("a parameter with no @param is incomplete documentation, not a contradiction", () => {
    silent(`/**\n * @param a first\n */\nfunction f(a, b) {}`);
  });

  test("a module header is not the first function's documentation", () => {
    // Two newlines between the block and the declaration. Reading a file header
    // as a function's doc reports every name in it against a function it was
    // never about.
    silent(`/**\n * This module charges customers.\n * @param is not a real tag here\n */\n\nexport function charge(customerId) {}`);
  });

  test("a trailing comment belongs to the line above it", () => {
    silent(`const t = 5000; /** @param nope */\nfunction f(a) {}`);
  });

  test("another comment between the block and the function breaks the association", () => {
    silent(`/**\n * @param old\n */\n// moved below\nfunction f(a) {}`);
  });

  test("a TypeScript overload set is never judged", () => {
    // One JSDoc, several declarations that share a name and differ in params.
    silent(
      `/**\n * @param value the value\n */\nexport function parse(value: string): number;\n` +
        `export function parse(input: number): string;\n` +
        `export function parse(input: unknown): unknown { return input; }`,
    );
  });

  test("any duplicated name in the file is skipped", () => {
    silent(`/**\n * @param a first\n */\nfunction f(a) {}\nfunction f(b) {}`);
  });

  test("destructured, rest and array parameters leave nothing to match", () => {
    silent(`/**\n * @param options the options\n */\nfunction f({ timeout }) {}`);
    silent(`/**\n * @param first the first\n */\nfunction f(...args) {}`);
    silent(`/**\n * @param pair the pair\n */\nfunction f([a, b]) {}`);
  });

  test("a property path or an optional bracket is not a parameter name", () => {
    silent(`/**\n * @param opts the options\n * @param opts.timeout ms\n */\nfunction f(opts) {}`);
    silent(`/**\n * @param [opts] the options\n */\nfunction f(opts) {}`);
    silent(`/**\n * @param [opts=1] the options\n */\nfunction f(opts) {}`);
  });

  test("a block with no @param tags", () => {
    silent(`/**\n * Charge a customer.\n * @returns the receipt\n */\nfunction charge(id) {}`);
  });

  test("a line comment is never JSDoc", () => {
    silent(`// @param nope\nfunction f(a) {}`);
  });

  test("a plain block comment is not JSDoc", () => {
    silent(`/* @param nope */\nfunction f(a) {}`);
  });

  test("a function with no doc at all", () => {
    silent(`export function charge(customerId, amountCents) {}`);
  });
});

describe("jsdoc-param-mismatch — fires", () => {
  test("a rename that left the doc behind", () => {
    fires(
      `/**\n * @param userId the user to charge\n * @param amount in cents\n */\n` +
        `export function charge(customerId, amountCents) {}`,
    );
  });

  test("a typed @param naming a parameter that does not exist", () => {
    fires(`/**\n * @param {string} userId the id\n */\nfunction charge(customerId) {}`);
  });

  test("an arrow function assigned to a const", () => {
    fires(`/**\n * @param userId the id\n */\nconst charge = (customerId) => {};`);
  });

  test("a class method", () => {
    fires(`class Billing {\n  /**\n   * @param userId the id\n   */\n  charge(customerId) {}\n}`);
  });

  test("a default-valued parameter is still matched by name", () => {
    fires(`/**\n * @param userId the id\n */\nfunction charge(customerId = 1) {}`);
  });

  test("a function that takes nothing at all", () => {
    fires(`/**\n * @param userId the id\n */\nfunction reset() {}`);
  });

  test("the message names both the stale tag and the real parameters", () => {
    const [f] = findings(`/**\n * @param userId the id\n */\nfunction charge(customerId) {}`);
    assert.ok(f);
    assert.match(f.message, /`userId`/);
    assert.match(f.message, /`customerId`/);
  });

  test("a nested type annotation in the tag does not break the scan", () => {
    fires(`/**\n * @param {Array<{ a: number }>} rows the rows\n */\nfunction f(items) {}`);
  });
});

describe("jsdoc-param-mismatch — determinism", () => {
  test("identical source yields identical findings", () => {
    const source =
      `/**\n * @param a1 x\n */\nfunction one(b1) {}\n` + `/**\n * @param a2 x\n */\nfunction two(b2) {}`;
    assert.equal(JSON.stringify(findings(source)), JSON.stringify(findings(source)));
    assert.equal(findings(source).length, 2);
  });
});
