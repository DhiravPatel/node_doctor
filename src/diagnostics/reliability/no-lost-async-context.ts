import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import {
  getMethodName,
  getCalleeName,
  getReceiverName,
  getStaticStringValue,
  findEnclosingFunction,
  isFunctionLike,
  unwrapChain,
} from "../../core/ast.ts";
import { walk } from "../../core/walk.ts";

/**
 * OPT-IN (defaultEnabled: false). §152 — async-context propagation integrity.
 *
 * THE BUG. `AsyncLocalStorage` is how a Node service carries request-scoped data
 * — a request id, the tenant, an OpenTelemetry span — through a call tree without
 * threading it as an argument. A listener registered on a long-lived
 * `EventEmitter` breaks that thread. The callback does NOT run in the async
 * context of whoever *registered* it; it runs in the context of whoever *emits*
 * the event. So:
 *
 *   emitter.on("data", () => {
 *     const ctx = als.getStore();   // ← undefined (or, worse, ANOTHER request's ctx)
 *     logger.info({ requestId: ctx?.requestId }, "handled");
 *   });
 *
 * silently loses the request/tenant/trace context. The failure is invisible in a
 * single-request test (there is only one context, so "wrong context" looks like
 * "the context") and only manifests under concurrency as blank request ids or,
 * far nastier, one tenant's logs stamped with another tenant's id. `als.getStore`
 * returning `undefined` inside a listener is exactly the shape that bug takes.
 *
 * WHEN IT FIRES. A `.getStore()` call whose receiver resolves to an
 * `AsyncLocalStorage` instance — either (a) the receiver is an identifier whose
 * binding initializer is `new AsyncLocalStorage(...)`, or (b) the receiver name
 * looks like an ALS handle (`als` / `asyncLocalStorage` / `storage` / `context`)
 * AND the file imports `AsyncLocalStorage` — appearing lexically inside a
 * callback that is the listener argument of an EventEmitter registration
 * (`.on` / `.once` / `.addListener` / `.prependListener` / `.prependOnceListener`).
 * The "listener" is confirmed structurally: the *nearest enclosing function* of
 * the `getStore()` call must be the callback passed to the registration call, so
 * the store read is unambiguously executing on the emit-time stack.
 *
 * DELIBERATE SILENCE (precision-first — this is medium-confidence and opt-in).
 *   - `getStore()` that is NOT inside an emitter callback. Ordinary propagation
 *     through `await`, native promises, `als.run(store, fn)`, `setTimeout`,
 *     `setInterval`, `process.nextTick`, `queueMicrotask` WORKS in modern Node
 *     (≥14) — the AsyncResource machinery restores the context. Flagging those
 *     would be false alarms, so ONLY EventEmitter registration methods count. A
 *     `getStore()` nested inside a `setTimeout` *within* a listener resolves its
 *     nearest enclosing function to the timer callback, not the listener, and is
 *     correctly left silent.
 *   - A receiver we cannot resolve to an `AsyncLocalStorage` (`foo.getStore()`
 *     with no ALS binding and no ALS-shaped name) — no guessing.
 *   - The store captured BEFORE `.on` (`const ctx = als.getStore(); emitter.on(
 *     evt, () => use(ctx))`) — the read is outside the callback, so nothing fires.
 *
 * PRECISION. Two independent gates must both hold — a resolved-ALS receiver AND a
 * getStore lexically inside an emitter listener — and the enclosing-function
 * identity is checked by node reference (not by "is there an .on somewhere
 * nearby"), so an unrelated `.on` in the same function cannot pull in a
 * top-level `getStore`. The name-heuristic branch is additionally gated on the
 * file actually importing `AsyncLocalStorage`, so a stray `getStore()` in a file
 * that never touches async_hooks stays silent.
 *
 * KNOWN LIMITATION (why this is `medium` confidence, opt-in). The rule cannot prove
 * WHEN the emitter fires. The dangerous case — a long-lived emitter emitted later,
 * outside the run scope — is the overwhelmingly common one and the reason the bug
 * exists. The rare exception is an emitter created AND emitted synchronously inside
 * the same run scope (`als.run(s, () => { const ee = new EventEmitter(); ee.on(e,
 * () => als.getStore()); ee.emit(e); })`), where context IS preserved; the rule
 * flags it anyway. That is an unusual shape, and opt-in + medium confidence keep
 * the trade acceptable.
 *
 * ❌ emitter.on("data", () => { const ctx = als.getStore(); use(ctx); });
 * ✅ const ctx = als.getStore(); emitter.on("data", () => use(ctx));  // captured first
 * ✅ emitter.on("data", als.bind(() => use(als.getStore())));         // context bound
 */

/** EventEmitter registration methods whose listener runs on the emit-time stack. */
const EMITTER_METHODS = new Set([
  "on",
  "once",
  "addListener",
  "prependListener",
  "prependOnceListener",
]);

/**
 * Lowercased substrings that mark an identifier as an AsyncLocalStorage handle —
 * kept UNAMBIGUOUS (`als`, `asynclocalstorage`) rather than the generic `context`/
 * `storage`, which name too many non-ALS objects (a koa `context`, a storage API)
 * that could also expose a `.getStore()`. Only consulted when the file actually
 * imports `AsyncLocalStorage`, so the gate is a name *plus* an import — and even
 * then, only an unmistakably-ALS name. Path A (a binding to `new AsyncLocalStorage`)
 * covers everything else without any name guess.
 */
