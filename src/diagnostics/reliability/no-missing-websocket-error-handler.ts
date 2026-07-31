import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, getStaticStringValue, getCalleeName } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";

/**
 * §31 — a `ws` connection that registers listeners but never handles `error`.
 *
 * THE BUG. In the `ws` library each socket is an `EventEmitter`, and Node's
 * EventEmitter contract is unforgiving: an `error` event with NO listener is
 * re-thrown as an uncaught exception. A websocket errors for reasons entirely
 * outside your control — a client vanishing mid-frame, a half-open TCP
 * connection, a protocol violation, an ECONNRESET on a flaky mobile network. So
 * a connection handler that carefully wires up `message` and `close` but omits
 * `error` is one bad client away from taking down the whole process, killing
 * every OTHER connected socket with it. It survives every test because the
 * happy path never emits `error`.
 *
 *   ❌ wss.on("connection", (ws) => {
 *        ws.on("message", handle);
 *        ws.on("close", cleanup);
 *      });                                    // one ECONNRESET → process exit
 *
 *   ✅ wss.on("connection", (ws) => {
 *        ws.on("message", handle);
 *        ws.on("close", cleanup);
 *        ws.on("error", (err) => logger.error({ err }, "socket error"));
 *      });
 *
 * PRECISION MODEL — this fires only on the shape where the omission is provable:
 *
 *   - The file must import `ws` (socket.io buffers its own errors differently and
 *     is deliberately out of scope).
 *   - We only inspect a `connection`/`connect` handler whose socket parameter is
 *     a plain identifier, and only when that socket ALREADY has at least one
 *     `.on(...)`/`.once(...)` registration — proof the author is wiring this
 *     emitter up here, rather than elsewhere.
 *   - If the socket is passed anywhere else (`setupSocket(ws)`, `sockets.add(ws)`,
 *     a spread, a return) the error handler may be attached there, so we stay
 *     silent.
 *   - A registration with a dynamic event name, or via `addEventListener`, or a
 *     `.on("error")` anywhere on that binding, is also silence.
 *
 * The result: we report only a handler that demonstrably wires this socket's
 * events in place, does not hand it off, and has no error path.
 */

/** Event names whose handler receives a socket as its first parameter. */
const CONNECTION_EVENTS = new Set(["connection", "connect"]);

/** Listener-registration methods we understand. */
const REGISTRARS = new Set(["on", "once", "addListener", "prependListener", "prependOnceListener"]);

export const noMissingWebsocketErrorHandler = defineDiagnostic({
  id: "no-missing-websocket-error-handler",
  title: "WebSocket connection has no error listener",
  severity: "warn",
  category: "Reliability",
  confidence: "high",
  tags: ["reliability", "websocket", "crash"],
  defaultEnabled: false,
  requires: ["ws"],
  recommendation:
    "Register an `error` listener on every websocket: `ws.on(\"error\", (err) => logger.error({ err }, \"socket error\"))`. A socket is an EventEmitter, so an `error` event with no listener is re-thrown as an uncaught exception — one client dropping its connection would otherwise take down the process and every other socket with it.",
  create: (ctx) => ({
    CallExpression: (node) => {
      // Match `<server>.on("connection", (ws, req) => { … })`.
      const method = getMethodName(node);
      if (!method || !REGISTRARS.has(method)) return;
      const args = (node.arguments as AstNode[] | undefined) ?? [];
      const eventName = getStaticStringValue(args[0]);
      if (eventName === null || !CONNECTION_EVENTS.has(eventName)) return;

      const handler = args[1];
      if (
        !handler ||
        (handler.type !== "ArrowFunctionExpression" && handler.type !== "FunctionExpression")
      ) {
        return;
      }
      const socketParam = ((handler.params as AstNode[] | undefined) ?? [])[0];
      if (socketParam?.type !== "Identifier") return;
      const socketName = socketParam.name as string;
      const body = (handler.body as AstNode) ?? handler;

      // Every reference to the socket binding inside the handler.
      const references = collectDescendants(
        body,
        (n) => n.type === "Identifier" && n.name === socketName,
        undefined,
        true,
      );
      if (references.length === 0) return;

      let registrations = 0;
      let hasErrorListener = false;
      let dynamicOrHandedOff = false;

      for (const ref of references) {
        const parent = (ref as { parent?: AstNode }).parent;
        // `<socket>.<something>` — a member access on the socket.
        if (parent?.type === "MemberExpression" && (parent.object as AstNode) === ref) {
          const grandparent = (parent as { parent?: AstNode }).parent;
          const prop = (parent.property as AstNode | undefined)?.type === "Identifier"
            ? ((parent.property as AstNode).name as string)
            : null;
          if (grandparent?.type === "CallExpression" && (grandparent.callee as AstNode) === parent) {
            if (prop && REGISTRARS.has(prop)) {
              const evt = getStaticStringValue(((grandparent.arguments as AstNode[] | undefined) ?? [])[0]);
              if (evt === null) dynamicOrHandedOff = true; // a computed event name
              else {
                registrations++;
                if (evt === "error") hasErrorListener = true;
              }
              continue;
            }
            if (prop === "addEventListener" || prop === "off" || prop === "removeListener") {
              dynamicOrHandedOff = true; // a listener API we do not model
              continue;
            }
          }
          continue; // any other property read/call (ws.send, ws.readyState) is fine
        }
        // The socket used as a bare value: passed to a call, stored, returned,
        // spread — the error handler may be attached out of sight.
        dynamicOrHandedOff = true;
      }

      if (dynamicOrHandedOff || hasErrorListener || registrations === 0) return;

      ctx.report(
        handler,
        `This websocket connection registers ${registrations} listener(s) but no \`error\` listener. A socket is an EventEmitter, so an \`error\` event with no listener is re-thrown as an uncaught exception — a client dropping mid-frame would crash the process and every other connected socket with it.`,
      );
    },
  }),
});
