/**
 * Observability Coverage Score (§151).
 *
 * Test coverage answers "if this route breaks, will a test catch it?". This
 * answers the sibling question nobody measures: "if this route breaks *in
 * production at 3am*, could you debug it from the logs alone?" — the
 * observability equivalent of coverage, computed per route.
 *
 * The model is deliberately concrete: for the *handler function registered for a
 * route* we ask four yes/no/not-applicable questions, each mapping to a real
 * pager-at-3am failure mode:
 *
 *   1. error-handling      — an async handler with awaited work and no error
 *                            path throws an unhandled rejection that never
 *                            reaches your logs; the request just hangs or 500s
 *                            with no trace.
 *   2. logs-on-failure     — a `catch` that swallows (or only sends a response)
 *                            is a failure that leaves *nothing* behind to read.
 *   3. timed-external-calls— an outbound call with no timeout hangs forever on a
 *                            stalled upstream, pinning a slot then the pool, with
 *                            no signal of *which* dependency is down.
 *   4. correlation-id      — logs with no request/correlation id can't be
 *                            stitched into the one failing request out of
 *                            thousands.
 *
 * Each check is "pass" | "fail" | "na". "na" means the check does not apply to
 * this handler (a sync handler has nothing async to fail) and is excluded from
 * the score — we never punish a route for a risk it cannot have. A route's score
 * is simply `passed / applicable * 100`; the codebase score is the mean across
 * routes.
 *
 * Scope and honesty. We only score handlers whose *body we can actually read* in
 * this file: an inline function, a same-file named function reached through a
 * binding, or one wrapped in an async-error wrapper. A handler that is an import
 * from another module is not scored rather than guessed at — the report
 * under-reports coverage rather than inventing it. Extraction mirrors
 * `extractRoutes` (verb registrations + the Fastify `route({...})` form), so the
 * two views of the route table agree.
 *
 * Determinism is a hard invariant: identical input yields byte-identical output.
 * Files are globbed and sorted, routes are collected in walk order, and the
 * final list is sorted by (score asc, path, line). Nothing here reads a clock or
 * a random source.
 */

import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";

import type { AstNode } from "./types.ts";
import type { NodeDoctorConfig } from "./config.ts";
import type { ScopeResolver } from "./scope.ts";
import {
  getMethodName,
  getCalleeName,
  getReceiverName,
  rootObjectName,
  isFunctionLike,
  getObjectProperty,
  getStaticStringValue,
  staticMemberPath,
  containsTryStatement,
} from "./ast.ts";
import { collectDescendants, findDescendant, attachParents } from "./walk.ts";
import { resolveScopes } from "./scope.ts";
import { looksLikeExpressHandler } from "./request-path.ts";
import { parseSource } from "./parse.ts";
import { createLocator } from "./location.ts";
import { BUILTIN_IGNORES } from "./config.ts";

const SOURCE_GLOB = "**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}";

/** HTTP verbs that register a route (mirrors api-surface.ts). */
const ROUTE_VERBS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "del",
  "options",
  "head",
  "all",
]);

/** The four checks, in a fixed display/serialization order. */
const CHECK_ORDER = [
  "error-handling",
  "logs-on-failure",
  "timed-external-calls",
  "correlation-id",
] as const;

type CheckName = (typeof CHECK_ORDER)[number];
type CheckResult = "pass" | "fail" | "na";

/**
 * A route registration wraps its handler in an async-error wrapper
 * (`asyncHandler(fn)`, `catchAsync(fn)`, `express-async-handler`, `ah(fn)`, …).
 * Such a wrapper routes a thrown/rejected error to the framework's error
 * middleware, which satisfies error-handling for the wrapped body.
 */
const ASYNC_ERROR_WRAPPER_RE = /asynchandler|catchasync|wrapasync|\bah\b|express-?async-?handler/i;

