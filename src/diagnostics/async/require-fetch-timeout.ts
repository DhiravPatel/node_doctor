import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getCalleeName, getObjectProperty } from "../../core/ast.ts";

/**
 * An outbound `fetch` with no `signal` / timeout. A `fetch` without a signal
 * waits effectively forever for a server that accepts the socket then stalls.
 * One hung upstream pins a request slot, then a connection, then the pool.
 *
 * ❌ const res = await fetch("https://partner.api/sync");
 * ✅ const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
 *
 * Stays silent when a `signal` is present, or the options are spread/variable
 * (unanalyzable without types — we stay quiet rather than guess).
 */
export const requireFetchTimeout = defineDiagnostic({
  id: "require-fetch-timeout",
  title: "Outbound fetch without a timeout or abort signal",
  severity: "warn",
  category: "Reliability",
  tags: ["async", "network"],
  recommendation:
    "Pass an abort signal: `fetch(url, { signal: AbortSignal.timeout(5_000) })` (Node 18+). Without it a stalled upstream pins a request slot, then a connection, then the whole pool.",
  create: (ctx) => ({
    CallExpression: (node) => {
      // Only bare, global `fetch(...)` — not `client.fetch(...)`.
      if (getCalleeName(node) !== "fetch") return;

      const opts = (node.arguments as AstNode[])[1];
      if (!opts) {
        ctx.report(node, "This `fetch` has no options and therefore no timeout — it can hang forever.");
        return;
      }
      // Only reason about an object literal; spread/variable options are opaque.
      if (opts.type !== "ObjectExpression") return;

      const hasSignal = getObjectProperty(opts, "signal") || getObjectProperty(opts, "timeout");
      if (hasSignal) return;

      ctx.report(node, "This `fetch` passes options but no `signal`/timeout — it can hang forever on a stalled upstream.");
    },
  }),
});
