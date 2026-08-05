/**
 * §166 — `no-floating-promise-in-try`.
 *
 * The claim is narrow and absolute: *this* catch cannot see *this* call's
 * failure. Every silence below is a case where either the promise is consumed,
 * or the callee is not provably async, or the try was never covering that call.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noFloatingPromiseInTry } from "../../src/diagnostics/bugs/no-floating-promise-in-try.ts";

const CAPS = new Set(["node", "esm", "typescript"]);

const findings = (source: string) =>
  lintSource({
    filePath: "/repo/a.ts",
    sourceText: source,
    diagnostics: [noFloatingPromiseInTry],
    capabilities: CAPS,
  }).findings.filter((f) => f.diagnostic === "no-floating-promise-in-try");

const fires = (source: string): void => {
  assert.ok(findings(source).length > 0, `expected no-floating-promise-in-try to FIRE on:\n${source}`);
};

const silent = (source: string): void => {
  const found = findings(source);
  assert.equal(
    found.length,
    0,
    `expected no-floating-promise-in-try to STAY SILENT, got ${found.length}:\n` +
      found.map((f) => `  - ${f.message}`).join("\n") +
      `\n--- source ---\n${source}`,
  );
};

const SEND = `async function send(x) { await http.post(x); }\n`;

describe("no-floating-promise-in-try — silent", () => {
  test("the promise is consumed", () => {
    silent(`${SEND} async function f(o) { try { await send(o); } catch (e) { log(e); } }`);
    silent(`${SEND} function f(o) { try { return send(o); } catch (e) { log(e); } }`);
    silent(`${SEND} function f(o) { try { const p = send(o); } catch (e) { log(e); } }`);
    silent(`${SEND} function f(o) { try { send(o).catch(log); } catch (e) { log(e); } }`);
    silent(`${SEND} function f(o) { try { send(o).then(ok, log); } catch (e) { log(e); } }`);
  });

  test("`void` is the author saying they meant it", () => {
    silent(`${SEND} function f(o) { try { void send(o); } catch (e) { log(e); } }`);
  });

  test("there is no catch to be wrong about", () => {
    silent(`${SEND} function f(o) { try { send(o); } finally { done(); } }`);
    silent(`${SEND} function f(o) { send(o); }`);
  });

  test("the call is not inside the try BLOCK", () => {
    silent(`${SEND} function f(o) { try { risky(); } catch (e) { send(o); } }`);
    silent(`${SEND} function f(o) { try { risky(); } catch (e) { log(e); } finally { send(o); } }`);
  });

  test("a function boundary means the try never covered the call", () => {
    silent(`${SEND} function f(o) { try { queue.on("x", () => { send(o); }); } catch (e) { log(e); } }`);
    silent(`${SEND} function f(o) { try { setTimeout(function () { send(o); }, 10); } catch (e) { log(e); } }`);
  });

  test("the callee is not provably async", () => {
    // A synchronous function: the catch works exactly as written.
    silent(`function send(x) { http.post(x); }\nfunction f(o) { try { send(o); } catch (e) { log(e); } }`);
    // A parameter — its value is the caller's business.
    silent(`function f(o, send) { try { send(o); } catch (e) { log(e); } }`);
    // An import — the declaration is in another file.
    silent(`import { send } from "./mail.ts";\nfunction f(o) { try { send(o); } catch (e) { log(e); } }`);
    // A method call — the receiver's type is unknown.
    silent(`${SEND} function f(o) { try { mailer.send(o); } catch (e) { log(e); } }`);
    // Unresolvable/global.
    silent(`function f(o) { try { fetchAll(o); } catch (e) { log(e); } }`);
  });

  test("a `let` holding an async function today may hold anything tomorrow", () => {
    silent(`let send = async (x) => x;\nfunction f(o) { try { send(o); } catch (e) { log(e); } }`);
    silent(`var send = async function (x) { return x; };\nfunction f(o) { try { send(o); } catch (e) { log(e); } }`);
  });

  test("a non-async const arrow", () => {
    silent(`const send = (x) => x;\nfunction f(o) { try { send(o); } catch (e) { log(e); } }`);
  });
});

describe("no-floating-promise-in-try — fires", () => {
  test("an async function declaration whose promise is dropped inside a guarded try", () => {
    fires(`${SEND} function f(o) { try { send(o); } catch (e) { log(e); } }`);
  });

  test("a const async arrow", () => {
    fires(`const send = async (x) => { await http.post(x); };\nfunction f(o) { try { send(o); } catch (e) { log(e); } }`);
  });

  test("a const async function expression", () => {
    fires(
      `const send = async function (x) { await http.post(x); };\nfunction f(o) { try { send(o); } catch (e) { log(e); } }`,
    );
  });

  test("hoisting means the declaration may come after the call", () => {
    fires(`function f(o) { try { send(o); } catch (e) { log(e); } }\nasync function send(x) { await http.post(x); }`);
  });

  test("nested blocks inside the try still count", () => {
    fires(`${SEND} function f(o) { try { if (o) { send(o); } } catch (e) { log(e); } }`);
    fires(`${SEND} function f(o) { try { for (const x of o) { send(x); } } catch (e) { log(e); } }`);
  });

  test("an inner try's catch is equally blind", () => {
    fires(`${SEND} function f(o) { try { try { send(o); } catch (e) { a(e); } } catch (e) { b(e); } }`);
  });

  test("a finally alongside a catch does not rescue it", () => {
    fires(`${SEND} function f(o) { try { send(o); } catch (e) { log(e); } finally { done(); } }`);
  });

  test("the message names the call and says what actually happens", () => {
    const [f] = findings(`${SEND} function f(o) { try { send(o); } catch (e) { log(e); } }`);
    assert.ok(f, "expected a finding");
    assert.match(f.message, /`send`/);
    assert.match(f.message, /unhandledRejection/);
  });
});

describe("no-floating-promise-in-try — determinism", () => {
  test("identical source yields identical findings", () => {
    const source = `${SEND} function f(o) { try { send(o); send(o); } catch (e) { log(e); } }`;
    assert.equal(JSON.stringify(findings(source)), JSON.stringify(findings(source)));
    assert.equal(findings(source).length, 2, "each discarded call is its own finding");
  });
});
