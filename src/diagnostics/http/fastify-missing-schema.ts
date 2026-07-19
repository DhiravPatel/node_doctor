import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, getObjectProperty, isFunctionLike } from "../../core/ast.ts";

/**
 * OPT-IN. A Fastify route declared without a `schema`. Fastify's headline safety
 * feature is per-route JSON Schema validation: attach a `schema` and the body,
 * query, params, and headers are validated (and the response serialized) against
 * it before the handler runs. A route with no `schema` accepts arbitrary input,
 * losing both the validation and the fast serializer.
 *
 * To stay precise, the method form only fires on the explicit 3-argument shape
 * `fastify.get(path, options, handler)` where `options` is an object literal —
 * this is unmistakably Fastify's options object (Express's middleware arguments
 * are functions, not objects), so the diagnostic never mistakes an Express route for a
 * Fastify one.
 *
 * ❌ fastify.get("/users/:id", { onRequest: auth }, handler);
 * ❌ fastify.route({ method: "POST", url: "/users", handler });
 * ✅ fastify.get("/users/:id", { schema: { params: S } }, handler);
 * ✅ fastify.get("/users/:id", handler);   // 2-arg form: no options object to check
 */

const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "all"]);

/** True if the options object cannot be reasoned about (a spread may carry schema). */
const hasSpread = (obj: AstNode): boolean =>
  Array.isArray(obj.properties) &&
  (obj.properties as AstNode[]).some((p) => p.type === "SpreadElement" || p.type === "ExperimentalSpreadProperty");

export const fastifyMissingSchema = defineDiagnostic({
  id: "fastify-missing-schema",
  title: "Fastify route without a validation schema",
  severity: "warn",
  category: "Reliability",
  requires: ["fastify"],
  defaultEnabled: false,
  tags: ["fastify"],
  recommendation:
    "Attach a JSON `schema` to the route (`{ schema: { body, querystring, params } }`). Fastify validates and serializes against it before the handler runs; without one the route accepts arbitrary input.",
  create: (ctx) => ({
    CallExpression: (node) => {
      const method = getMethodName(node);
      if (!method) return;
      const args = (node.arguments as AstNode[]) ?? [];

      // Object-route form: fastify.route({ ... }).
      if (method === "route") {
        const opts = args[0];
        if (!opts || opts.type !== "ObjectExpression") return;
        if (hasSpread(opts)) return;
        if (getObjectProperty(opts, "schema")) return;
        ctx.report(opts, "This `fastify.route({...})` declares no `schema` — its body/query/params are never validated.");
        return;
      }

      // Method form: only the explicit (path, optionsObject, handler) shape.
      if (!ROUTE_METHODS.has(method)) return;
      if (args.length < 3) return; // 2-arg form has no options object to inspect
      const opts = args[1];
      if (!opts || opts.type !== "ObjectExpression") return; // Express-style middleware fn → not us
      if (!isFunctionLike(args[2])) return; // 3rd arg must be the handler
      if (hasSpread(opts)) return;
      if (getObjectProperty(opts, "schema")) return;

      ctx.report(opts, `This \`fastify.${method}(...)\` route options object declares no \`schema\` — its input is never validated.`);
    },
  }),
});
