import { defineDiagnostic } from "../../core/types.ts";
import { getMethodName } from "../../core/ast.ts";
import { isOnRequestPath } from "../../core/request-path.ts";
import { SYNC_IO_METHODS } from "../../core/signals.ts";

/**
 * A blocking synchronous call (`*Sync` fs/child_process/crypto/zlib) on a
 * request path.
 *
 * Why it matters: Node runs your JavaScript on one thread. A synchronous read
 * inside a handler does not block "this request" — it blocks **every** concurrent
 * request, the timers, and the health check the orchestrator uses to decide
 * whether to kill the pod. The same call at module scope is a correct one-time
 * boot cost. Identical node, opposite verdict based on position.
 *
 * ❌ app.get("/r", (req, res) => { const t = fs.readFileSync("x", "utf8"); … })
 * ✅ const config = JSON.parse(fs.readFileSync("./config.json", "utf8")); // module scope
 *
 * Fires when: a `*Sync` sink is on a request path.
 * Stays silent when: the call is at module scope or in a non-handler function.
 */
export const noSyncIoInRequestPath = defineDiagnostic({
  id: "no-sync-io-in-request-path",
  title: "Blocking synchronous I/O on a request path",
  severity: "error",
  category: "Performance",
  tags: ["event-loop", "fs", "performance"],
  recommendation:
    "Use the async form (`await fs.promises.readFile(...)`, `await execFile(...)`). The synchronous call blocks the single event-loop thread, freezing every concurrent request, the timers, and the liveness probe.",
  create: (ctx) => ({
    CallExpression: (node) => {
      const method = getMethodName(node);
      if (!method || !SYNC_IO_METHODS.has(method)) return;
      if (!isOnRequestPath(node, ctx.requestHandlers)) return;
      ctx.report(
        node,
        `\`${method}\` runs synchronously on a request path and blocks the entire event loop for all concurrent requests.`,
      );
    },
  }),
});
