import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getCalleeName, getStaticStringValue, REQUEST_ROOTS } from "../../core/ast.ts";
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
 *
 * PRECISION: THE PAYLOAD MUST BE THE REQUEST, SYNTACTICALLY.
 *
 * This rule is about SIZE, and size is bounded by where the bytes came from — so
 * "caller-controlled" in the taint sense is the wrong test, and using it produced
 * 94 false positives in a single codebase the moment AdonisJS handlers became
 * recognizable. Every one was of this shape:
 *
 *   const location = await locationsCollection.findOne({ location_id: id })
 *   const details  = JSON.parse(location.location_details)   // ← reported
 *
 * Taint reaches `location` legitimately — a request field chose which row to read
 * — but the bytes come from the DATABASE. A caller cannot make a stored column
 * megabytes by sending a large request, so there is no event-loop hazard, and the
 * finding is simply wrong. Taint through a database round-trip still matters for
 * INJECTION rules (stored XSS is real), which is why this is fixed here rather
 * than by weakening `computeTaint` for everyone.
 *
 * So the argument must BE the request payload: `req.body`, a whole-request member,
 * or a direct alias of one. The same correction `no-mass-assignment` needed, for
 * the same reason — it went from 743 false positives to 0 by requiring the body
 * syntactically instead of accepting anything request-DERIVED.
 */
export const noLargeJsonParseInRequestPath = defineDiagnostic({
  id: "no-large-json-parse-in-request-path",
  title: "JSON.parse of caller input on a request path",
  severity: "warn",
  category: "Performance",
  tags: ["event-loop"],
  recommendation:
    "Enforce a body size limit (e.g. `express.json({ limit: '100kb' })`) before parsing, and move parsing of large payloads off the hot path (a worker thread or a streaming parser). Synchronous `JSON.parse` blocks the single event-loop thread for the whole parse.",
  create: (ctx) => {
    /**
     * Is this expression the request payload itself — not merely something a
     * request influenced? A caller can only make the bytes large where the bytes
     * ARE the request.
     */
    const isRequestPayload = (raw: AstNode | null | undefined, depth = 0): boolean => {
      if (!raw || depth > 4) return false;
      // `req` / `request` / `ctx` used whole.
      if (raw.type === "Identifier" && REQUEST_ROOTS.has(raw.name as string)) return true;
      // `req.body`, `req.body.raw`, `request.raw()` — rooted at a request object.
      if (raw.type === "MemberExpression") {
        return isRequestPayload(raw.object as AstNode, depth + 1);
      }
      if (raw.type === "CallExpression") {
        const callee = raw.callee as AstNode | undefined;
        // `request.input("x")` / `req.body()` — the request handing over its bytes.
        if (callee?.type === "MemberExpression") return isRequestPayload(callee.object as AstNode, depth + 1);
        return false;
      }
      // A direct alias: `const body = req.body`.
      if (raw.type === "Identifier") {
        const binding = ctx.scope.getBinding(raw.name as string, raw);
        // Only follow a `const` alias; a reassigned binding is unknown.
        if (binding?.kind !== "const") return false;
        return isRequestPayload(binding.initNode as AstNode | undefined, depth + 1);
      }
      return false;
    };

    return {
      CallExpression: (node) => {
        if (getCalleeName(node) !== "JSON.parse") return;

        const arg0 = (node.arguments as AstNode[])[0];
        if (!arg0) return;

        // A static/small string literal is bounded and harmless.
        if (getStaticStringValue(arg0) !== null) return;

        // Only a concern on the hot path — a module-scope parse is a boot cost.
        if (!isOnRequestPath(node, ctx.requestHandlers)) return;

        // The bytes must BE the request. Something a request merely influenced —
        // a database row it selected — is not caller-sized. See the header.
        if (!isRequestPayload(arg0)) return;

        ctx.report(
          arg0,
          "`JSON.parse` of the request payload runs synchronously on a request path — a caller can send megabytes, and the parse blocks the entire event loop for its whole duration.",
        );
      },
    };
  },
});
