/**
 * §190 — `no-unclonable-worker-message`.
 *
 * The structured clone algorithm's rules are mostly undecidable from syntax, so
 * the rule claims only the one case that is not: a function literal in the
 * posted value, on a proven worker port. Everything else abstains.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noUnclonableWorkerMessage } from "../../src/diagnostics/async/no-unclonable-worker-message.ts";

const CAPS = new Set(["node", "esm", "typescript"]);

const findings = (source: string) =>
  lintSource({
    filePath: "/repo/a.ts",
    sourceText: source,
    diagnostics: [noUnclonableWorkerMessage],
    capabilities: CAPS,
  }).findings.filter((f) => f.diagnostic === "no-unclonable-worker-message");

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

const IMPORT = `import { Worker } from "node:worker_threads";\nconst worker = new Worker("./w.js");\n`;

describe("no-unclonable-worker-message — fires", () => {
  test("a callback in the posted object", () => {
    const [f] = fires(`${IMPORT}worker.postMessage({ rows, onDone: () => finish() });`);
    assert.match(f!.message, /DataCloneError/);
  });

  test("a function expression, and one nested in an array", () => {
    fires(`${IMPORT}worker.postMessage({ cb: function () { return 1; } });`);
    fires(`${IMPORT}worker.postMessage({ handlers: [() => 1] });`);
  });

  test("a function posted directly", () => {
    fires(`${IMPORT}worker.postMessage(() => 1);`);
  });

  test("`parentPort.postMessage` is a port too", () => {
    fires(`import { parentPort } from "node:worker_threads";\nparentPort.postMessage({ done: () => 1 });`);
  });

  test("the CJS require form binds the same way", () => {
    fires(`const { Worker } = require("worker_threads");\nconst w = new Worker("./w.js");\nw.postMessage({ cb: () => 1 });`);
  });

  test("each function literal in the payload is reported", () => {
    assert.equal(findings(`${IMPORT}worker.postMessage({ a: () => 1, b: () => 2 });`).length, 2);
  });
});

describe("no-unclonable-worker-message — silent", () => {
  test("a payload that clones cleanly", () => {
    silent(`${IMPORT}worker.postMessage({ rows, count: 3, when: new Date(), tags: new Set(["a"]) });`);
    silent(`${IMPORT}worker.postMessage(buffer);`);
  });

  test("a bare identifier might hold anything", () => {
    // "this variable might be a function" is a guess, not a claim.
    silent(`${IMPORT}worker.postMessage({ rows, onDone });`);
    silent(`${IMPORT}worker.postMessage(payload);`);
  });

  test("a function INSIDE a posted function's body is not part of the structure", () => {
    // Already a finding for the outer function; the inner one is not separately
    // cloned, and reporting it twice would be noise.
    assert.equal(findings(`${IMPORT}worker.postMessage({ cb: () => { const inner = () => 1; return inner; } });`).length, 1);
  });

  test("`postMessage` on something that is not a proven worker port", () => {
    // BroadcastChannel, MessagePort, `window`, and userland emitters all have
    // this method — and the browser's has a different remedy.
    silent(`const channel = new BroadcastChannel("x");\nchannel.postMessage({ cb: () => 1 });`);
    silent(`${IMPORT}other.postMessage({ cb: () => 1 });`);
    silent(`window.postMessage({ cb: () => 1 }, "*");`);
  });

  test("no worker_threads import means no claim", () => {
    silent(`const worker = new Worker("./w.js");\nworker.postMessage({ cb: () => 1 });`);
  });

  test("a `Worker` from somewhere else is not a worker-thread port", () => {
    silent(`import { Worker } from "./my-worker.ts";\nconst worker = new Worker();\nworker.postMessage({ cb: () => 1 });`);
  });

  test("a call with no payload", () => {
    silent(`${IMPORT}worker.postMessage();`);
  });

  test("a method that is not postMessage", () => {
    silent(`${IMPORT}worker.send({ cb: () => 1 });\nworker.on("message", () => 1);`);
  });
});

describe("no-unclonable-worker-message — determinism", () => {
  test("identical source yields identical findings", () => {
    const source = `${IMPORT}worker.postMessage({ a: () => 1 });\nworker.postMessage({ b: () => 2 });`;
    assert.equal(JSON.stringify(findings(source)), JSON.stringify(findings(source)));
    assert.equal(findings(source).length, 2);
  });
});

describe("no-unclonable-worker-message — hardened by the adversarial hunt", () => {
  test("a callback that BUILDS the payload is not part of the cloned value", async () => {
    // `map` returns an array of ids; the callback is gone before the clone runs.
    silent(`${IMPORT}const rows = [];\nworker.postMessage({ ids: rows.map((r) => r.id) });`);
    silent(`${IMPORT}const rows = [];\nworker.postMessage({ a: rows.filter((x) => x > 1), b: rows.reduce((s, x) => s + x, 0) });`);
  });

  test("a getter or setter clones its VALUE, not the accessor", () => {
    silent(`${IMPORT}worker.postMessage({ get x() { return 1; } });`);
    silent(`${IMPORT}worker.postMessage({ set x(v) {} });`);
  });

  test("a spread hides its source, so the structure is not literal", () => {
    silent(`${IMPORT}worker.postMessage({ ...base });`);
  });

  test("a parameter or catch binding SHADOWS the module-scope port", () => {
    silent(`${IMPORT}export function f(worker) { worker.postMessage({ cb: () => 1 }); }`);
    silent(`${IMPORT}try { risky(); } catch (worker) { worker.postMessage({ cb: () => 1 }); }`);
  });

  test("a method shorthand IS a cloned function and still fires", () => {
    fires(`${IMPORT}worker.postMessage({ cb() { return 1; } });`);
  });
});
