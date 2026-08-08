/**
 * §194 — `no-literal-listener-removal`.
 *
 * Removal matches by reference identity. A function written at the removal site
 * — a literal, or a fresh `.bind(…)` — was never registered, so the call removes
 * nothing and the listener stays attached.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noLiteralListenerRemoval } from "../../src/diagnostics/reliability/no-literal-listener-removal.ts";

const findings = (source: string, filePath = "/repo/src/server.ts") =>
  lintSource({
    filePath,
    sourceText: source,
    diagnostics: [noLiteralListenerRemoval],
    capabilities: new Set(["node", "esm", "typescript"]),
  }).findings.filter((f) => f.diagnostic === "no-literal-listener-removal");

const fires = (source: string, filePath?: string) => {
  const found = findings(source, filePath);
  assert.ok(found.length > 0, `expected a FIRE on:\n${source}`);
  return found;
};

const silent = (source: string, filePath?: string): void => {
  const found = findings(source, filePath);
  assert.equal(found.length, 0, `expected SILENCE, got ${found.length}:\n${source}`);
};

describe("no-literal-listener-removal — fires", () => {
  test("a function literal removes nothing", () => {
    const [f] = fires(`socket.off("data", (c) => handle(c));`);
    assert.match(f!.message, /reference identity/);
    assert.match(f!.message, /stays attached/);
  });

  test("every removal API matches the same way", () => {
    fires(`emitter.removeListener("done", function () {});`);
    fires(`el.removeEventListener("click", () => {});`);
  });

  test("`.bind(…)` returns a NEW function every time, and says so", () => {
    const [f] = fires(`emitter.removeListener("done", this.finish.bind(this));`);
    assert.match(f!.message, /NEW function every time/);
  });

  test("the real shape found in the wild: bind on both sides", () => {
    // Adding with `.bind(this)` and removing with another `.bind(this)` is
    // three distinct function objects, and the listener never detaches.
    fires(
      `class V {\n  mount() { this.editor.on("update", this.onUpdate.bind(this)); }\n  destroy() { this.editor.off("update", this.onUpdate.bind(this)); }\n}`,
    );
  });
});

describe("no-literal-listener-removal — silent", () => {
  test("an identifier may well be the same function", () => {
    silent(`socket.off("data", onData);`);
    silent(`emitter.off("x", this.handler);`);
    silent(`emitter.removeListener("x", handlers.get(id));`);
  });

  test("`removeAllListeners` takes no function", () => {
    silent(`emitter.removeAllListeners("x");`);
    silent(`emitter.off("x");`);
  });

  test("a bare `off(…)` with no receiver is somebody else's API", () => {
    silent(`off("x", () => {});`);
  });

  test("ADDING a listener with a literal is the correct thing to do", () => {
    silent(`socket.on("data", (c) => handle(c));`);
    silent(`el.addEventListener("click", () => {});`);
  });
});

describe("no-literal-listener-removal — hardened by the adversarial hunt", () => {
  test("a TEST FILE is inert", () => {
    // Every real-world instance found was a suite ASSERTING that removing an
    // unregistered listener is a safe no-op — and a test has no long-lived
    // process for the leak to accumulate in.
    silent(`ee.off("a", () => {});`, "/repo/tests/remove-listeners.js");
    silent(`QUnit.test("off is ignored", function () { hammer.off("swipeleft", function () {}); });`, "/repo/tests/unit/events.js");
    silent(`it("no-ops", () => { ee.off("a", () => {}); });`, "/repo/src/a.test.ts");
    silent(`ee.off("a", () => {});`, "/repo/src/__tests__/a.js");
  });

  test("a path that merely CONTAINS the word is production code", () => {
    fires(`ee.off("a", () => {});`, "/repo/src/tester.ts");
    fires(`ee.off("a", () => {});`, "/repo/src/testing/util.ts");
  });
});

describe("no-literal-listener-removal — determinism", () => {
  test("identical source yields identical findings", () => {
    const source = `a.off("x", () => {});\nb.removeListener("y", () => {});`;
    assert.equal(JSON.stringify(findings(source)), JSON.stringify(findings(source)));
    assert.equal(findings(source).length, 2);
  });
});
