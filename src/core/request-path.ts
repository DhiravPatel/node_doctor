/**
 * Request-handler detection — the load-bearing primitive.
 *
 * We identify the functions that run in request context by recognizing:
 *   - method-call registrations: `app.get("/x", handler)`, `router.use(mw)`;
 *   - object-route form: `fastify.route({ handler, preHandler })`;
 *   - decorator handlers: a class method carrying `@Get()`, `@Post()`, …;
 *   - **exported** handlers, which register by file convention rather than by a
 *     call: Next.js App Router / SvelteKit `export async function GET(request)`,
 *     and Remix `export async function loader({ request })`;
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
  // GraphQL, decorator form (Nest, TypeGraphQL). A resolver runs per request
  // exactly as an HTTP handler does, and `@ResolveField` runs per PARENT ROW —
  // which is what makes an N+1 there worse than in a REST handler, not better.
  "Query",
  "Mutation",
  "Subscription",
  "ResolveField",
  "ResolveProperty",
  "FieldResolver",
]);

/**
 * The root keys of a GraphQL resolver map — `{ Query: { user() {} } }`.
 *
 * Without this the engine is close to SILENT on a GraphQL backend: there is no
 * registration call to find, so `no-query-in-loop`, `no-sync-io-in-request-path`
 * and every other request-path rule never sees a resolver at all. Recognizing
 * the map costs one extension point and covers all of them at once.
 *
 * Only the three root operation types are matched, and only when the value is an
 * object of functions. A type-level resolver map (`{ User: { posts() {} } }`)
 * needs the schema to identify, and guessing that any capitalized key is a
 * GraphQL type would sweep in every ordinary namespace object in the file.
 */
const GRAPHQL_ROOT_TYPES = new Set(["Query", "Mutation", "Subscription"]);

/** Object-route properties whose function values are handlers. */
const ROUTE_HANDLER_KEYS = new Set(["handler", "preHandler", "onRequest", "preValidation"]);

/**
 * Frameworks that register by *convention* export a function whose name is the
 * HTTP method — Next.js App Router (an `app/` route.ts) and SvelteKit
 * (`+server.ts`) both do this. There is no registration call to find, so without
 * this the whole request-path analysis silently does nothing on those stacks:
 * we would detect Next.js and then miss the `readFileSync` in every route.
 *
 * Matching on an exported uppercase HTTP-method name is deliberately narrow —
 * JavaScript reserves that casing for constructors and components, so a function
 * actually named `GET` is a route handler essentially every time.
 */
const EXPORTED_METHOD_HANDLERS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

/**
 * Remix / React Router data functions. `loader` and `action` are ordinary words
 * — a Redux action creator is also called `action` — so the name alone is not
 * enough. The signature is: Remix passes a single `DataFunctionArgs` object, so
 * we additionally require the first parameter to destructure `request`,
 * `params` or `context`. That shape is specific to the convention.
 */
const DATA_FUNCTION_NAMES = new Set(["loader", "action", "clientLoader", "clientAction"]);
const DATA_FUNCTION_ARG_KEYS = new Set(["request", "params", "context"]);

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
/** Does this function take a single `{ request }`-shaped argument? */
const takesDataFunctionArgs = (fn: AstNode): boolean => {
  const first = ((fn.params as AstNode[]) ?? [])[0];
  if (!first) return false;
  if (first.type !== "ObjectPattern") return false;
  for (const prop of (first.properties as AstNode[]) ?? []) {
    const key = prop?.key as AstNode | undefined;
    const name = key?.type === "Identifier" ? (key.name as string) : undefined;
    if (name && DATA_FUNCTION_ARG_KEYS.has(name)) return true;
  }
  return false;
};

/**
 * Handlers a framework picks up from the module's exports rather than from a
 * registration call.
 */
const collectExportedHandlers = (program: AstNode, handlers: Set<AstNode>): void => {
  const consider = (name: string | undefined, fn: AstNode | null | undefined): void => {
    if (!name || !fn || !isFunctionLike(fn)) return;
    if (EXPORTED_METHOD_HANDLERS.has(name)) {
      handlers.add(fn);
      return;
    }
    if (DATA_FUNCTION_NAMES.has(name) && takesDataFunctionArgs(fn)) handlers.add(fn);
  };

  for (const stmt of (program.body as AstNode[]) ?? []) {
    if (stmt.type !== "ExportNamedDeclaration" || !stmt.declaration) continue;
    const decl = stmt.declaration as AstNode;
    if (decl.type === "FunctionDeclaration" && decl.id?.type === "Identifier") {
      consider(decl.id.name as string, decl);
      continue;
    }
    if (decl.type !== "VariableDeclaration") continue;
    for (const d of (decl.declarations as AstNode[]) ?? []) {
      if (d.id?.type === "Identifier") consider(d.id.name as string, d.init as AstNode | null);
    }
  }
};

export const collectRequestHandlers = (program: AstNode, scope: ScopeResolver): Set<AstNode> => {
  const handlers = new Set<AstNode>();

  collectExportedHandlers(program, handlers);

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

      // GraphQL resolver map: `{ Query: { user() {…} }, Mutation: { … } }`.
      // The property value must be an object literal whose own values are
      // functions — that shape is a resolver map and very little else.
      if (node.type === "ObjectExpression") {
        for (const prop of (node.properties as AstNode[] | undefined) ?? []) {
          if (prop.type !== "Property" || prop.computed) continue;
          const key = prop.key as AstNode | undefined;
          const keyName = key?.type === "Identifier" ? (key.name as string) : (key?.value as string | undefined);
          if (typeof keyName !== "string" || !GRAPHQL_ROOT_TYPES.has(keyName)) continue;
          const value = prop.value as AstNode | undefined;
          if (value?.type !== "ObjectExpression") continue;
          for (const field of (value.properties as AstNode[] | undefined) ?? []) {
            if (field.type !== "Property") continue;
            handlersFromArg(field.value as AstNode, scope, handlers);
          }
        }
      }

      // Decorator handlers (Nest/Adonis), and GraphQL decorators.
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