/** A logging method name (`logger.error`, `console.warn`, bare `debug(…)`). */
const LOG_METHOD_RE = /^(log|warn|error|info|debug|fatal)$/i;
/** A receiver that is (or contains) a logger (`logger`, `console`, `this.log`, …). */
const LOG_RECEIVER_RE = /log|logger|console|pino|winston|bunyan/i;

/** A correlation/request-id reference, tested against an identifier or dotted path. */
const CORRELATION_RE = /req(uest)?id|correlationid|traceid|spanid|req\.id/i;
/** A direct `req.id` / `request.id` read. */
const REQ_ID_RE = /^(req|request)\.id$/i;
/** A request-id / correlation-id header read (`req.headers['x-request-id']`). */
const HEADER_ID_RE = /\.headers\.x-(request|correlation)-id$/i;

export interface RouteObservability {
  method: string;
  path: string;
  normalizedFilePath: string;
  line: number;
  /** Per-check verdict. Keys are the four check names; values pass/fail/na. */
  checks: Record<string, CheckResult>;
  /** 0–100 = passed / applicable * 100, or 100 when no check applies. */
  score: number;
}

export interface ObservabilityReport {
  routes: RouteObservability[];
  /** Codebase 0–100 = mean of per-route scores; 100 when there are no routes. */
  score: number;
  summary: {
    routes: number;
    /** Per-check pass rate 0–100 (passes / (passes+fails) * 100; 100 if none). */
    checkPassRate: Record<string, number>;
  };
}

// ---------------------------------------------------------------------------
// Handler extraction — the route's registered function node.
// ---------------------------------------------------------------------------

interface RouteHandler {
  method: string;
  path: string;
  normalizedFilePath: string;
  line: number;
  /** The function node whose body runs for this route. */
  handler: AstNode;
  /** The callee name of an outer wrapper call (`asyncHandler`), or null. */
  wrapperCallee: string | null;
}

/**
 * Does `fn` have a request-handler signature? This is what separates a real route
 * handler from a `.get("key", loader)` look-alike — a cache get-or-load
 * (`cache.get("u", () => …)`) or a config default (`config.get("port", () => 3000)`)
 * whose callback is NOT `(req, res)`-shaped. An express/fastify handler is
 * `(req, res)` / `(request, reply)`; a koa-router handler is a single `ctx`. A
 * zero/one-arg loader named anything else is excluded, which is exactly what keeps a
 * cache/config `.get(key, fn)` out of the route table.
 */
const looksLikeRouteHandler = (fn: AstNode): boolean => {
  if (looksLikeExpressHandler(fn)) return true;
  const params = (fn.params as AstNode[]) ?? [];
  if (params.length < 1 || params.length > 2) return false;
  const first = params[0];
  const name =
    first?.type === "Identifier"
      ? (first.name as string)
      : first?.type === "AssignmentPattern" && first.left?.type === "Identifier"
        ? (first.left.name as string)
        : null;
  return name === "ctx" || name === "context";
};

/**
 * Resolve a registration argument to the concrete function node it registers,
 * following one level of wrapping/aliasing exactly as `collectRequestHandlers`
 * does:
 *   - a function literal *is* the handler;
 *   - a wrapper call `asyncHandler(fn)` — descend into its arguments, recording
 *     the wrapper's callee name so error-handling can credit it;
 *   - an array `[mw, handler]` — take its last function-ish element;
 *   - a same-file identifier — resolve through the scope binding's initializer.
 *
 * Returns the function node (or null when the target lives in another module and
 * therefore cannot be scored) plus the wrapper callee encountered, if any.
 */
