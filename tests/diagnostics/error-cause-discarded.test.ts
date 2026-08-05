/**
 * §183 — `no-error-cause-discarded`.
 *
 * Opt-in and driven directly rather than through the registry. The silence cases
 * are the specification: this rule claims "you threw away the evidence", and the
 * author only has to have kept it *somewhere* for that claim to be false.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noErrorCauseDiscarded } from "../../src/diagnostics/reliability/no-error-cause-discarded.ts";

const CAPS = new Set(["node", "esm", "typescript"]);

const findings = (source: string) =>
  lintSource({ filePath: "/repo/a.ts", sourceText: source, diagnostics: [noErrorCauseDiscarded], capabilities: CAPS })
    .findings.filter((f) => f.diagnostic === "no-error-cause-discarded");

const fires = (source: string): void => {
  assert.ok(findings(source).length > 0, `expected no-error-cause-discarded to FIRE on:\n${source}`);
};

const silent = (source: string): void => {
  const found = findings(source);
  assert.equal(
    found.length,
    0,
    `expected no-error-cause-discarded to STAY SILENT, got ${found.length}:\n` +
      found.map((f) => `  - ${f.message}`).join("\n") +
      `\n--- source ---\n${source}`,
  );
};

describe("no-error-cause-discarded — fires", () => {
  test("a caught error replaced by a bare new Error", () => {
    fires(`try { load(); } catch (err) { throw new Error("failed to load user"); }`);
  });

  test("a custom error subclass that drops it", () => {
    fires(`try { load(); } catch (e) { throw new AppError("nope"); }`);
  });

  test("inside an async function", () => {
    fires(`async function f() { try { await load(); } catch (err) { throw new Error("boom"); } }`);
  });

  test("a TypeError replacement", () => {
    fires(`try { parse(x); } catch (err) { throw new TypeError("bad input"); }`);
  });
});

describe("no-error-cause-discarded — silent whenever the thread was kept", () => {
  test("the cause is attached", () => {
    silent(`try { load(); } catch (err) { throw new Error("failed", { cause: err }); }`);
    silent(`try { load(); } catch (err) { throw new AppError("failed", { cause: err }); }`);
  });

  test("the error is logged before the re-throw", () => {
    silent(`try { load(); } catch (err) { logger.error({ err }); throw new Error("failed"); }`);
  });

  test("the message carries it", () => {
    silent("try { load(); } catch (err) { throw new Error(`failed: ${err.message}`); }");
    silent(`try { load(); } catch (err) { throw new Error("failed: " + err); }`);
  });

  test("the original is re-thrown", () => {
    silent(`try { load(); } catch (err) { throw err; }`);
  });

  test("it is passed to the constructor in any position", () => {
    silent(`try { load(); } catch (err) { throw new AppError("failed", 500, err); }`);
  });

  test("a bare `catch {}` never had a cause to discard", () => {
    silent(`try { load(); } catch { throw new Error("failed"); }`);
  });

  test("a throw inside a nested function has its own error context", () => {
    silent(
      `try { load(); } catch (err) { register(() => { throw new Error("later"); }); logger.warn(err); }`,
    );
  });

  test("a catch that does not throw at all", () => {
    silent(`try { load(); } catch (err) { return fallback(); }`);
  });

  test("a throw of a non-error value is a different rule's business", () => {
    silent(`try { load(); } catch (err) { throw "failed"; }`);
    silent(`try { load(); } catch (err) { throw { code: 500 }; }`);
  });
});
