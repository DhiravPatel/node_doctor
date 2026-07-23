import { lintSource } from "../src/core/scan.ts";
import { noLostAsyncContext } from "../src/diagnostics/reliability/no-lost-async-context.ts";

const caps = new Set(["node", "esm", "typescript", "express"]);
const n = (src: string): number =>
  lintSource({ filePath: "a.ts", sourceText: src, diagnostics: [noLostAsyncContext], capabilities: caps }).findings.length;

const cases: Record<string, string> = {
  // Substring collisions: names that CONTAIN a hint but are unrelated objects.
  "requestContext": `
import { AsyncLocalStorage } from "async_hooks";
const requestContext = buildKoaContext();
emitter.on("x", () => { const c = requestContext.getStore(); use(c); });
`,
  "sessionStorage": `
import { AsyncLocalStorage } from "async_hooks";
const sessionStorage = new SessionStore();
emitter.on("x", () => { const c = sessionStorage.getStore(); use(c); });
`,
  // member-receiver: this.storage.getStore()
  "this_storage": `
import { AsyncLocalStorage } from "async_hooks";
class S { register() { emitter.on("x", () => { const c = this.storage.getStore(); use(c); }); } }
`,
  // control: hint present but file does NOT import ALS -> should be silent
  "context_no_als_import": `
const context = makeMyOwnThing();
emitter.on("x", () => { const c = context.getStore(); use(c); });
`,
  // control: getStore on a name with NO hint, no ALS binding -> silent
  "cache_no_hint": `
import { AsyncLocalStorage } from "async_hooks";
const cache = new Cache();
emitter.on("x", () => { const c = cache.getStore(); use(c); });
`,
};

for (const [name, src] of Object.entries(cases)) {
  console.log(name.padEnd(24), "=>", n(src));
}
