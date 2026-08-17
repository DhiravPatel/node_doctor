import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, rootObjectName } from "../../core/ast.ts";
import { findEnclosingRequestHandler } from "../../core/request-path.ts";

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

/**
 * The receiver of this `.on(…)`, unwrapped to whatever the emitter really is.
 * `fs.createReadStream(p).pipe(csv()).on(…)` → the inner `pipe(…)` call.
 */
const emitterOf = (node: AstNode): AstNode | null => {
  const callee = node.callee as AstNode | undefined;
  if (callee?.type !== "MemberExpression") return null;
  let receiver = callee.object as AstNode | undefined;
  for (let depth = 0; receiver && depth < 16; depth++) {
    if (receiver.type !== "MemberExpression") return receiver;
    receiver = receiver.object as AstNode | undefined;
  }
  return null;
};

/** A call or construction produces a NEW object every time it is evaluated. */
const isConstruction = (node: AstNode | null | undefined): boolean =>
  node?.type === "CallExpression" || node?.type === "NewExpression";

/** Does `node` sit inside `container`, by source range? */
const isWithin = (node: AstNode, container: AstNode): boolean =>
  typeof node.start === "number" &&
  typeof container.start === "number" &&
  typeof container.end === "number" &&
  node.start >= container.start &&
  node.start <= container.end;

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

      const handler = findEnclosingRequestHandler(node, ctx.requestHandlers);
      if (!handler) return;

      // A FRESHLY CONSTRUCTED emitter is per-request too, and the name-based
      // exclusion above cannot see it. The leak this rule describes requires an
      // emitter that OUTLIVES the request; one built inside the handler dies with
      // it, exactly like `req.on(…)` does.
      //
      // Measured: 22 of the 25 findings that appeared the moment AdonisJS
      // controllers became recognizable were this, in two shapes —
      //   fs.createReadStream(p).pipe(csv()).on("data", …)   (17, inline chain)
      //   const archive = archiver("zip"); archive.on("error", …)   (5, via binding)
      // — and every one was wrong. A name test could never have caught either:
      // the first chain roots at `fs`, a module, and the second at a local whose
      // name says nothing about its lifetime.
      const emitter = emitterOf(node);
      if (isConstruction(emitter)) return;
      if (emitter?.type === "Identifier") {
        const binding = ctx.scope.getBinding(emitter.name as string, emitter);
        const declaration = binding?.declNode as AstNode | undefined;
        // Declared inside THIS handler, from a construction → per-request.
        if (
          declaration &&
          isWithin(declaration, handler) &&
          isConstruction(binding?.initNode as AstNode | undefined)
        ) {
          return;
        }
      }

      ctx.report(
        node,
        `\`.${method}(...)\` on a long-lived emitter runs on every request — the listener is re-added each time and never removed, leaking memory until MaxListenersExceeded.`,
      );
    },
  }),
});
