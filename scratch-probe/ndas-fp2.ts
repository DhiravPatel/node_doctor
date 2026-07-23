import { lintSource } from "../src/core/scan.ts";
import { noDroppedAbortSignal } from "../src/diagnostics/reliability/no-dropped-abort-signal.ts";

const caps = new Set(["node", "esm", "typescript", "express"]);
const run = (label: string, src: string) => {
  const r = lintSource({ filePath: "a.ts", sourceText: src, diagnostics: [noDroppedAbortSignal], capabilities: caps });
  console.log(label, r.findings.length, r.findings.map((f) => f.message.slice(0, 70)));
};

// Realistic process-signal graceful-shutdown handler that flushes metrics via fetch.
run("PS1-shutdown", "async function onShutdown(signal){ console.log(`got ${signal}`); await fetch('https://metrics/flush', { method: 'POST' }); process.exit(0); }");

// process.on('SIGTERM', handler) style — handler's `signal` is the signal name string.
run("PS2-sigterm", "async function handler(signal){ await axios.get('https://health/deregister'); }");

// Reactive UI 'signal' (Preact/Solid/Angular) making a fetch on change.
run("PS3-reactive", "async function effect(signal){ const v = signal.value; return fetch(`/api?x=${v}`); }");

// Confirm the exact message on the ambiguous case.
run("PS4-msg", "async function f(url, signal){ log(signal); return fetch(url); }");

// Control: abortSignal name (unambiguous) dropped -> TP, not FP.
run("PS5-abortSignal", "async function f(url, abortSignal){ return fetch(url); }");
