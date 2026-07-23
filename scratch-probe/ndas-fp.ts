import { lintSource } from "../src/core/scan.ts";
import { noDroppedAbortSignal } from "../src/diagnostics/reliability/no-dropped-abort-signal.ts";

const caps = new Set(["node", "esm", "typescript", "express"]);
const n = (src: string) =>
  lintSource({ filePath: "a.ts", sourceText: src, diagnostics: [noDroppedAbortSignal], capabilities: caps })
    .findings.length;

// B1: forwards it -> must be SILENT
console.log("B1-forward", n("async function f(url, signal){ fetch(url, { signal }); }"));

// B2: signal passed via helper (opaque opts) -> should be SILENT
console.log("B2-helper", n("async function f(url, signal){ fetch(url, buildOpts(signal)); }"));

// B3: spread + signal -> SILENT
console.log("B3-spread", n("async function f(url, signal){ fetch(url, { ...base, signal }); }"));

// B4: non-AbortSignal `signal` param (unix signal / bus signal) -> FP RISK
console.log("B4-nonabort", n("async function f(url, signal){ log(signal); return fetch(url); }"));

// B5: fetch in nested callback, signal in outer scope -> should be SILENT (nested)
console.log("B5-nested", n("function outer(signal){ items.forEach(u => fetch(u)); }"));

// B6: got with opts lacking signal -> fires? (TP question)
console.log("B6-got", n("async function f(signal){ return got(url, { retry: 0 }); }"));

// B7a: axios.post(url, data, { signal }) config in arg2 -> SILENT (forwarded)
console.log("B7a-axios-cfg2", n("async function f(url, data, signal){ return axios.post(url, data, { signal }); }"));

// B7b: axios.post(url, { signal }) -- signal in DATA slot (arg1) -> ???
console.log("B7b-axios-datasignal", n("async function f(url, signal){ return axios.post(url, { signal }); }"));

// --- extra adversarial cases ---

// B8: non-abort signal param, but forwards nothing, uses axios.post with data only
console.log("B8-nonabort-axios", n("async function f(url, signal){ emit(signal); return axios.post(url, payload); }"));

// B9: signal destructured but genuinely unrelated name collision? not applicable.
// B9: axios.get with config lacking signal -> fires (TP)
console.log("B9-axios-get", n("async function f(url, signal){ return axios.get(url); }"));

// B10: axios.post with data and NO config -> config slot idx=2 missing -> fires
console.log("B10-axios-post-nodata", n("async function f(url, data, signal){ return axios.post(url, data); }"));

// B11: fetch forwarding via renamed destructure { signal: s } then fetch(url,{signal:s})
console.log("B11-rename", n("async function f(url, signal){ fetch(url, { signal: signal }); }"));

// B12: abortSignal param name -> fires when dropped
console.log("B12-abortSignal", n("async function f(url, abortSignal){ return fetch(url); }"));

// B13: signal param used to build controller, real fetch forwards controller.signal
console.log("B13-ctrl", n("async function f(url, signal){ const c = new AbortController(); return fetch(url, { signal: c.signal }); }"));

// B14: got config object lacks signal but is bare got(options)
console.log("B14-got-optsobj", n("async function f(signal){ return got({ url, retry: 0 }); }"));

// B15: nested async fn takes its own signal -> outer signal not dropped by inner
console.log("B15-nested-own", n("function outer(signal){ async function inner(s){ return fetch(u, { signal: s }); } }"));

// B16: signal param, but no outbound call at all -> SILENT
console.log("B16-nocall", n("function f(signal){ return doThing(signal); }"));

// B17: real non-abort: worker 'signal' event handler style
console.log("B17-event", n("function onSignal(signal){ metrics.count(signal); return fetch('/health'); }"));

// B18: fetch with opaque options var -> SILENT
console.log("B18-opaquevar", n("async function f(url, signal, opts){ return fetch(url, opts); }"));
