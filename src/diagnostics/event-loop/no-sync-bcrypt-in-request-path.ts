import { defineDiagnostic } from "../../core/types.ts";
import { getMethodName, getReceiverName } from "../../core/ast.ts";
import { isOnRequestPath } from "../../core/request-path.ts";

/**
 * Synchronous bcrypt (`hashSync` / `compareSync` / `genSaltSync`) on a request
 * path.
 *
 * Why it matters: bcrypt is a deliberately slow, CPU-bound KDF — that slowness is
 * the security property. The synchronous variants run that work inline on the
 * single event-loop thread, so every login blocks all other concurrent requests
 * for the whole cost factor. The async forms hand the work to the libuv thread
 * pool and keep the loop free.
 *
 * ❌ app.post("/login", (req, res) => { const ok = bcrypt.compareSync(req.body.pw, hash); … })
 * ✅ app.post("/login", async (req, res) => { const ok = await bcrypt.compare(req.body.pw, hash); … })
 * ✅ const hash = bcrypt.hashSync(SEED, 10); // module scope, one-time
 */

/** Distinctive bcrypt synchronous method names. */
const SYNC_METHODS = new Set(["hashSync", "compareSync", "genSaltSync"]);
/** Names distinctive enough to flag even without a `bcrypt`-shaped receiver. */
const BARE_OK = new Set(["hashSync", "compareSync"]);

export const noSyncBcryptInRequestPath = defineDiagnostic({
  id: "no-sync-bcrypt-in-request-path",
  title: "Synchronous bcrypt on a request path",
  severity: "error",
  category: "Performance",
  tags: ["event-loop", "crypto"],
  recommendation:
    "Use the async KDF (`await bcrypt.hash(...)` / `await bcrypt.compare(...)`), which offloads the CPU-bound work to the libuv thread pool. The `*Sync` form runs the whole cost factor inline and blocks every concurrent request.",
  create: (ctx) => ({
    CallExpression: (node) => {
      const method = getMethodName(node);
      if (!method || !SYNC_METHODS.has(method)) return;

      const receiver = getReceiverName(node);
      const bcryptShaped = receiver ? /bcrypt/i.test(receiver) : false;
      if (!bcryptShaped && !BARE_OK.has(method)) return;

      if (!isOnRequestPath(node, ctx.requestHandlers)) return;

      ctx.report(
        node,
        `\`${method}\` runs the deliberately-slow bcrypt KDF synchronously on a request path, blocking the event loop for every concurrent request.`,
      );
    },
  }),
});