const resolveHandlerFromArg = (
  arg: AstNode | null | undefined,
  scope: ScopeResolver,
): { node: AstNode | null; wrapperCallee: string | null } => {
  if (!arg) return { node: null, wrapperCallee: null };

  if (isFunctionLike(arg)) return { node: arg, wrapperCallee: null };

  if (arg.type === "CallExpression") {
    // A wrapper: descend into its arguments for the real handler, and remember
    // its callee name (`asyncHandler`) for the async-error-wrapper credit.
    const callee = getCalleeName(arg) ?? getMethodName(arg);
    for (const inner of (arg.arguments as AstNode[]) ?? []) {
      const resolved = resolveHandlerFromArg(inner, scope);
      if (resolved.node) return { node: resolved.node, wrapperCallee: resolved.wrapperCallee ?? callee };
    }
    return { node: null, wrapperCallee: callee };
  }

  if (arg.type === "ArrayExpression") {
    const els = (arg.elements as (AstNode | null)[]) ?? [];
    for (let k = els.length - 1; k >= 0; k--) {
      const resolved = resolveHandlerFromArg(els[k], scope);
      if (resolved.node) return resolved;
    }
    return { node: null, wrapperCallee: null };
  }

  if (arg.type === "Identifier") {
    const binding = scope.getBinding(arg.name as string, arg);
    if (binding && binding.initNode && isFunctionLike(binding.initNode)) {
      return { node: binding.initNode, wrapperCallee: null };
    }
    return { node: null, wrapperCallee: null };
  }

  return { node: null, wrapperCallee: null };
};

/**
 * Walk one parsed module and collect a `{ handler, method, path }` for every
 * route whose handler function we can resolve to a body in this file. Follows
 * `extractRoutes`' registration walk (verb calls + the Fastify object form) but
 * captures the *handler function node* rather than a middleware-name chain.
 */
const collectRouteHandlers = (
  program: AstNode,
  scope: ScopeResolver,
  normalizedFilePath: string,
  locate: (offset: number) => { line: number; column: number },
): RouteHandler[] => {
  const out: RouteHandler[] = [];

  const push = (
    node: AstNode,
    method: string,
    path: string,
    handler: AstNode,
    wrapperCallee: string | null,
  ): void => {
    const line = locate(typeof node.start === "number" ? node.start : 0).line;
    out.push({
      method: method.toUpperCase() === "DEL" ? "DELETE" : method.toUpperCase(),
      path,
      normalizedFilePath,
      line,
      handler,
      wrapperCallee,
    });
  };

  // A hand-rolled pre-order walk (the shared `walk` needs a visitor; a direct
  // descent over CallExpression is enough and keeps the traversal obvious).
  for (const node of collectDescendants(program, (n) => n.type === "CallExpression", undefined, true)) {
    const method = getMethodName(node);
    if (!method) continue;
    const args = (node.arguments as AstNode[]) ?? [];

    // app.get("/path", ...middleware, handler)
    if (ROUTE_VERBS.has(method)) {
      const first = args[0];
      if (!first) continue;
      const literalPath = getStaticStringValue(first);
      // A route's first argument is its path; a non-string, non-template first
      // arg means this is a lookup (`cache.get(key)`), not a registration.
      if (literalPath === null && first.type !== "TemplateLiteral") continue;
      const rest = args.slice(1);
      if (rest.length === 0) continue;
      // The handler is the *last* function-ish argument; earlier ones are
      // middleware. Scan from the end so an inline middleware never wins.
      let handlerNode: AstNode | null = null;
      let wrapperCallee: string | null = null;
      for (let k = rest.length - 1; k >= 0; k--) {
        const resolved = resolveHandlerFromArg(rest[k], scope);
        if (resolved.node) {
          handlerNode = resolved.node;
          wrapperCallee = resolved.wrapperCallee;
          break;
        }
      }
      // Require a request-handler signature so a `cache.get("k", loader)` /
      // `config.get("x", default)` look-alike is not scored as an HTTP route.
      if (!handlerNode || !looksLikeRouteHandler(handlerNode)) continue;
      push(node, method, literalPath ?? "<dynamic>", handlerNode, wrapperCallee);
      continue;
    }

    // fastify.route({ method, url, handler })
    if (method === "route") {
      const options = args[0];
      if (options?.type !== "ObjectExpression") continue;
      let verb = "ALL";
      let path = "<dynamic>";
      let handlerNode: AstNode | null = null;
      let wrapperCallee: string | null = null;
      for (const prop of (options.properties as AstNode[]) ?? []) {
        if (prop.type !== "Property") continue;
        const key =
          prop.key?.type === "Identifier"
            ? (prop.key.name as string)
            : String(prop.key?.value ?? "");
        const value = prop.value as AstNode;
        if (key === "method") verb = getStaticStringValue(value) ?? "ALL";
        else if (key === "url" || key === "path") path = getStaticStringValue(value) ?? "<dynamic>";
        else if (key === "handler") {
          const resolved = resolveHandlerFromArg(value, scope);
          handlerNode = resolved.node;
          wrapperCallee = resolved.wrapperCallee;
        }
      }
      if (handlerNode) push(node, verb, path, handlerNode, wrapperCallee);
    }
  }

  return out;
};