const ALS_NAME_HINTS = ["als", "asynclocalstorage"];

/** Module specifiers that expose `AsyncLocalStorage`. */
const ASYNC_HOOKS_SPECIFIERS = new Set(["async_hooks", "node:async_hooks"]);

export const noLostAsyncContext = defineDiagnostic({
  id: "no-lost-async-context",
  title: "AsyncLocalStorage context lost inside an EventEmitter listener",
  severity: "warn",
  category: "Reliability",
  tags: ["reliability", "observability"],
  defaultEnabled: false,
  confidence: "medium",
  recommendation:
    "Capture the store into a local BEFORE registering the listener (`const ctx = als.getStore(); emitter.on(evt, () => use(ctx))`), or bind the callback to the current context with `als.bind(fn)` / `new AsyncResource(name).runInAsyncScope(fn)` so it runs in the registration-time context instead of the emit-time context.",
  create: (ctx) => {
    /** Memoized: does this file import/require `AsyncLocalStorage`? */
    let alsImportedCache: boolean | null = null;
    const detectAlsImport = (): boolean => {
      let found = false;
      walk(ctx.program, {
        enter: (n) => {
          if (found) return;
          if (n.type === "ImportDeclaration") {
            const src = getStaticStringValue(n.source as AstNode);
            if (src && ASYNC_HOOKS_SPECIFIERS.has(src)) {
              found = true;
              return;
            }
            for (const spec of (n.specifiers as AstNode[]) ?? []) {
              if (
                spec.local?.name === "AsyncLocalStorage" ||
                spec.imported?.name === "AsyncLocalStorage"
              ) {
                found = true;
                return;
              }
            }
            return;
          }
          // `const { AsyncLocalStorage } = require("async_hooks")` and friends.
          if (n.type === "CallExpression" && getCalleeName(n) === "require") {
            const src = getStaticStringValue((n.arguments as AstNode[])?.[0]);
            if (src && ASYNC_HOOKS_SPECIFIERS.has(src)) found = true;
          }
        },
      });
      return found;
    };
    const alsImported = (): boolean => {
      if (alsImportedCache === null) alsImportedCache = detectAlsImport();
      return alsImportedCache;
    };

    /**
     * Does the receiver of this `.getStore()` call resolve to an
     * `AsyncLocalStorage` instance? Path A: an identifier bound to
     * `new AsyncLocalStorage(...)`. Path B: an ALS-shaped receiver name in a file
     * that imports `AsyncLocalStorage`.
     */
    const receiverIsAls = (call: AstNode): boolean => {
      const callee = unwrapChain(call.callee as AstNode);
      if (!callee || callee.type !== "MemberExpression") return false;
      const obj = unwrapChain(callee.object as AstNode);

      // Path A — identifier binding initialized with `new AsyncLocalStorage(...)`.
      if (obj?.type === "Identifier") {
        const init = ctx.scope.getBinding(obj.name as string, obj)?.initNode;
        if (init && init.type === "NewExpression" && getMethodName(init) === "AsyncLocalStorage") {
          return true;
        }
      }

      // Path B — ALS-shaped receiver name, but only if the file imports ALS.
      const receiverName = getReceiverName(call);
      if (receiverName && alsImported()) {
        const lower = receiverName.toLowerCase();
        if (ALS_NAME_HINTS.some((hint) => lower.includes(hint))) return true;
      }
      return false;
    };

    /**
     * Is `fn` the listener callback of an EventEmitter registration call — i.e.
     * the last function-typed argument of an `emitter.on(...)`-style call? The
     * function must be a *direct* argument, so the emit-time stack claim holds.
     */
    const isEmitterListener = (fn: AstNode): boolean => {
      const call = fn.parent;
      if (!call || call.type !== "CallExpression") return false;
      const method = getMethodName(call);
      if (!method || !EMITTER_METHODS.has(method)) return false;
      const args = (call.arguments as AstNode[]) ?? [];
      let lastFnArg: AstNode | null = null;
      for (const arg of args) if (isFunctionLike(arg)) lastFnArg = arg;
      return lastFnArg === fn;
    };

    return {
      CallExpression: (node) => {
        if (getMethodName(node) !== "getStore") return;
        if (!receiverIsAls(node)) return;

        // The nearest enclosing function must BE the listener callback, so the
        // read runs on the emit-time stack. A getStore in a nested (non-listener)
        // callback, or at function top level, resolves elsewhere and stays silent.
        const enclosing = findEnclosingFunction(node);
        if (!enclosing || !isEmitterListener(enclosing)) return;

        ctx.report(
          node,
          "AsyncLocalStorage.getStore() inside an EventEmitter listener returns the emit-time context, not the context where the listener was registered — request/tenant/trace context is silently lost here. Capture the store BEFORE registering the listener (`const ctx = als.getStore(); emitter.on(evt, () => use(ctx))`), or bind the listener with `als.bind`/`AsyncResource`.",
        );
      },
    };
  },
});
