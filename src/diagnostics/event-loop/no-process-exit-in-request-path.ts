import { defineDiagnostic } from "../../core/types.ts";
import { getCalleeName } from "../../core/ast.ts";
import { isOnRequestPath } from "../../core/request-path.ts";

/**
 * `process.exit()` (or `process.abort()`) reachable from a request handler.
 *
 * `process.exit()` terminates immediately: in-flight requests are severed
 * mid-response, pending writes are lost, open transactions are abandoned. Inside
 * a handler it converts one bad request into a whole-instance outage.
 *
 * ❌ app.get("/admin/shutdown", (req, res) => { if (req.query.confirm) process.exit(0); });
 * ✅ process.on("uncaughtException", (err) => { logger.fatal(err); process.exit(1); }); // not a request path
 */
export const noProcessExitInRequestPath = defineDiagnostic({
  id: "no-process-exit-in-request-path",
  title: "process.exit() on a request path",
  severity: "error",
  category: "Reliability",
  tags: ["event-loop", "lifecycle"],
  recommendation:
    "Never call `process.exit`/`process.abort` from a handler. Respond, then drain and shut down outside the request (`scheduleGracefulShutdown()` → `server.close()` on SIGTERM). Reserve `process.exit` for top-level fatal handlers.",
  create: (ctx) => ({
    CallExpression: (node) => {
      const callee = getCalleeName(node);
      if (callee !== "process.exit" && callee !== "process.abort") return;
      if (!isOnRequestPath(node, ctx.requestHandlers)) return;
      ctx.report(
        node,
        "`process.exit()` on a request path kills every in-flight request and abandons open transactions — a one-request denial of service.",
      );
    },
  }),
});
