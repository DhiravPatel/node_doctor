/**
 * §195 — `no-detached-child-without-unref`.
 *
 * `detached: true` without `unref()` is a parent that cannot exit. The claim is
 * "this handle is never unref'd", so every way it could be — a later line, a
 * callback, a guard, an escape out of the function — is a silence.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noDetachedChildWithoutUnref } from "../../src/diagnostics/async/no-detached-child-without-unref.ts";

const CAPS = new Set(["node", "esm", "typescript"]);

const findings = (source: string) =>
  lintSource({
    filePath: "/repo/a.ts",
    sourceText: source,
    diagnostics: [noDetachedChildWithoutUnref],
    capabilities: CAPS,
  }).findings.filter((f) => f.diagnostic === "no-detached-child-without-unref");

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

const IMPORT = `import { spawn } from "node:child_process";\n`;

describe("no-detached-child-without-unref — fires", () => {
  test("a detached spawn with no unref anywhere", () => {
    const [f] = fires(`${IMPORT}const child = spawn("node", ["worker.js"], { detached: true, stdio: "ignore" });`);
    assert.match(f!.message, /unref/);
    assert.match(f!.message, /child\.unref/);
  });

  test("the namespace form binds the same way", () => {
    fires(`import cp from "node:child_process";\nconst child = cp.spawn("node", [], { detached: true });`);
    fires(`import * as cp from "child_process";\nconst child = cp.fork("w.js", [], { detached: true });`);
  });

  test("the CJS require forms bind the same way", () => {
    fires(`const { fork } = require("child_process");\nconst child = fork("w.js", [], { detached: true });`);
    fires(`const cp = require("node:child_process");\nconst child = cp.spawn("n", [], { detached: true });`);
  });

  test("`execFile` and `exec` return the same long-lived handle", () => {
    fires(`import { execFile } from "node:child_process";\nconst child = execFile("n", [], { detached: true });`);
  });

  test("using the handle for something OTHER than unref is still a finding", () => {
    // `child.on("exit", ...)` reads the handle; it does not release the loop.
    fires(`${IMPORT}const child = spawn("n", [], { detached: true });\nchild.on("exit", () => {});`);
  });

  test("inside a function body, with the search scoped to that body", () => {
    fires(`${IMPORT}function start() {\n  const child = spawn("n", [], { detached: true });\n  child.on("error", () => {});\n}`);
  });
});

describe("no-detached-child-without-unref — silent", () => {
  test("`unref()` on the next line", () => {
    silent(`${IMPORT}const child = spawn("n", [], { detached: true });\nchild.unref();`);
  });

  test("`unref()` in a callback, in a guard, or in a `finally`", () => {
    // Proving it runs on EVERY path needs a control-flow graph this engine does
    // not have. Proving it is absent needs nothing but syntax — so any mention
    // of `unref` on the binding ends the claim.
    silent(`${IMPORT}const child = spawn("n", [], { detached: true });\nprocess.nextTick(() => child.unref());`);
    silent(`${IMPORT}const child = spawn("n", [], { detached: true });\nif (background) child.unref();`);
    silent(`${IMPORT}const child = spawn("n", [], { detached: true });\ntry { go(); } finally { child.unref(); }`);
  });

  test("a dynamic member could BE the unref", () => {
    silent(`${IMPORT}const child = spawn("n", [], { detached: true });\nchild[method]();`);
  });

  test("the handle escapes, so the unref may be out of sight", () => {
    silent(`${IMPORT}export function start() { const child = spawn("n", [], { detached: true }); return child; }`);
    silent(`${IMPORT}const child = spawn("n", [], { detached: true });\ntrack(child);`);
    silent(`${IMPORT}const child = spawn("n", [], { detached: true });\nconst alias = child;`);
    silent(`${IMPORT}const child = spawn("n", [], { detached: true });\nstate.child = child;`);
  });

  test("`detached` is not provably true", () => {
    silent(`${IMPORT}const child = spawn("n", [], { detached: options.background });`);
    silent(`${IMPORT}const child = spawn("n", [], { detached: isCI ? true : false });`);
    silent(`${IMPORT}const child = spawn("n", [], { detached: false });`);
    silent(`${IMPORT}const child = spawn("n", [], { stdio: "ignore" });`);
    silent(`${IMPORT}const child = spawn("n", []);`);
  });

  test("a `spawn` that is not `child_process`'s", () => {
    // `spawn` is also cross-spawn, test helpers, and userland process pools.
    silent(`import { spawn } from "cross-spawn";\nconst child = spawn("n", [], { detached: true });`);
    silent(`const child = spawn("n", [], { detached: true });`);
    silent(`import { spawn } from "./pool.ts";\nconst child = spawn("n", [], { detached: true });`);
  });

  test("an unbound spawn has no handle to unref", () => {
    silent(`${IMPORT}spawn("n", [], { detached: true });`);
    silent(`${IMPORT}const [child] = [spawn("n", [], { detached: true })];`);
  });

  test("a non-spawner from child_process", () => {
    silent(`import { execSync } from "node:child_process";\nconst out = execSync("ls", { detached: true });`);
  });
});

describe("no-detached-child-without-unref — determinism", () => {
  test("identical source yields identical findings", () => {
    const source = `${IMPORT}const a = spawn("n", [], { detached: true });\nconst b = spawn("m", [], { detached: true });`;
    assert.equal(JSON.stringify(findings(source)), JSON.stringify(findings(source)));
    assert.equal(findings(source).length, 2);
  });
});

describe("no-detached-child-without-unref — hardened by the adversarial hunt", () => {
  test("a spread AFTER the key can overwrite it, so `detached` is not proven", () => {
    silent(`${IMPORT}const child = spawn("n", [], { detached: true, ...opts });`);
    silent(`${IMPORT}const child = spawn("n", [], { ...a, detached: true, ...b });`);
  });

  test("a spread BEFORE the key is harmless — the literal wins", () => {
    fires(`${IMPORT}const child = spawn("n", [], { ...opts, detached: true });`);
  });

  test("`unref` reached through optional chaining or a computed key", () => {
    silent(`${IMPORT}const child = spawn("n", [], { detached: true });\nchild?.unref();`);
    silent(`${IMPORT}const child = spawn("n", [], { detached: true });\nchild["unref"]();`);
  });

  test("a string or computed-string key still names the same option", () => {
    fires(`${IMPORT}const child = spawn("n", [], { "detached": true });`);
    fires(`${IMPORT}const child = spawn("n", [], { ["detached"]: true });`);
  });

  test("a shorthand from a variable is not a literal", () => {
    silent(`${IMPORT}const detached = true;\nconst child = spawn("n", [], { detached });`);
  });
});
