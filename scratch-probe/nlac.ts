import { lintSource } from "../src/core/scan.ts";
import { noLostAsyncContext } from "../src/diagnostics/reliability/no-lost-async-context.ts";

const caps = new Set(["node", "esm", "typescript", "express"]);
const n = (src: string): number =>
  lintSource({ filePath: "a.ts", sourceText: src, diagnostics: [noLostAsyncContext], capabilities: caps }).findings.length;

const cases: Record<string, string> = {
  // ---- Baseline positives (should FIRE) ----
  "B1_pathA_positive": `
import { AsyncLocalStorage } from "async_hooks";
const als = new AsyncLocalStorage();
emitter.on("data", () => { const ctx = als.getStore(); use(ctx); });
`,
  "B2_pathB_positive": `
import { AsyncLocalStorage } from "async_hooks";
emitter.on("data", () => { const ctx = als.getStore(); use(ctx); });
`,

  // ---- Case 1: Path B over-match, context is NOT the ALS ----
  "C1_pathB_context_not_als": `
import { AsyncLocalStorage } from "async_hooks";
const als = new AsyncLocalStorage();
const context = makeMyOwnThing();
emitter.on("x", () => { const c = context.getStore(); use(c); });
`,
  "C1b_pathB_storage_not_als": `
import { AsyncLocalStorage } from "async_hooks";
const storage = new Map();
emitter.on("x", () => { const c = storage.getStore(); use(c); });
`,

  // ---- Case 2: per-request emitter created AND emitted inside run scope ----
  "C2_emit_within_run": `
import { AsyncLocalStorage } from "async_hooks";
import { EventEmitter } from "events";
const als = new AsyncLocalStorage();
als.run(store, () => {
  const ee = new EventEmitter();
  ee.on("x", () => { const c = als.getStore(); use(c); });
  ee.emit("x");
});
`,

  // ---- Case 3: stream.on("data") consumed within run scope ----
  "C3_stream_within_run": `
import { AsyncLocalStorage } from "async_hooks";
const als = new AsyncLocalStorage();
als.run(store, () => {
  stream.on("data", () => { const c = als.getStore(); use(c); });
});
`,

  // ---- Case 4: correctly bound listeners (should be SILENT) ----
  "C4a_als_bind": `
import { AsyncLocalStorage } from "async_hooks";
const als = new AsyncLocalStorage();
emitter.on("x", als.bind(() => { const c = als.getStore(); use(c); }));
`,
  "C4b_asyncresource": `
import { AsyncLocalStorage } from "async_hooks";
import { AsyncResource } from "async_hooks";
const als = new AsyncLocalStorage();
const ar = new AsyncResource("x");
emitter.on("x", (...args) => ar.runInAsyncScope(() => { const c = als.getStore(); use(c); }, null, ...args));
`,

  // ---- Case 5: named function reference handler (should be SILENT, recall gap) ----
  "C5_named_handler": `
import { AsyncLocalStorage } from "async_hooks";
const als = new AsyncLocalStorage();
function handler() { const c = als.getStore(); use(c); }
socket.on("message", handler);
`,
};

for (const [name, src] of Object.entries(cases)) {
  console.log(name.padEnd(30), "=>", n(src));
}
