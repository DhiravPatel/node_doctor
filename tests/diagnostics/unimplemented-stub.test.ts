/**
 * §205 — `no-unimplemented-stub`.
 *
 * The catalog's own warning for this section is that a placeholder IDENTIFIER is
 * naming taste, not a defect. So this judges neither names nor bodies that do
 * something: only a body with zero statements whose comment says it was never
 * written — the author stating the fact, and the rule repeating it.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noUnimplementedStub } from "../../src/diagnostics/maintainability/no-unimplemented-stub.ts";

const findings = (source: string) =>
  lintSource({
    filePath: "/repo/src/orders.ts",
    sourceText: source,
    diagnostics: [noUnimplementedStub],
    capabilities: new Set(["node", "esm", "typescript"]),
  }).findings.filter((f) => f.diagnostic === "no-unimplemented-stub");

const fires = (source: string) => {
  const found = findings(source);
  assert.ok(found.length > 0, `expected a FIRE on:\n${source}`);
  return found;
};

const silent = (source: string): void => {
  const found = findings(source);
  assert.equal(
    found.length,
    0,
    `expected SILENCE, got ${found.length}:\n${found.map((f) => `  - ${f.message}`).join("\n")}\n--- source ---\n${source}`,
  );
};

describe("no-unimplemented-stub — fires", () => {
  test("a TODO where the implementation belongs, and it names the function", () => {
    const [f] = fires(`export function applyDiscount(order) {\n  // TODO: implement discount rules\n}`);
    assert.match(f!.message, /applyDiscount/);
    assert.match(f!.message, /returns `undefined` silently/);
  });

  test("every conventional tag, in a line comment or a block", () => {
    fires(`export const handler = (req, res) => {\n  // FIXME: not implemented yet\n};`);
    fires(`function f() {\n  /* TODO: implement */\n}`);
    fires(`function g() {\n  // XXX finish this\n}`);
    fires(`function h() {\n  // not implemented\n}`);
    fires(`function i() {\n  // HACK: fill this in later\n}`);
  });

  test("a method on a class or an object literal", () => {
    fires(`class Orders {\n  apply(order) {\n    // TODO: implement\n  }\n}`);
    fires(`export default {\n  apply(order) {\n    // TODO: implement\n  },\n};`);
  });

  test("an anonymous function says so rather than guessing a name", () => {
    const [f] = fires(`export default function () {\n  // TODO: implement\n}`);
    assert.match(f!.message, /This function/);
  });
});

describe("no-unimplemented-stub — silent", () => {
  test("a bare empty body is a deliberate no-op", () => {
    // A default callback, a required-but-unused hook, an interface shim.
    silent(`const noop = () => {};`);
    silent(`function f() {}`);
    silent(`emitter.on("drain", () => {});`);
  });

  test("a comment saying the emptiness is intended wins over any marker", () => {
    silent(`process.on("SIGPIPE", () => {\n  // intentionally empty: handled in the writer\n});`);
    silent(`const f = () => {\n  // no-op\n};`);
    silent(`function f() {\n  // empty by design\n}`);
    silent(`function f() {\n  // deliberately does nothing; TODO elsewhere\n}`);
    silent(`function f() {\n  // nothing to do here\n}`);
  });

  test("a body that does something is out of scope, whatever it says", () => {
    // "Is this one statement enough?" is not a question syntax answers.
    silent(`function f() {\n  // TODO: tidy this up\n  return 1;\n}`);
    silent(`function f() {\n  // TODO: implement properly\n  throw new Error("not implemented");\n}`);
  });

  test("a comment with no unfinished marker", () => {
    silent(`function f() {\n  // see RFC 1234 §4 — this case cannot occur\n}`);
    silent(`function f() {\n  // eslint-disable-next-line\n}`);
  });

  test("an expression-bodied arrow does something", () => {
    silent(`const f = () => 1;`);
  });

  test("a `catch {}` is not a function body", () => {
    silent(`try { go(); } catch {\n  // TODO: handle\n}`);
  });

  test("an INLINE CALLBACK is a required idiom, not residue", () => {
    // `req.on("error", () => {})` is what stops an unhandled `error` event
    // taking the process down; the empty body is the entire point. Next.js
    // ships exactly this, with a `// TODO: log socket errors?` beside it.
    silent(`req.on("error", (_err) => {\n  // TODO: log socket errors?\n});`);
    silent(`server.on("close", function () {\n  // TODO: cleanup\n});`);
    silent(`new Observer(() => {\n  // TODO\n});`);
  });

  test("a domain word in PROSE is not a tag", () => {
    // Both of these are real, correct code from the corpus sweep: the first
    // explains what it expects the pipe implementation to do, the second
    // describes placeholder screens. Matching either would make this a style
    // linter, which is precisely what §205 warns against.
    silent(
      `function voidCatch() {\n  // this catcher is designed to be used with pipeTo where we expect the underlying\n  // pipe implementation to forward errors but we do not want the promise to reject\n}`,
    );
    silent(`const api = {\n  removeListener: () => {\n    // Event listeners are not supported for placeholder screens\n  },\n};`);
    silent(`function f() {\n  // the stub server handles this in development\n}`);
  });

  test("a placeholder NAME is not a defect", () => {
    // The catalog's own warning: judging names makes this a style linter.
    silent(`function foo(data2, temp) {\n  return data2 + temp;\n}`);
  });
});

describe("no-unimplemented-stub — determinism", () => {
  test("identical source yields identical findings", () => {
    const source = `function a() {\n  // TODO: implement\n}\nfunction b() {\n  // FIXME: stub\n}`;
    assert.equal(JSON.stringify(findings(source)), JSON.stringify(findings(source)));
    assert.equal(findings(source).length, 2);
  });
});
