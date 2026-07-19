import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, isFunctionLike, getStaticStringValue } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";

/**
 * OPT-IN, whole-file heuristic. A file that registers Express routes but never
 * registers a 4-argument error-handling middleware. In Express, an error handler
 * is distinguished purely by arity: `app.use((err, req, res, next) => ...)`.
 * Without one, any error that reaches Express (a thrown exception, a `next(err)`)
 * is served by the default handler — a stack trace in development, a bare 500 in
 * production — instead of your logging / shaped error response.
 *
 * The check stays silent whenever *any* 4-parameter function exists in the file
 * (the error-handler signature), and whenever the file registers no routes. It
 * fires once, on the first route registration.
 *
 * ❌ app.get("/users", handler); app.post("/users", handler); // no (err,req,res,next)
 * ✅ app.get("/users", handler); app.use((err, req, res, next) => res.status(500).end());
 */

const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "all"]);

/** A route registration: `x.get("/path", ...)` with a string path first arg. */
const isRouteRegistration = (node: AstNode): boolean => {
  if (node.type !== "CallExpression") return false;
  const method = getMethodName(node);
  if (!method || !ROUTE_METHODS.has(method)) return false;
  const args = (node.arguments as AstNode[]) ?? [];
  if (args.length < 2) return false; // a real registration is (path, ...handlers)
  const path = getStaticStringValue(args[0]);
  return typeof path === "string" && path.startsWith("/");
};

export const requireErrorHandlingMiddleware = defineDiagnostic({
  id: "require-error-handling-middleware",
  title: "Express app with no error-handling middleware",
  severity: "warn",
  category: "Reliability",
  requires: ["express"],
  defaultEnabled: false,
  tags: ["express"],
  recommendation:
    "Register a terminal error handler: `app.use((err, req, res, next) => { ... })`. Its 4-argument signature is how Express routes thrown errors and `next(err)` to your logging and shaped 500 response.",
  create: (ctx) => ({
    "Program:exit": () => {
      const routes = collectDescendants(ctx.program, isRouteRegistration);
      if (routes.length === 0) return;

      // Any 4-param function is the Express error-handler signature.
      const hasErrorHandler =
        collectDescendants(ctx.program, (n) => isFunctionLike(n) && ((n.params as AstNode[]) ?? []).length === 4).length > 0;
      if (hasErrorHandler) return;

      ctx.report(
        routes[0]!,
        "This file registers routes but no 4-argument error-handling middleware — thrown errors and `next(err)` fall through to Express's default handler.",
      );
    },
  }),
});
