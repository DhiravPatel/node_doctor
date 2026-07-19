import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, getStaticStringValue, rootObjectName } from "../../core/ast.ts";

/**
 * A server that binds a port but never registers a `SIGTERM` handler has no
 * graceful shutdown. When the orchestrator sends SIGTERM (deploy, scale-down,
 * OOM), the default action kills the process immediately: in-flight requests are
 * cut mid-response, connections are reset, and DB transactions are abandoned. A
 * SIGTERM handler that calls `server.close()` lets the process stop accepting new
 * connections and drain the ones already running before exiting.
 *
 * Opt-in (defaultEnabled:false): it is a whole-file heuristic and a missing
 * handler in one file may live in another module, so it is advisory only.
 *
 * ❌ const server = app.listen(PORT);   // and nothing listens for SIGTERM
 * ✅ const server = app.listen(PORT);
 *    process.on("SIGTERM", () => server.close(() => process.exit(0)));
 */

const LISTENER_METHODS = new Set(["on", "once", "addListener", "prependListener", "prependOnceListener"]);

export const requireSigtermHandler = defineDiagnostic({
  id: "require-sigterm-handler",
  title: "Server started without a SIGTERM handler",
  severity: "warn",
  category: "Reliability",
  tags: ["lifecycle"],
  defaultEnabled: false,
  recommendation:
    "On `process.on('SIGTERM', ...)`, stop accepting connections and call `server.close(() => process.exit(0))` so in-flight requests drain before the process exits.",
  create: (ctx) => {
    let listenNode: AstNode | null = null;
    let hasSigterm = false;

    return {
      CallExpression: (node) => {
        const method = getMethodName(node);
        if (!method) return;

        // Any `.listen(...)` — app.listen / server.listen / createServer().listen.
        if (method === "listen" && !listenNode) {
          listenNode = node;
          return;
        }

        // `process.on('SIGTERM', ...)` (or once/addListener/prepend*).
        if (LISTENER_METHODS.has(method) && rootObjectName(node) === "process") {
          const arg0 = (node.arguments as AstNode[])?.[0];
          if (getStaticStringValue(arg0) === "SIGTERM") hasSigterm = true;
        }
      },

      "Program:exit": () => {
        if (listenNode && !hasSigterm) {
          ctx.report(
            listenNode,
            "Server binds a port but registers no `process.on('SIGTERM', ...)` handler — there is no graceful shutdown, so a deploy or scale-down kills in-flight requests.",
          );
        }
      },
    };
  },
});