// ---------------------------------------------------------------------------
// Call-shape predicates shared across the four checks.
// ---------------------------------------------------------------------------

/** A call that emits to a logger — by method name or by receiver name. */
const isLogCall = (node: AstNode): boolean => {
  if (node.type !== "CallExpression") return false;
  const method = getMethodName(node);
  if (method && LOG_METHOD_RE.test(method)) return true;
  const receiver = getReceiverName(node) ?? rootObjectName(node.callee as AstNode);
  return !!receiver && LOG_RECEIVER_RE.test(receiver);
};

/** `next(err)` / `next(error)` — forwards the error to error-handling middleware. */
const isNextForward = (node: AstNode): boolean => {
  if (node.type !== "CallExpression") return false;
  const callee = node.callee as AstNode | undefined;
  if (!callee || callee.type !== "Identifier" || callee.name !== "next") return false;
  const first = ((node.arguments as AstNode[]) ?? [])[0];
  return !!first && first.type === "Identifier" && /err|error/i.test(first.name as string);
};

/** `captureException` / `captureError` — Sentry-style error capture. */
const isCaptureCall = (node: AstNode): boolean => {
  if (node.type !== "CallExpression") return false;
  const method = getMethodName(node);
  return !!method && /^capture(Exception|Error)$/i.test(method);
};

/** Is this call an outbound HTTP call, and of what shape? */
const outboundCallKind = (node: AstNode): "fetch" | "axios" | "got" | null => {
  if (node.type !== "CallExpression") return null;
  const callee = getCalleeName(node);
  const root = rootObjectName(node.callee as AstNode);
  if (callee === "fetch") return "fetch";
  if (callee === "axios" || root === "axios") return "axios";
  if (callee === "got" || root === "got") return "got";
  return null;
};

/** Does an object-literal options argument carry a `signal` or `timeout`? */
const optionsCarryTimeout = (arg: AstNode | null | undefined): boolean =>
  !!arg &&
  arg.type === "ObjectExpression" &&
  !!(getObjectProperty(arg, "signal") || getObjectProperty(arg, "timeout"));

/** Is an argument a direct `AbortSignal.timeout(...)` call? */
const isAbortTimeoutArg = (arg: AstNode | null | undefined): boolean =>
  !!arg && arg.type === "CallExpression" && getCalleeName(arg) === "AbortSignal.timeout";

/**
 * Does an outbound call pass a timeout/abort signal? Precise for `fetch` (reusing
 * the shape from `require-fetch-timeout`: options at arg 1); lenient for
 * axios/got, whose config-argument position is verb-dependent, so we only fail
 * them when an analyzable config object is present and lacks a timeout, staying
 * silent on opaque/absent config rather than guessing.
 */
