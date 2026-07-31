import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getStaticStringValue, getCalleeName } from "../../core/ast.ts";
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

/** Only `connection` — `connect` is emitted by pg/redis/net clients too, and
 *  those own their error handling. */
const CONNECTION_EVENTS = new Set(["connection"]);

/** Listener-registration methods we understand. */
const REGISTRARS = new Set(["on", "once", "addListener", "prependListener", "prependOnceListener"]);

/** `ws` packages whose import proves this file really is websocket code. */
const WS_SOURCES = new Set(["ws"]);

/** The property name of a member expression, including a computed string key
 *  (`socket["on"]` is exactly `socket.on` at runtime). */
const propertyName = (member: AstNode): string | null => {
  const property = member.property as AstNode | undefined;
  if (!member.computed && property?.type === "Identifier") return property.name as string;
  if (member.computed && property?.type === "Literal" && typeof property.value === "string") {
    return property.value;
  }
  return null;
};

/** The identifier a member/call chain is rooted at: `s` for `s.on(a).on(b)`. */
const chainRoot = (node: AstNode | undefined): string | null => {
  let current: AstNode | undefined = node;
  let guard = 0;
  while (current && guard++ < 64) {
    if (current.type === "CallExpression") current = current.callee as AstNode | undefined;
    else if (current.type === "MemberExpression") current = current.object as AstNode | undefined;
    else if (current.type === "Identifier") return current.name as string;
    else return null;
  }
  return null;
};

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
  create: (ctx) => {
    // FILE-LEVEL IMPORT GATE. The `ws` capability only says the project depends
    // on ws somewhere; it does not make THIS file websocket code. Without this,
    // an http.Server `connection` handler (Node attaches its own error listener),
    // a socket.io handler (deliberately out of scope), a pg/redis client, a
    // hand-rolled emitter, and a test double all look identical to a ws socket.
    let importsWs = false;
    for (const stmt of (ctx.program.body as AstNode[] | undefined) ?? []) {
      if (stmt.type === "ImportDeclaration" && typeof stmt.source?.value === "string") {
        if (WS_SOURCES.has(stmt.source.value)) importsWs = true;
      }
    }
    if (!importsWs) {
      for (const call of collectDescendants(
        ctx.program,
        (n) => n.type === "CallExpression" && getCalleeName(n.callee as AstNode) === "require",
        undefined,
        true,
      )) {
        const spec = getStaticStringValue(((call.arguments as AstNode[] | undefined) ?? [])[0]);
        if (spec !== null && WS_SOURCES.has(spec)) importsWs = true;
      }
    }

    /** Every `<server>.on("connection", …)` in the file, by server binding — a
     *  server with MORE THAN ONE connection handler may register the error
     *  listener in the other one, so none of them can be judged. */
    const connectionHandlersByServer = new Map<string, number>();

    return {
      CallExpression: (node) => {
        if (!importsWs) return;
        const callee = node.callee as AstNode | undefined;
        if (callee?.type !== "MemberExpression") return;
        const method = propertyName(callee);
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

        // Count connection handlers per server binding; a second one elsewhere
        // may attach the error listener to the same sockets.
        const serverName = chainRoot(callee.object as AstNode | undefined);
        if (serverName) {
          const seen = (connectionHandlersByServer.get(serverName) ?? 0) + 1;
          connectionHandlersByServer.set(serverName, seen);
          if (seen > 1) return;
          // A later duplicate cannot retract this report, so require that this is
          // the ONLY connection handler for the binding in the whole file.
          let total = 0;
          for (const other of collectDescendants(
            ctx.program,
            (n) => n.type === "CallExpression",
            undefined,
            true,
          )) {
            const otherCallee = other.callee as AstNode | undefined;
            if (otherCallee?.type !== "MemberExpression") continue;
            const otherMethod = propertyName(otherCallee);
            if (!otherMethod || !REGISTRARS.has(otherMethod)) continue;
            const otherEvent = getStaticStringValue(((other.arguments as AstNode[] | undefined) ?? [])[0]);
            if (otherEvent === null || !CONNECTION_EVENTS.has(otherEvent)) continue;
            if (chainRoot(otherCallee.object as AstNode | undefined) === serverName) total++;
          }
          if (total > 1) return;
        }

        const body = (handler.body as AstNode) ?? handler;

        // Registrations on this socket, following chains (`s.on(a).on(b)`), and
        // the `s.onerror = fn` accessor ws defines alongside the emitter API.
        let registrations = 0;
        let hasErrorListener = false;
        let unmodelled = false;

        for (const call of collectDescendants(body, (n) => n.type === "CallExpression", undefined, true)) {
          const c = call.callee as AstNode | undefined;
          if (c?.type !== "MemberExpression") continue;
          if (chainRoot(c.object as AstNode | undefined) !== socketName) continue;
          const m = propertyName(c);
          if (!m) {
            unmodelled = true; // a computed, non-literal method name
            continue;
          }
          if (m === "addEventListener") {
            const evt = getStaticStringValue(((call.arguments as AstNode[] | undefined) ?? [])[0]);
            if (evt === "error") hasErrorListener = true;
            else unmodelled = true;
            continue;
          }
          if (m === "off" || m === "removeListener" || m === "removeAllListeners") {
            unmodelled = true;
            continue;
          }
          if (!REGISTRARS.has(m)) continue;
          const evt = getStaticStringValue(((call.arguments as AstNode[] | undefined) ?? [])[0]);
          if (evt === null) unmodelled = true;
          else {
            registrations++;
            if (evt === "error") hasErrorListener = true;
          }
        }

        // `socket.onerror = handler` is a real error listener in ws.
        for (const assign of collectDescendants(
          body,
          (n) => n.type === "AssignmentExpression",
          undefined,
          true,
        )) {
          const left = assign.left as AstNode | undefined;
          if (left?.type !== "MemberExpression") continue;
          if (chainRoot(left.object as AstNode | undefined) !== socketName) continue;
          if (propertyName(left) === "onerror") hasErrorListener = true;
        }

        if (unmodelled || hasErrorListener || registrations === 0) return;

        // The socket used as a BARE value (passed to a helper, stored, returned)
        // — the error handler may be attached out of sight.
        for (const ref of collectDescendants(
          body,
          (n) => n.type === "Identifier" && n.name === socketName,
          undefined,
          true,
        )) {
          const parent = (ref as { parent?: AstNode }).parent;
          if (parent?.type === "MemberExpression" && (parent.object as AstNode) === ref) continue;
          return; // escapes
        }

        ctx.report(
          handler,
          `This websocket connection registers ${registrations} listener(s) but no \`error\` listener. A socket is an EventEmitter, so an \`error\` event with no listener is re-thrown as an uncaught exception — a client dropping mid-frame would crash the process and every other connected socket with it.`,
        );
      },
    };
  },
});
