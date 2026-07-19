import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import {
  getMethodName,
  staticMemberPath,
  hasInterpolation,
  isStringConcatWithVariable,
  looksCallerControlled,
} from "../../core/ast.ts";

/**
 * A caller-controlled object passed straight into a Mongo/Mongoose query filter,
 * or a `$where` string built from input. When `req.query`/`req.body` reaches a
 * filter untouched, an attacker submits `{ "password": { "$ne": null } }` or
 * `{ "$where": "..." }` and the operator object is interpreted as query logic —
 * authentication bypass and data exfiltration.
 *
 * We only fire on the unambiguous shapes: the whole request container as the
 * filter, a top-level spread of caller data, or a `$where` built from input. An
 * explicit object of scalar fields cast from input stays silent.
 *
 * ❌ User.findOne(req.query);
 * ❌ User.find({ ...req.body });
 * ❌ User.find({ $where: "this.name == '" + req.query.n + "'" });
 * ✅ User.findOne({ email: String(req.body.email) }); // explicit scalar field
 * ✅ User.findById(req.params.id); // scalar id, cast by the driver
 */

// Mongo/Mongoose filter-taking methods. Deliberately excludes Prisma names
// (findUnique/findMany/findFirst/count/…) so ORM object-literals never match.
const FILTER_METHODS = new Set([
  "find",
  "findOne",
  "findOneAndUpdate",
  "findOneAndDelete",
  "findOneAndReplace",
  "updateOne",
  "updateMany",
  "replaceOne",
  "deleteOne",
  "deleteMany",
  "countDocuments",
]);

// Static member paths that denote a whole caller-controlled container object.
const REQUEST_CONTAINERS = new Set([
  "req.body",
  "req.query",
  "req.params",
  "request.body",
  "request.query",
  "request.params",
  "ctx.query",
  "ctx.request.body",
  "ctx.request.query",
]);

export const noNosqlObjectInjection = defineDiagnostic({
  id: "no-nosql-object-injection",
  title: "NoSQL operator/object injection",
  severity: "error",
  category: "Security",
  tags: ["injection", "db"],
  recommendation:
    "Never pass a raw request object as a filter. Whitelist expected fields and cast each to a scalar (e.g. `String(req.body.email)`), and never build a `$where` clause from input.",
  create: (ctx) => ({
    CallExpression: (node) => {
      const method = getMethodName(node);
      if (!method || !FILTER_METHODS.has(method)) return;
      const arg0 = (node.arguments as AstNode[])[0];
      if (!arg0) return;

      // (a) The whole request container passed straight through as the filter.
      const path = staticMemberPath(arg0);
      if (path && REQUEST_CONTAINERS.has(path)) {
        ctx.report(
          arg0,
          "A raw request object is used directly as a NoSQL filter — an attacker can inject query operators like `$ne`/`$gt` (authentication bypass).",
        );
        return;
      }

      if (arg0.type !== "ObjectExpression") return;
      for (const prop of (arg0.properties as AstNode[]) ?? []) {
        // (b) Top-level spread of caller-controlled data into the filter.
        if (prop.type === "SpreadElement" && looksCallerControlled(prop.argument, ctx.taintedBindings)) {
          ctx.report(
            prop,
            "Caller-controlled data is spread into a NoSQL filter — injected query operators pass straight through.",
          );
          return;
        }
        // (c) A `$where` clause built from input.
        if (prop.type === "Property") {
          const key = prop.key;
          const keyName =
            key?.type === "Identifier" ? key.name : key?.type === "Literal" ? key.value : null;
          if (keyName === "$where") {
            const value = prop.value as AstNode;
            const dynamic = hasInterpolation(value) || isStringConcatWithVariable(value);
            if (dynamic && looksCallerControlled(value, ctx.taintedBindings)) {
              ctx.report(
                value,
                "A `$where` clause is built from caller-controlled input — this is server-side JavaScript injection.",
              );
              return;
            }
          }
        }
      }
    },
  }),
});