const outboundCallHasTimeout = (node: AstNode, kind: "fetch" | "axios" | "got"): boolean => {
  const args = (node.arguments as AstNode[]) ?? [];
  // Any object literal carrying signal/timeout, or a direct AbortSignal.timeout.
  if (args.some((a) => optionsCarryTimeout(a) || isAbortTimeoutArg(a))) return true;

  if (kind === "fetch") {
    const opts = args[1];
    if (!opts) return false; // fetch(url) — no options, hangs forever.
    if (opts.type !== "ObjectExpression") return true; // opaque options — stay silent.
    return false; // object options that lack signal/timeout.
  }

  // axios/got: only fail on an analyzable config object without a timeout.
  const hasObjectConfig = args.some((a) => a?.type === "ObjectExpression");
  return !hasObjectConfig;
};

// ---------------------------------------------------------------------------
// Correlation-id detection.
// ---------------------------------------------------------------------------

/** Does any node in this subtree name a correlation/request id? */
const referencesCorrelationId = (root: AstNode): boolean => {
  const ids = collectDescendants(root, (n) => n.type === "Identifier", undefined, true);
  if (ids.some((id) => CORRELATION_RE.test(id.name as string))) return true;
  const members = collectDescendants(root, (n) => n.type === "MemberExpression", undefined, true);
  return members.some((m) => {
    const path = staticMemberPath(m);
    return !!path && (CORRELATION_RE.test(path) || REQ_ID_RE.test(path) || HEADER_ID_RE.test(path));
  });
};

/** Does the handler read `req.id` or a request/correlation-id header anywhere? */
const handlerReadsRequestId = (handler: AstNode): boolean => {
  const members = collectDescendants(handler, (n) => n.type === "MemberExpression", undefined, true);
  return members.some((m) => {
    const path = staticMemberPath(m);
    return !!path && (REQ_ID_RE.test(path) || HEADER_ID_RE.test(path));
  });
};

// ---------------------------------------------------------------------------
// The four per-handler checks.
// ---------------------------------------------------------------------------

const isAwaitExpr = (n: AstNode): boolean => n.type === "AwaitExpression";
const isForAwait = (n: AstNode): boolean => n.type === "ForOfStatement" && !!n.await;

/** A promise-shaped expression: `.then/.catch/.finally`, `Promise.*`, `new Promise`. */
const isPromiseish = (n: AstNode): boolean => {
  if (n.type === "NewExpression") return rootObjectName(n.callee as AstNode) === "Promise";
  if (n.type !== "CallExpression") return false;
  const method = getMethodName(n);
  if (method && (method === "then" || method === "catch" || method === "finally")) return true;
  return rootObjectName(n.callee as AstNode) === "Promise";
};

/**
 * Check 1 — error-handling. `na` when the handler's own body is not async (no
 * await, no promise) — there is nothing to reject. Otherwise `pass` when the body
 * has a try/catch, the registration wrapped it in an async-error wrapper, or every
 * awaited expression is itself a `.catch(...)`; `fail` for an async handler with
 * awaits and no error path.
 */
const checkErrorHandling = (handler: AstNode, wrapperCallee: string | null): CheckResult => {
  const awaitExprs = collectDescendants(handler, isAwaitExpr, isFunctionLike);
  const hasAwait = awaitExprs.length > 0 || collectDescendants(handler, isForAwait, isFunctionLike).length > 0;
  const hasPromise = findDescendant(handler, isPromiseish, isFunctionLike) !== null;
  if (!hasAwait && !hasPromise) return "na";

  const wrapped = !!wrapperCallee && ASYNC_ERROR_WRAPPER_RE.test(wrapperCallee);
  const everyAwaitCaught =
    awaitExprs.length > 0 &&
    awaitExprs.every((a) => {
      const arg = a.argument as AstNode | undefined;
      return !!arg && arg.type === "CallExpression" && getMethodName(arg) === "catch";
    });

  return containsTryStatement(handler) || wrapped || everyAwaitCaught ? "pass" : "fail";
};

