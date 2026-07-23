/**
 * §137 (file-local slice) — no-dropped-abort-signal:
 *   a function that HAS an `AbortSignal` parameter but makes a cancellable
 *   outbound call (`fetch` / `axios` / `got`) WITHOUT forwarding the signal.
 *
 * This test imports the diagnostic module directly and lints with an explicit
 * one-diagnostic list, so it does not depend on the generated registry. The
 * MUST-be-silent cases are precision guards: the rule is opt-in and precision-
 * first, and a false positive is a release blocker. Every FIRE case has an
 * in-scope `signal` parameter that is demonstrably dropped; every SILENT case
 * either lacks the signal, forwards it, or is unprovable (spread / opaque
 * config / nested scope).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noDroppedAbortSignal } from "../../src/diagnostics/reliability/no-dropped-abort-signal.ts";
import type { Diagnostic } from "../../src/core/types.ts";

const CAPS = new Set(["node", "esm", "typescript", "express"]);

const findingsFor = (diagnostic: Diagnostic, source: string): number => {
  const { findings, parseFailed } = lintSource({
    filePath: "test.ts",
    sourceText: source,
    diagnostics: [diagnostic],
    capabilities: CAPS,
  });
  assert.ok(!parseFailed, `source failed to parse:\n${source}`);
  return findings.filter((f) => f.diagnostic === diagnostic.id).length;
};

const fires = (diagnostic: Diagnostic, source: string): void =>
  assert.ok(findingsFor(diagnostic, source) > 0, `expected ${diagnostic.id} to FIRE on:\n${source}`);

const silent = (diagnostic: Diagnostic, source: string): void =>
  assert.equal(findingsFor(diagnostic, source), 0, `expected ${diagnostic.id} to STAY SILENT on:\n${source}`);

describe("no-dropped-abort-signal", () => {
  const D = noDroppedAbortSignal;

  // FIRES -------------------------------------------------------------------
  test("fires: signal param, fetch with no options at all", () => {
    fires(D, `async function load(url, signal) { return fetch(url); }`);
  });
  test("fires: destructured { signal } options param, fetch with a non-signal options object", () => {
    fires(D, `async function f({ signal }) { return fetch(url, { headers: h }); }`);
  });
  test("fires: destructured { signal: s } options param", () => {
    fires(D, `async function f({ signal: s }, url) { return fetch(url, { method: "POST" }); }`);
  });
  test("fires: abortSignal param name", () => {
    fires(D, `async function f(url, abortSignal) { return fetch(url); }`);
  });
  test("fires: signal param via a default value, fetch dropping it", () => {
    fires(D, `async function f(url, signal = ctrl.signal) { return fetch(url, { keepalive: true }); }`);
  });
  test("fires: axios.get with only a url (no config slot)", () => {
    fires(D, `async function f(url, signal) { return axios.get(url); }`);
  });
  test("fires: axios.post with a body but no config object", () => {
    fires(D, `async function f(url, data, signal) { return axios.post(url, data); }`);
  });
  test("fires: bare axios(config) config object without signal", () => {
    fires(D, `async function f(url, signal) { return axios({ url, method: "GET" }); }`);
  });
  test("fires: got(url) with a signal in scope", () => {
    fires(D, `async function f(url, signal) { return got(url); }`);
  });
  test("fires: got.post(url, options) options object without signal", () => {
    fires(D, `async function f(url, signal) { return got.post(url, { json: body }); }`);
  });
  test("fires: fetch inside a for-loop within the signal-bearing function body", () => {
    fires(D, `async function f(urls, signal) { for (const u of urls) { await fetch(u); } }`);
  });
  test("fires: arrow function with signal param, concise body is the fetch call", () => {
    fires(D, `const load = (url, signal) => fetch(url);`);
  });

  // MUST BE SILENT ----------------------------------------------------------
  test("silent: no signal parameter in scope (the common case)", () => {
    silent(D, `async function f(url) { return fetch(url); }`);
  });
  test("silent: a UNIX-signal parameter (string-compared / switched), not an AbortSignal", () => {
    silent(D, `function onSignal(signal) { if (signal === "SIGTERM") drain(); return fetch(healthUrl); }`);
    silent(D, `function onSignal(signal) { switch (signal) { case "SIGINT": return fetch(u); } }`);
  });
  test("silent: a shutdown handler that interpolates the signal as a string (`${signal}`)", () => {
    silent(D, `async function onShutdown(signal) { console.log(\`got \${signal}\`); await fetch("https://m/flush", { method: "POST" }); }`);
  });
  test("silent: fetch already forwards { signal }", () => {
    silent(D, `async function f(url, signal) { return fetch(url, { signal }); }`);
  });
  test("silent: fetch forwards signal as an explicit property value", () => {
    silent(D, `async function f(url, signal) { return fetch(url, { method: "GET", signal: signal }); }`);
  });
  test("silent: options object spreads another object (signal may be inside)", () => {
    silent(D, `async function f(url, signal) { return fetch(url, { ...opts }); }`);
  });
  test("silent: options argument is an opaque variable we cannot read", () => {
    silent(D, `async function f(url, signal) { return fetch(url, opts); }`);
  });
  test("silent: fetch inside a nested callback that has no signal in its own scope", () => {
    silent(D, `async function f(urls, signal) { urls.map(function (u) { return fetch(u); }); }`);
  });
  test("silent: nested arrow callback with no signal param", () => {
    silent(D, `async function f(urls, signal) { urls.forEach((u) => { fetch(u); }); }`);
  });
  test("silent: axios.get already forwards { signal }", () => {
    silent(D, `async function f(url, signal) { return axios.get(url, { signal }); }`);
  });
  test("silent: axios.post forwards signal in the 3rd (config) argument", () => {
    silent(D, `async function f(url, data, signal) { return axios.post(url, data, { signal }); }`);
  });
  test("silent: got forwards signal in its options object", () => {
    silent(D, `async function f(url, signal) { return got(url, { signal }); }`);
  });
  test("silent: no outbound cancellable call (db query is not fetch-like)", () => {
    silent(D, `async function f(id, signal) { return db.users.findUnique({ where: { id } }); }`);
  });
  test("silent: signal in scope but the fetch is a spread-argument call (unprovable)", () => {
    silent(D, `async function f(url, signal) { return fetch(url, ...rest); }`);
  });
  test("silent: signal param but outbound call lives only in a returned nested function", () => {
    silent(D, `function make(url, signal) { return () => fetch(url); }`);
  });
  test("silent: unrelated param names do not count as a signal", () => {
    silent(D, `async function f(url, sig) { return fetch(url); }`);
  });
  test("silent: axios.create is not a request method", () => {
    silent(D, `async function f(signal) { return axios.create({ baseURL: b }); }`);
  });
});
