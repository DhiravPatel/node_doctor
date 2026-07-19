import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, rootObjectName } from "../../core/ast.ts";
import { isOnRequestPath } from "../../core/request-path.ts";

/**
 * `.on(...)` / `.addListener(...)` on a long-lived emitter, called from inside a
 * request handler. The handler runs on every request, so the listener is
 * re-registered every time and never removed: the emitter's listener array grows
 * without bound, memory leaks, and Node eventually prints
 * `MaxListenersExceededWarning`. Listeners on long-lived emitters belong at
 * startup (registered once); per-request work should use `.once(...)` with
 * guaranteed cleanup.
 *
 * Per-request objects (`req`, `res`, `reply`, ...) are excluded: they are GC'd
 * when the request ends, so a listener on them is not a leak.
 *
 * ❌ app.get("/x", (req, res) => { bus.on("tick", () => res.write(".")); });
 * ✅ bus.on("tick", broadcast);                       // registered once at module scope
 * ✅ app.get("/x", (req, res) => { req.on("data", onData); });  // per-request object, GC'd
 */

const ADD_METHODS = new Set(["on", "addListener", "prependListener"]);

// Roots that are per-request and therefore self-cleaning — never a leak.
const REQUEST_SCOPED_ROOTS = new Set(["req", "request", "res", "response", "reply"]);

export const noListenerAddedPerRequest = defineDiagnostic({
  id: "no-listener-added-per-request",
  title: "Event listener added on every request",
  severity: "warn",
  category: "Reliability",
  tags: ["lifecycle", "memory"],
  recommendation:
    "Register listeners once at startup, or use `emitter.once(...)` inside the handler and remove it with `removeListener` when the request completes.",
  create: (ctx) => ({
    CallExpression: (node) => {
      const method = getMethodName(node);
      if (!method || !ADD_METHODS.has(method)) return;

      const root = rootObjectName(node);
      if (root && REQUEST_SCOPED_ROOTS.has(root)) return; // per-request emitter, self-cleaning

      if (!isOnRequestPath(node, ctx.requestHandlers)) return;

      ctx.report(
        node,
        `\`.${method}(...)\` on a long-lived emitter runs on every request — the listener is re-added each time and never removed, leaking memory until MaxListenersExceeded.`,
      );
    },
  }),
});
