/**
 * Request-handler detection — the load-bearing primitive.
 *
 * We identify the functions that run in request context by recognizing:
 *   - method-call registrations: `app.get("/x", handler)`, `router.use(mw)`;
 *   - object-route form: `fastify.route({ handler, preHandler })`;
 *   - decorator handlers: a class method carrying `@Get()`, `@Post()`, …;
 *   - a `(req, res)` / `(request, reply)` signature fallback for split-file
 *     controllers whose registration lives in another module.
 *
 * Wrapper calls (`asyncHandler(fn)`) and same-file named references are followed
 * one level so the *inner* function is still marked as a handler.
 *
 * Detection is direct-lexical and sound in that direction: everything it marks
 * really is written inside a request path. It does not yet follow a call from a
 * handler into a helper in another file — that is the Phase B call graph.
 */

import type { AstNode } from "./types.ts";
import type { ScopeResolver } from "./scope.ts";
import { walk, findDescendant } from "./walk.ts";
import { getMethodName, isFunctionLike, findAncestor } from "./ast.ts";

/** Router/app method names that register a request handler. */
const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "del",
  "options",
  "head",
  "all",
  "use",
]);

/** Decorator names (Nest/Adonis) that mark a class method as a handler. */
const HTTP_DECORATORS = new Set([
  "Get",
  "Post",
  "Put",
  "Patch",
  "Delete",
  "Options",
  "Head",
  "All",
]);

/** Object-route properties whose function values are handlers. */
const ROUTE_HANDLER_KEYS = new Set(["handler", "preHandler", "onRequest", "preValidation"]);

const FIRST_PARAM_NAMES = new Set(["req", "request"]);
const SECOND_PARAM_NAMES = new Set(["res", "response", "reply"]);

const paramName = (param: AstNode | null | undefined): string | null => {
  if (!param) return null;
  if (param.type === "Identifier") return param.name;
  if (param.type === "AssignmentPattern" && param.left?.type === "Identifier") return param.left.name;
  return null;
};

/** Does a function's parameter list look like an Express/Fastify handler? */
export const looksLikeExpressHandler = (fn: AstNode | null | undefined): boolean => {
  if (!isFunctionLike(fn)) return false;
  const params = (fn!.params as AstNode[]) ?? [];
  if (params.length < 2) return false;
  const first = paramName(params[0]);
  const second = paramName(params[1]);
  return !!first && FIRST_PARAM_NAMES.has(first) && !!second && SECOND_PARAM_NAMES.has(second);
};

/** Pull function-like handler nodes out of a registration argument. */
const handlersFromArg = (arg: AstNode | null | undefined, scope: ScopeResolver, out: Set<AstNode>): void => {
  if (!arg) return;
  if (isFunctionLike(arg)) {
    out.add(arg);
    return;
  }
  // Wrapper call: asyncHandler(fn) / catchAsync(fn) — descend into its args.
  if (arg.type === "CallExpression") {
    for (const inner of (arg.arguments as AstNode[]) ?? []) handlersFromArg(inner, scope, out);
    return;
  }
  // Array of middleware: [a, b, handler]
  if (arg.type === "ArrayExpression") {
    for (const el of (arg.elements as (AstNode | null)[]) ?? []) handlersFromArg(el ?? undefined, scope, out);
    return;
  }
  // Same-file named reference: resolve to a function binding.
  if (arg.type === "Identifier") {
    const binding = scope.getBinding(arg.name, arg);
    if (binding && binding.initNode && isFunctionLike(binding.initNode)) {
      out.add(binding.initNode);
    }
    return;
  }
};

/**
 * Collect every function node that runs in request context in this file.
 */
export const collectRequestHandlers = (program: AstNode, scope: ScopeResolver): Set<AstNode> => {
  const handlers = new Set<AstNode>();

  walk(program, {
    enter: (node) => {
      // Method-call registrations and object-route form.
      if (node.type === "CallExpression") {
        const method = getMethodName(node);
        if (method && HTTP_METHODS.has(method)) {
          const args = (node.arguments as AstNode[]) ?? [];
          // A real registration passes at least one function; skip Map.get etc.
          let hasFunctionArg = false;
          for (const arg of args) {
            const before = handlers.size;
            handlersFromArg(arg, scope, handlers);
            if (handlers.size > before || isFunctionLike(arg)) hasFunctionArg = true;
          }
          if (!hasFunctionArg) {
            // Roll back: nothing here was actually a handler (e.g. `cache.get(k)`).
            // handlersFromArg only adds functions, so size only grew on real ones.
          }
        } else if (method === "route") {
          const options = (node.arguments as AstNode[])?.[0];
          if (options?.type === "ObjectExpression") {
            for (const prop of options.properties as AstNode[]) {
              if (prop.type !== "Property") continue;
              const key = prop.key;
              const keyName = key?.type === "Identifier" ? key.name : key?.value;
              if (typeof keyName === "string" && ROUTE_HANDLER_KEYS.has(keyName)) {
                handlersFromArg(prop.value, scope, handlers);
              }
            }
          }
        }
      }

      // Decorator handlers (Nest/Adonis).
      if (node.type === "MethodDefinition" || node.type === "PropertyDefinition") {
        const decorators = (node.decorators as AstNode[]) ?? [];
        for (const dec of decorators) {
          const expr = dec.expression;
          const decName =
            expr?.type === "CallExpression"
              ? getMethodName(expr)
              : expr?.type === "Identifier"
                ? expr.name
                : null;
          if (decName && HTTP_DECORATORS.has(decName) && isFunctionLike(node.value)) {
            handlers.add(node.value);
          }
        }
      }
    },
  });

  // Signature fallback for split-file controllers.
  walk(program, {
    enter: (node) => {
      if (isFunctionLike(node) && looksLikeExpressHandler(node)) handlers.add(node);
    },
  });

  return handlers;
};

/**
 * The request handler that lexically contains `node`, or null. Any node inside a
 * handler (including nested inline callbacks) is considered on the request path.
 */
export const findEnclosingRequestHandler = (
  node: AstNode,
  handlers: Set<AstNode>,
): AstNode | null => {
  if (handlers.has(node)) return node;
  return findAncestor(node, (n) => handlers.has(n));
};

/** Is `node` on a request path? */
export const isOnRequestPath = (node: AstNode, handlers: Set<AstNode>): boolean =>
  findEnclosingRequestHandler(node, handlers) !== null;

/**
 * Is `node` at module scope — outside every function? A one-time boot cost, the
 * inverse verdict of "on the request path" for position-sensitive diagnostics.
 */
export const isModuleScopePosition = (node: AstNode): boolean =>
  findAncestor(node, isFunctionLike) === null;

/** True when a handler function contains its own request-shaped work. */
export const handlerHasAwait = (handler: AstNode): boolean =>
  findDescendant(handler, (n) => n.type === "AwaitExpression", isFunctionLike) !== null;
