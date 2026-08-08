/**
 * §204 — `no-oversized-timer-delay`.
 *
 * Node stores a timer delay in a signed 32-bit int and clamps anything larger to
 * 1 ms. The claim is arithmetic, so it is made only where the arithmetic is: a
 * delay that folds from literals alone, on a proven global timer.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noOversizedTimerDelay } from "../../src/diagnostics/bugs/no-oversized-timer-delay.ts";

const findings = (source: string) =>
  lintSource({
    filePath: "/repo/src/a.ts",
    sourceText: source,
    diagnostics: [noOversizedTimerDelay],
    capabilities: new Set(["node", "esm", "typescript"]),
  }).findings.filter((f) => f.diagnostic === "no-oversized-timer-delay");

const fires = (source: string) => {
  const found = findings(source);
  assert.ok(found.length > 0, `expected a FIRE on:\n${source}`);
  return found;
};

const silent = (source: string): void => {
  const found = findings(source);
  assert.equal(found.length, 0, `expected SILENCE, got ${found.length}:\n${source}`);
};

describe("no-oversized-timer-delay — fires", () => {
  test("the classic thirty days, spelled as arithmetic", () => {
    const [f] = fires(`setTimeout(expireSession, 1000 * 60 * 60 * 24 * 30);`);
    assert.match(f!.message, /2,592,000,000 ms/);
    assert.match(f!.message, /30 days/);
    assert.match(f!.message, /1 ms/);
  });

  test("`setInterval` says what it becomes", () => {
    const [f] = fires(`setInterval(monthlyReport, 30 * 86_400_000);`);
    assert.match(f!.message, /hot loop/);
  });

  test("a plain literal, and numeric separators", () => {
    fires(`setTimeout(fn, 3000000000);`);
    fires(`setTimeout(fn, 3_000_000_000);`);
  });

  test("one millisecond over the boundary", () => {
    fires(`setTimeout(fn, 2147483648);`);
  });

  test("`node:timers`, imported either way", () => {
    fires(`import * as timers from "node:timers";\ntimers.setTimeout(fn, 9999999999);`);
    fires(`import { setTimeout } from "node:timers";\nsetTimeout(fn, 9999999999);`);
  });

  test("`globalThis.setTimeout` is the global one", () => {
    fires(`globalThis.setTimeout(fn, 9999999999);`);
  });
});

describe("no-oversized-timer-delay — silent", () => {
  test("exactly the maximum still fits", () => {
    silent(`setTimeout(fn, 2147483647);`);
  });

  test("a delay that fits", () => {
    silent(`setTimeout(fn, 1000 * 60 * 60 * 24 * 20);`);
    silent(`setInterval(fn, 5_000);`);
  });

  test("a delay that does not fold from literals", () => {
    // A name that says `THIRTY_DAYS` is not the same as arithmetic that IS.
    silent(`setTimeout(fn, THIRTY_DAYS);`);
    silent(`setTimeout(fn, cfg.ttl);`);
    silent(`setTimeout(fn, ms("30d"));`);
    silent(`setTimeout(fn, big ? 9999999999 : 1);`);
  });

  test("no delay, or a different API", () => {
    silent(`setTimeout(fn);`);
    silent(`setImmediate(fn);`);
    silent(`queueMicrotask(fn);`);
  });

  test("a `setTimeout` that is not the global one", () => {
    silent(`function setTimeout(f, d) {}\nsetTimeout(fn, 9999999999);`);
    silent(`scheduler.setTimeout(fn, 9999999999);`);
  });

  test("a negative delay is a different mistake", () => {
    silent(`setTimeout(fn, -1);`);
  });
});

describe("no-oversized-timer-delay — hardened by the adversarial hunt", () => {
  test("an imported timer name SHADOWED at the call site is somebody else's", () => {
    // A fake-timer harness, an injected scheduler, a callback parameter: all
    // take the name over, and their units are their own business.
    silent(`import * as timers from "node:timers";\nexport function run(timers) { timers.setTimeout(fn, 9999999999); }`);
    silent(`import { setTimeout } from "node:timers";\nexport function run(setTimeout) { setTimeout(fn, 9999999999); }`);
    silent(
      `import * as timers from "node:timers";\ntimers.setImmediate(fn);\nexport const withClock = (timers) => timers.setInterval(fn, 9999999999);`,
    );
  });

  test("the import still fires where nothing shadows it", () => {
    fires(`import * as timers from "node:timers";\nexport function run(other) { timers.setTimeout(fn, 9999999999); }`);
  });

  test("a shadowed `globalThis` is not the global object", () => {
    silent(`export function f(globalThis) { globalThis.setTimeout(fn, 9999999999); }`);
  });
});

describe("no-oversized-timer-delay — determinism", () => {
  test("identical source yields identical findings", () => {
    const source = `setTimeout(a, 9999999999);\nsetInterval(b, 9999999999);`;
    assert.equal(JSON.stringify(findings(source)), JSON.stringify(findings(source)));
    assert.equal(findings(source).length, 2);
  });
});
