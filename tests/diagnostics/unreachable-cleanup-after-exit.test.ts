/**
 * §166 — `no-unreachable-cleanup-after-exit`.
 *
 * The exemptions are the interesting part: a hoisted `function`, a `var`, an
 * `export`, an ambient `declare` and every erased TypeScript form are NOT dead
 * after a terminator, and flagging them is the classic false positive. They are
 * inherited from `no-unreachable-code` rather than re-derived, and pinned here
 * so a change to that shared helper cannot silently break this rule.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noUnreachableCleanupAfterExit } from "../../src/diagnostics/bugs/no-unreachable-cleanup-after-exit.ts";

const CAPS = new Set(["node", "esm", "typescript"]);

const findings = (source: string) =>
  lintSource({
    filePath: "/repo/a.ts",
    sourceText: source,
    diagnostics: [noUnreachableCleanupAfterExit],
    capabilities: CAPS,
  }).findings.filter((f) => f.diagnostic === "no-unreachable-cleanup-after-exit");

const fires = (source: string): void => {
  assert.ok(findings(source).length > 0, `expected the rule to FIRE on:\n${source}`);
};

const silent = (source: string): void => {
  const found = findings(source);
  assert.equal(
    found.length,
    0,
    `expected the rule to STAY SILENT, got ${found.length}:\n` +
      found.map((f) => `  - ${f.message}`).join("\n") +
      `\n--- source ---\n${source}`,
  );
};

describe("no-unreachable-cleanup-after-exit — silent", () => {
  test("the exit is last, which is the correct shape", () => {
    silent(`function shutdown() { server.close(); db.end(); process.exit(0); }`);
  });

  test("a conditional exit is not a terminator", () => {
    silent(`function f() { if (bad) { process.exit(1); } server.close(); }`);
    silent(`function f() { bad && process.exit(1); server.close(); }`);
    silent(`function f() { const code = compute(); process.exit(code); }`);
  });

  test("an exit inside a nested function does not end the outer list", () => {
    silent(`function f() { onFatal(() => process.exit(1)); server.close(); }`);
  });

  test("the exit is not a call at all", () => {
    silent(`function f() { const exit = process.exit; server.close(); }`);
  });

  test("something that merely looks like process.exit", () => {
    silent(`function f() { worker.exit(0); server.close(); }`);
    silent(`function f() { process.exitCode = 1; server.close(); }`);
  });

  test("hoisted and erased forms are not dead", () => {
    silent(`function f() { process.exit(0); function later() {} }`);
    silent(`function f() { process.exit(0); var x = 1; }`);
    silent(`process.exit(0);\nimport type { A } from "./a.ts";`);
    silent(`function f() { process.exit(0); }\nprocess.exit(0);\nexport type B = number;`);
    silent(`function f() { process.exit(0); interface Shape { a: number } }`);
    silent(`function f() { process.exit(0); type T = string; }`);
    silent(`function f() { process.exit(0); declare const injected: number; }`);
    silent(`function f() { process.exit(0); ; }`);
  });

  test("a single-statement list has nothing after it", () => {
    silent(`function f() { process.exit(0); }`);
    silent(`process.exit(0);`);
  });
});

describe("no-unreachable-cleanup-after-exit — fires", () => {
  test("shutdown work written under the exit", () => {
    fires(`
      process.on("SIGTERM", () => {
        process.exit(0);
        server.close();
      });
    `);
  });

  test("process.abort() is equally final", () => {
    fires(`function f() { process.abort(); logger.flush(); }`);
  });

  test("at module scope", () => {
    fires(`process.exit(1);\nconsole.log("cleanup");`);
  });

  test("inside a switch case", () => {
    fires(`function f(x) { switch (x) { case 1: process.exit(0); cleanup(); } }`);
  });

  test("a `let`/`const` after the exit genuinely is dead", () => {
    fires(`function f() { process.exit(0); const x = 1; use(x); }`);
  });

  test("only the first live statement is reported", () => {
    const found = findings(`function f() { process.exit(0); a(); b(); c(); }`);
    assert.equal(found.length, 1, "one actionable finding, not a running commentary");
  });

  test("the message says why it matters, not just that it is dead", () => {
    const [f] = findings(`function f() { process.exit(0); await db.end(); }`);
    assert.ok(f);
    assert.match(f.message, /without waiting for pending I\/O/);
  });
});

describe("no-unreachable-cleanup-after-exit — determinism", () => {
  test("identical source yields identical findings", () => {
    const source = `function a() { process.exit(0); x(); }\nfunction b() { process.exit(1); y(); }`;
    assert.equal(JSON.stringify(findings(source)), JSON.stringify(findings(source)));
    assert.equal(findings(source).length, 2);
  });
});