/** The first-parameter name of a function-like node (Identifier / default), or null. */
const firstParamName = (fn: AstNode): string | null => {
  const p0 = ((fn.params as AstNode[]) ?? [])[0];
  if (!p0) return null;
  if (p0.type === "Identifier") return p0.name as string;
  if (p0.type === "AssignmentPattern" && p0.left?.type === "Identifier") return p0.left.name as string;
  return null;
};

/** The error-path bodies of a handler: `catch` blocks, `.catch()` callbacks, error-first callbacks. */
const collectErrorPaths = (handler: AstNode): AstNode[] => {
  const bodies: AstNode[] = [];
  // `catch` blocks in the handler's own body (not inside a nested function).
  for (const clause of collectDescendants(handler, (n) => n.type === "CatchClause", isFunctionLike)) {
    if (clause.body) bodies.push(clause.body as AstNode);
  }
  // A `.catch(cb)` promise handler — the callback IS the error path, whatever its
  // parameter is named. Without this, `x().catch(() => {})` / `.catch(e => {})`
  // (a silent swallow) is invisible, and the handler wrongly earns a perfect score
  // while the equivalent try/catch swallow is correctly flagged.
  for (const call of collectDescendants(handler, (n) => n.type === "CallExpression", isFunctionLike)) {
    if (getMethodName(call) !== "catch") continue;
    const cb = ((call.arguments as AstNode[]) ?? [])[0];
    if (cb && isFunctionLike(cb)) bodies.push((cb.body as AstNode) ?? cb);
  }
  // Error-first callbacks: any nested function whose first param is err/error.
  for (const fn of collectDescendants(handler, isFunctionLike)) {
    const name = firstParamName(fn);
    if (name && /^(err|error)$/i.test(name)) bodies.push((fn.body as AstNode) ?? fn);
  }
  return bodies;
};

/**
 * Check 2 — logs-on-failure. `na` when there is no error path at all (no catch,
 * no error-first callback). Otherwise `pass` when an error path emits something:
 * a log call, `next(err)`, or `captureException`; `fail` when an error path
 * exists but does none of these (it swallows, or only sends a response).
 */
const checkLogsOnFailure = (handler: AstNode): CheckResult => {
  const errorPaths = collectErrorPaths(handler);
  if (errorPaths.length === 0) return "na";
  const emits = errorPaths.some((body) =>
    collectDescendants(body, (n) => n.type === "CallExpression", undefined, true).some(
      (call) => isLogCall(call) || isNextForward(call) || isCaptureCall(call),
    ),
  );
  return emits ? "pass" : "fail";
};

/**
 * Check 3 — timed-external-calls. `na` when the handler makes no outbound HTTP
 * call. Otherwise `pass` when *every* outbound call passes a timeout/signal;
 * `fail` when any lacks one.
 */
const checkTimedExternalCalls = (handler: AstNode): CheckResult => {
  const outbound = collectDescendants(handler, (n) => n.type === "CallExpression", isFunctionLike)
    .map((node) => ({ node, kind: outboundCallKind(node) }))
    .filter((x): x is { node: AstNode; kind: "fetch" | "axios" | "got" } => x.kind !== null);
  if (outbound.length === 0) return "na";
  return outbound.every((x) => outboundCallHasTimeout(x.node, x.kind)) ? "pass" : "fail";
};

/**
 * Check 4 — correlation-id. `na` when the handler emits no logs at all (nothing
 * to correlate). Otherwise `pass` when a log call references a correlation/request
 * id, or the handler reads `req.id` / a request-id header; `fail` when it logs but
 * never with a correlation id.
 */
const checkCorrelationId = (handler: AstNode): CheckResult => {
  const logCalls = collectDescendants(handler, (n) => n.type === "CallExpression", undefined, true).filter(
    isLogCall,
  );
  if (logCalls.length === 0) return "na";
  const logHasCorrelation = logCalls.some((call) =>
    ((call.arguments as AstNode[]) ?? []).some((arg) => arg && referencesCorrelationId(arg)),
  );
  return logHasCorrelation || handlerReadsRequestId(handler) ? "pass" : "fail";
};

