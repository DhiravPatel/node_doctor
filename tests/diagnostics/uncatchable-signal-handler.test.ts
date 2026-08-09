/**
 * §196 — `no-uncatchable-signal-handler`.
 *
 * `SIGKILL` and `SIGSTOP` are handled by the kernel. Node does not quietly
 * ignore a listener for them: `uv_signal_start` fails and the `EINVAL` is
 * thrown at the point of registration, so the line crashes the process.
 *
 * The whole finding is about that crash — so every context where the crash does
 * not happen is a silence, and the hunt found four of them.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noUncatchableSignalHandler } from "../../src/diagnostics/reliability/no-uncatchable-signal-handler.ts";

const findings = (source: string, filePath = "/repo/src/a.ts") =>
  lintSource({
    filePath,
    sourceText: source,
    diagnostics: [noUncatchableSignalHandler],
    capabilities: new Set(["node", "esm", "typescript"]),
  }).findings.filter((f) => f.diagnostic === "no-uncatchable-signal-handler");

const fires = (source: string, filePath?: string) => {
  const found = findings(source, filePath);
  assert.ok(found.length > 0, `expected a FIRE on:\n${source}`);
  return found;
};

const silent = (source: string, filePath?: string): void => {
  const found = findings(source, filePath);
  assert.equal(
    found.length,
    0,
    `expected SILENCE, got ${found.length}:\n${found.map((f) => `  - ${f.message}`).join("\n")}\n--- source ---\n${source}`,
  );
};

describe("no-uncatchable-signal-handler — fires", () => {
  test("`SIGKILL`, and the message says it crashes rather than never fires", () => {
    const [f] = fires(`process.on("SIGKILL", () => shutdown());`);
    assert.match(f!.message, /cannot be caught/);
    assert.match(f!.message, /EINVAL/);
    assert.match(f!.message, /SIGTERM/);
  });

  test("`SIGSTOP` is the other one the kernel keeps", () => {
    const [f] = fires(`process.once("SIGSTOP", fn);`);
    assert.match(f!.message, /SIGCONT/);
  });

  test("every registration method installs the same listener", () => {
    fires(`process.addListener("SIGKILL", fn);`);
    fires(`process.prependListener("SIGKILL", fn);`);
    fires(`process.prependOnceListener("SIGKILL", fn);`);
  });
});

describe("no-uncatchable-signal-handler — silent", () => {
  test("the signals a process really does receive", () => {
    silent(`process.on("SIGTERM", () => shutdown());`);
    silent(`process.on("SIGINT", fn);`);
    silent(`process.on("SIGHUP", fn);`);
    silent(`process.on("SIGUSR2", fn);`);
  });

  test("SENDING the signal is correct and common", () => {
    // An orchestrator escalates to SIGKILL after the grace period; that is the
    // right thing to do, and it is a different method entirely.
    silent(`process.kill(pid, "SIGKILL");`);
    silent(`child.kill("SIGKILL");`);
    silent(`exec("kill -SIGKILL 1");`);
  });

  test("a signal name that is not a literal", () => {
    silent(`process.on(sig, fn);`);
    silent(`for (const s of SIGNALS) process.on(s, fn);`);
  });

  test("a `process` that is not the global one", () => {
    silent(`function f(process) { process.on("SIGKILL", fn); }`);
    silent(`const process = new EventEmitter();\nprocess.on("SIGKILL", fn);`);
  });

  test("some other emitter that happens to use the name", () => {
    silent(`bus.on("SIGKILL", fn);`);
    silent(`this.on("SIGKILL", fn);`);
  });
});

describe("no-uncatchable-signal-handler — hardened by the adversarial hunt", () => {
  test("inside a WORKER there is no throw at all, so there is no claim", () => {
    // Verified against the runtime: worker threads never install the
    // `newListener` hook that reaches `uv_signal_start`, so registration is a
    // plain `EventEmitter.on` and the listener is merely dead. The finding is
    // entirely about the crash, so where there is no crash there is nothing.
    silent(
      `import { isMainThread, parentPort } from "node:worker_threads";\nprocess.on("SIGKILL", () => parentPort?.postMessage("dying"));`,
    );
    silent(`const { parentPort } = require("node:worker_threads");\nprocess.on("SIGKILL", () => {});`);
  });

  test("a `try`/`catch` catches the throw and the process survives", () => {
    // Cross-platform code really does wrap signal registration this way,
    // because Windows rejects several signums with EINVAL.
    silent(`try { process.on("SIGKILL", () => audit.write("hard-kill")); } catch { log.debug("unsupported"); }`);
  });

  test("a `try` with only a `finally` does NOT catch it", () => {
    fires(`try { process.on("SIGKILL", fn); } finally { done(); }`);
  });

  test("replacing the global shadows it without a lexical binding", () => {
    silent(
      `import { EventEmitter } from "node:events";\nconst fake = Object.assign(new EventEmitter(), { env: {} });\nglobalThis.process = fake;\nprocess.on("SIGKILL", () => fake.emit("done"));`,
    );
    silent(`global.process = stub;\nprocess.on("SIGKILL", fn);`);
  });

  test("`import process = require(…)` binds the name invisibly to the resolver", () => {
    silent(`import process = require("../test-utils/fake-process");\nprocess.on("SIGKILL", () => {});`);
  });

  test("a TEST FILE pinning Node's documented throw is not a crash", () => {
    silent(
      `import assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("SIGKILL cannot be trapped", () => {\n  assert.throws(() => process.on("SIGKILL", () => {}), /EINVAL/);\n});`,
      "/repo/tests/signals.test.ts",
    );
  });
});

describe("no-uncatchable-signal-handler — determinism", () => {
  test("identical source yields identical findings", () => {
    const source = `process.on("SIGKILL", a);\nprocess.on("SIGSTOP", b);`;
    assert.equal(JSON.stringify(findings(source)), JSON.stringify(findings(source)));
    assert.equal(findings(source).length, 2);
  });
});
