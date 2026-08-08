/**
 * §197 — `no-out-of-range-exit-code`.
 *
 * A process exit status is one byte. Node keeps `code & 0xFF`, so a code above
 * 255 becomes a different code and a nonzero code that masks to 0 reports the
 * run as a SUCCESS to every automated gate downstream.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noOutOfRangeExitCode } from "../../src/diagnostics/bugs/no-out-of-range-exit-code.ts";

const findings = (source: string) =>
  lintSource({
    filePath: "/repo/src/cli.ts",
    sourceText: source,
    diagnostics: [noOutOfRangeExitCode],
    capabilities: new Set(["node", "esm", "typescript"]),
  }).findings.filter((f) => f.diagnostic === "no-out-of-range-exit-code");

const fires = (source: string) => {
  const found = findings(source);
  assert.ok(found.length > 0, `expected a FIRE on:\n${source}`);
  return found;
};

const silent = (source: string): void => {
  const found = findings(source);
  assert.equal(found.length, 0, `expected SILENCE, got ${found.length}:\n${source}`);
};

describe("no-out-of-range-exit-code — fires", () => {
  test("256 masks to 0, and the message says the run reads as a SUCCESS", () => {
    const [f] = fires(`process.exit(256);`);
    assert.match(f!.message, /SUCCESS/);
    assert.match(f!.message, /0xFF/);
  });

  test("a code above 255 becomes a different code, and the message names it", () => {
    const [f] = fires(`process.exit(300);`);
    assert.match(f!.message, /actually sees \*\*44\*\*/);
  });

  test("`process.exitCode` is masked the same way", () => {
    fires(`process.exitCode = 1000;`);
    fires(`process.exitCode = 256;`);
  });

  test("a negative multiple of 256 also lands on success", () => {
    const [f] = fires(`process.exit(-256);`);
    assert.match(f!.message, /SUCCESS/);
  });
});

describe("no-out-of-range-exit-code — silent", () => {
  test("every code the byte can carry", () => {
    silent(`process.exit(0);`);
    silent(`process.exit(1);`);
    silent(`process.exit(2);`);
    silent(`process.exit(255);`);
    silent(`process.exitCode = 1;`);
  });

  test("`exit(-1)` is the generic-failure idiom and does what it means", () => {
    // It masks to 255 — a nonzero failure status, which is the intent.
    silent(`process.exit(-1);`);
    silent(`process.exit(-2);`);
  });

  test("a code that is not a literal is not folded", () => {
    silent(`process.exit(code);`);
    silent(`process.exit(errors.length);`);
    silent(`process.exit(config.exitCode);`);
    silent(`process.exit();`);
  });

  test("a `process` or an `exitCode` that is not the global one", () => {
    silent(`function f(process) { process.exit(256); }`);
    silent(`server.exit(256);`);
    silent(`worker.exitCode = 256;`);
    silent(`result.process.exitCode = 256;`);
  });
});

describe("no-out-of-range-exit-code — hardened by the adversarial hunt", () => {
  test("a WORKER's exit code is delivered unmasked, so nothing is masked to report", () => {
    // Verified against the runtime: a worker's exit code never reaches wait(2).
    // It is a plain JavaScript number handed to the parent's `exit` event, so
    // `process.exit(1001)` in a Worker really does deliver 1001.
    silent(`import { parentPort } from "node:worker_threads";\nparentPort.on("message", () => process.exit(1001));`);
    silent(`const { isMainThread } = require("node:worker_threads");\nif (!isMainThread) process.exitCode = 1001;`);
  });

  test("a plain CLI with no worker in sight still fires", () => {
    fires(`import { readFileSync } from "node:fs";\nif (bad) process.exit(256);`);
  });
});

describe("no-out-of-range-exit-code — determinism", () => {
  test("identical source yields identical findings", () => {
    const source = `process.exit(256);\nprocess.exitCode = 300;`;
    assert.equal(JSON.stringify(findings(source)), JSON.stringify(findings(source)));
    assert.equal(findings(source).length, 2);
  });
});