// ---------------------------------------------------------------------------
// Scoring.
// ---------------------------------------------------------------------------

/** Score one route: passed / applicable * 100, or 100 when nothing applies. */
const scoreRoute = (rh: RouteHandler): RouteObservability => {
  const checks: Record<CheckName, CheckResult> = {
    "error-handling": checkErrorHandling(rh.handler, rh.wrapperCallee),
    "logs-on-failure": checkLogsOnFailure(rh.handler),
    "timed-external-calls": checkTimedExternalCalls(rh.handler),
    "correlation-id": checkCorrelationId(rh.handler),
  };
  let pass = 0;
  let fail = 0;
  for (const name of CHECK_ORDER) {
    if (checks[name] === "pass") pass += 1;
    else if (checks[name] === "fail") fail += 1;
  }
  const score = pass + fail === 0 ? 100 : Math.round((100 * pass) / (pass + fail));
  return {
    method: rh.method,
    path: rh.path,
    normalizedFilePath: rh.normalizedFilePath,
    line: rh.line,
    checks: { ...checks },
    score,
  };
};

/** Deterministic ordering: worst score first, then path, then line. */
const sortRoutes = (routes: RouteObservability[]): RouteObservability[] =>
  routes.slice().sort((a, b) =>
    a.score !== b.score
      ? a.score - b.score
      : a.normalizedFilePath < b.normalizedFilePath
        ? -1
        : a.normalizedFilePath > b.normalizedFilePath
          ? 1
          : a.line - b.line,
  );

/**
 * Build the observability report for a directory tree: glob source files, parse
 * each, extract its route handlers, score them, and aggregate.
 */
export const buildObservabilityReport = async (
  rootDirectory: string,
  options?: { config?: NodeDoctorConfig },
): Promise<ObservabilityReport> => {
  const config = options?.config ?? {};
  const fg = (await import("fast-glob")).default;
  const files = (
    await fg([SOURCE_GLOB], {
      cwd: rootDirectory,
      ignore: [...BUILTIN_IGNORES, ...(config.ignore ?? [])],
      absolute: true,
      suppressErrors: true,
    })
  ).sort();

  const scored: RouteObservability[] = [];
  for (const file of files) {
    let src: string;
    try {
      src = await readFile(file, "utf8");
    } catch {
      continue;
    }
    // Cheap pre-filter: no route verb in the text, no need to parse (mirrors runSurface).
    if (!/\.(get|post|put|patch|delete|del|options|head|all|route)\s*\(/.test(src)) continue;
    const parsed = parseSource(file, src);
    if (parsed.parseFailed) continue;
    attachParents(parsed.program);
    const scope = resolveScopes(parsed.program);
    const normalizedFilePath = relative(rootDirectory, file).split(sep).join("/");
    const handlers = collectRouteHandlers(parsed.program, scope, normalizedFilePath, createLocator(src));
    for (const rh of handlers) scored.push(scoreRoute(rh));
  }

  const routes = sortRoutes(scored);

  // Codebase score = mean of per-route scores (100 when there are no routes).
  const codebaseScore =
    routes.length === 0
      ? 100
      : Math.round(routes.reduce((sum, r) => sum + r.score, 0) / routes.length);

  // Per-check pass rate across all routes.
  const checkPassRate: Record<string, number> = {};
  for (const name of CHECK_ORDER) {
    let pass = 0;
    let fail = 0;
    for (const r of routes) {
      if (r.checks[name] === "pass") pass += 1;
      else if (r.checks[name] === "fail") fail += 1;
    }
    checkPassRate[name] = pass + fail === 0 ? 100 : Math.round((100 * pass) / (pass + fail));
  }

  return {
    routes,
    score: codebaseScore,
    summary: { routes: routes.length, checkPassRate },
  };
};
