import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getCalleeName, getStaticStringValue, looksCallerControlled } from "../../core/ast.ts";
import { isOnRequestPath } from "../../core/request-path.ts";

/**
 * `JSON.parse(x)` of caller-controlled input on a request path.
 *
 * Why it matters: `JSON.parse` is synchronous and runs on the single event-loop
 * thread. A large body — a caller can send megabytes — blocks parsing for the
 * whole duration, freezing every other concurrent request, the timers, and the
 * liveness probe. The same parse of a static string, or of a bounded config file
 * at module scope, is harmless; the danger is caller-sized input on the hot path.
 *
 * ❌ app.post("/import", (req, res) => { const rows = JSON.parse(req.body.raw); … })
 * ✅ const config = JSON.parse(fs.readFileSync("./config.json", "utf8")); // module scope, bounded
 * ✅ app.post("/x", (req, res) => { const cfg = JSON.parse('{"a":1}'); … }); // static literal
 */
export const noLargeJsonParseInRequestPath = defineDiagnostic({
  id: "no-large-json-parse-in-request-path",
  title: "JSON.parse of caller input on a request path",
  severity: "warn",
  category: "Performance",
  tags: ["event-loop"],
  recommendation:
    "Enforce a body size limit (e.g. `express.json({ limit: '100kb' })`) before parsing, and move parsing of large payloads off the hot path (a worker thread or a streaming parser). Synchronous `JSON.parse` blocks the single event-loop thread for the whole parse.",
  create: (ctx) => ({
    CallExpression: (node) => {
      if (getCalleeName(node) !== "JSON.parse") return;

      const arg0 = (node.arguments as AstNode[])[0];
      if (!arg0) return;

      // A static/small string literal is bounded and harmless.
      if (getStaticStringValue(arg0) !== null) return;

      // Only a concern on the hot path — a module-scope parse is a boot cost.
      if (!isOnRequestPath(node, ctx.requestHandlers)) return;

      // The payload must be caller-sized: a tainted binding or a request root.
      if (!looksCallerControlled(arg0, ctx.taintedBindings)) return;

      ctx.report(
        arg0,
        "`JSON.parse` of caller-controlled input runs synchronously on a request path — a large payload blocks the entire event loop while it parses.",
      );
    },
  }),
});
