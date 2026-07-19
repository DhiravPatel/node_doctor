import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, rootObjectName, getObjectProperty } from "../../core/ast.ts";

/**
 * A body parser mounted without a `limit`. `express.json()` /
 * `express.urlencoded()` (and the `body-parser` equivalents) default to a `100kb`
 * cap in current Express, but any project pinning an older release — or expecting
 * the historically-unbounded behavior — buffers the entire request body in memory
 * before the handler runs. An attacker streams a multi-gigabyte JSON body and the
 * event-loop thread is pinned parsing it while the heap climbs toward OOM. An
 * explicit `limit` makes the cap a deliberate, reviewable decision.
 *
 * Only the `express.` / `bodyParser.` receiver forms are matched, so `res.json()`
 * and unrelated `.json()` calls are never touched.
 *
 * ❌ app.use(express.json());
 * ❌ app.use(express.urlencoded({ extended: true }));
 * ❌ app.use(bodyParser.json({ strict: true }));
 * ✅ app.use(express.json({ limit: "1mb" }));
 * ✅ app.use(express.urlencoded({ extended: true, limit: "1mb" }));
 */

const PARSER_METHODS = new Set(["json", "urlencoded"]);
const PARSER_RECEIVERS = new Set(["express", "bodyParser"]);

/** True if we cannot be sure `limit` is absent (spread could carry it). */
const hasSpread = (obj: AstNode): boolean =>
  Array.isArray(obj.properties) &&
  (obj.properties as AstNode[]).some((p) => p.type === "SpreadElement" || p.type === "ExperimentalSpreadProperty");

export const noMissingBodySizeLimit = defineDiagnostic({
  id: "no-missing-body-size-limit",
  title: "Body parser without a size limit",
  severity: "warn",
  category: "Reliability",
  requires: ["express"],
  tags: ["express", "lifecycle"],
  recommendation:
    "Pass an explicit cap: `express.json({ limit: '1mb' })` (or the size your API actually needs). An unbounded body parser buffers the whole request in memory and is a denial-of-service / OOM vector.",
  create: (ctx) => ({
    CallExpression: (node) => {
      const method = getMethodName(node);
      if (!method || !PARSER_METHODS.has(method)) return;

      const receiver = rootObjectName(node.callee);
      if (!receiver || !PARSER_RECEIVERS.has(receiver)) return;

      const opts = (node.arguments as AstNode[])[0];

      // No options object at all → definitely no limit.
      if (!opts) {
        ctx.report(node, `\`${receiver}.${method}()\` is mounted with no size limit — an unbounded body is a memory-exhaustion vector.`);
        return;
      }

      // Only reason about a literal options object; anything else (an identifier,
      // a call) is opaque, so stay silent rather than risk a false positive.
      if (opts.type !== "ObjectExpression") return;
      if (hasSpread(opts)) return; // a spread could carry `limit`
      if (getObjectProperty(opts, "limit")) return; // limit present → silent

      ctx.report(
        node,
        `\`${receiver}.${method}(...)\` has no \`limit\` — an unbounded body is buffered fully in memory and can exhaust the heap.`,
      );
    },
  }),
});
