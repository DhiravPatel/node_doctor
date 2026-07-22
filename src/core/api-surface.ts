/**
 * The externally reachable API surface (§70, §78).
 *
 * Two questions that are painful to answer by hand and impossible to keep
 * current in a wiki: *what can the outside world call?* and *which of those are
 * unauthenticated?* This enumerates every route registration in the project with
 * its method, path, and the middleware chain guarding it, then classifies its
 * auth posture. The same structure diffed across two revisions answers a third:
 * *did this change break the API?*
 *
 * Extraction is deliberately syntactic and conservative. A template-literal path
 * (`app.get(`/users/${id}`, h)`) is recorded with path `<dynamic>`. A route whose
 * path is a bare variable or call (`app.get(buildPath(), h)`) is **not** recorded
 * at all: at the syntax level it is indistinguishable from `cache.get(key)` or
 * `map.delete(k)`, and inventing routes from every two-argument `.get()` would
 * flood the map. That is a deliberate miss, not an oversight — the surface
 * under-reports rather than lying.
 */

import type { AstNode } from "./types.ts";
import { getMethodName, rootObjectName, getStaticStringValue, isFunctionLike } from "./ast.ts";
import { walk } from "./walk.ts";

/** HTTP verbs that register a route (not `use`, which mounts middleware). */
const ROUTE_VERBS = new Set(["get", "post", "put", "patch", "delete", "del", "options", "head", "all"]);

/**
 * Middleware/guard names that indicate a route is authenticated. Deliberately
 * broad on the *positive* side: mislabelling a guarded route as unguarded is the
 * expensive error, so any plausible auth marker counts as protected.
 */
const AUTH_HINT =
  /(^|[._-])(auth|authenticate|authenticated|authorize|authorization|requireauth|requiresauth|isauthenticated|ensureauth|protect|protected|guard|jwt|passport|session|login|verifytoken|checktoken|bearer|apikey|permit|can|acl|rbac|role|admin)([._-]|$)/i;

export interface RouteEntry {
  /** Upper-case HTTP verb, or "ALL". */
  method: string;
  /** Route path as written, or "<dynamic>" when not statically known. */
  path: string;
  /** Names of the middleware/guards in the chain, in order. */
  middleware: string[];
  /** True when some middleware looks like an auth guard. */
  authenticated: boolean;
  normalizedFilePath: string;
  line: number;
  column: number;
}

/** A stable identity for a route, used to diff two surfaces. */
export const routeKey = (r: { method: string; path: string }): string => `${r.method} ${r.path}`;

/** The name of a middleware argument, for the guard chain. */
const middlewareName = (arg: AstNode): string | null => {
  if (isFunctionLike(arg)) return "<inline>";
  if (arg.type === "Identifier") return arg.name as string;
  // `requireAuth("admin")` / `passport.authenticate("jwt")`
  if (arg.type === "CallExpression") {
    const method = getMethodName(arg);
    const root = rootObjectName(arg.callee as AstNode);
    if (method && root && method !== root) return `${root}.${method}`;
    return method ?? root ?? null;
  }
  if (arg.type === "MemberExpression") {
    const root = rootObjectName(arg);
    const prop = arg.property?.type === "Identifier" ? (arg.property.name as string) : null;
    return root && prop ? `${root}.${prop}` : (root ?? null);
  }
  return null;
};

/** Extract every route registered in one parsed module. */
export const extractRoutes = (
  program: AstNode,
  normalizedFilePath: string,
  locate: (offset: number) => { line: number; column: number },
): RouteEntry[] => {
  const routes: RouteEntry[] = [];

  const push = (node: AstNode, method: string, path: string, middleware: string[]): void => {
    const { line, column } = locate(typeof node.start === "number" ? node.start : 0);
    routes.push({
      method: method.toUpperCase() === "DEL" ? "DELETE" : method.toUpperCase(),
      path,
      middleware,
      authenticated: middleware.some((m) => AUTH_HINT.test(m)),
      normalizedFilePath,
      line,
      column,
    });
  };

  walk(program, {
    enter: (node) => {
      if (node.type !== "CallExpression") return;
      const method = getMethodName(node);
      if (!method) return;
      const args = (node.arguments as AstNode[]) ?? [];

      // app.get("/path", mw, handler)
      if (ROUTE_VERBS.has(method)) {
        const first = args[0];
        if (!first) return;
        const literalPath = getStaticStringValue(first);
        // A route registration's first argument is its path; anything else
        // (`cache.get(key)`, `map.delete(k)`) is not a route.
        if (literalPath === null && first.type !== "TemplateLiteral") return;
        // Require at least one function-ish argument, else this is a lookup.
        const rest = args.slice(1);
        if (rest.length === 0) return;
        const middleware = rest.map(middlewareName).filter((n): n is string => n !== null);
        if (middleware.length === 0) return;
        push(node, method, literalPath ?? "<dynamic>", middleware);
        return;
      }

      // fastify.route({ method, url, preHandler, handler })
      if (method === "route") {
        const options = args[0];
        if (options?.type !== "ObjectExpression") return;
        let verb = "ALL";
        let path = "<dynamic>";
        const middleware: string[] = [];
        for (const prop of (options.properties as AstNode[]) ?? []) {
          if (prop.type !== "Property") continue;
          const key = prop.key?.type === "Identifier" ? (prop.key.name as string) : String(prop.key?.value ?? "");
          const value = prop.value as AstNode;
          if (key === "method") verb = getStaticStringValue(value) ?? "ALL";
          else if (key === "url" || key === "path") path = getStaticStringValue(value) ?? "<dynamic>";
          else if (key === "preHandler" || key === "onRequest" || key === "preValidation") {
            const items = value.type === "ArrayExpression" ? ((value.elements as AstNode[]) ?? []) : [value];
            for (const item of items) {
              const n = item && middlewareName(item);
              if (n) middleware.push(n);
            }
          } else if (key === "handler") {
            const n = middlewareName(value);
            if (n) middleware.push(n);
          }
        }
        if (middleware.length > 0) push(node, verb, path, middleware);
      }
    },
  });

  return routes;
};

/** Deterministic ordering for a surface: by path, then method, then location. */
export const sortRoutes = (routes: RouteEntry[]): RouteEntry[] =>
  routes.slice().sort((a, b) =>
    a.path < b.path
      ? -1
      : a.path > b.path
        ? 1
        : a.method < b.method
          ? -1
          : a.method > b.method
            ? 1
            : a.normalizedFilePath < b.normalizedFilePath
              ? -1
              : a.normalizedFilePath > b.normalizedFilePath
                ? 1
                : a.line - b.line,
  );

export interface ApiSurface {
  routes: RouteEntry[];
  /** Routes with no recognizable auth guard. */
  unauthenticated: RouteEntry[];
}

export const buildApiSurface = (routes: RouteEntry[]): ApiSurface => {
  const sorted = sortRoutes(routes);
  return { routes: sorted, unauthenticated: sorted.filter((r) => !r.authenticated) };
};

// ---------------------------------------------------------------------------
// §78 — API breaking-change detection
// ---------------------------------------------------------------------------

export type ApiChangeKind = "removed-route" | "auth-added" | "auth-removed";

export interface ApiChange {
  kind: ApiChangeKind;
  route: string;
  /** Breaking for consumers (a removed route, or a route that now demands auth). */
  breaking: boolean;
  detail: string;
}

/**
 * Diff two API surfaces. "Breaking" means breaking *for an existing consumer*:
 * a route that disappeared, or one that now requires authentication it did not
 * before. Newly added routes and newly *relaxed* auth are reported as
 * non-breaking so the summary is still complete.
 */
export const diffApiSurface = (baseline: RouteEntry[], current: RouteEntry[]): ApiChange[] => {
  const byKey = (rs: RouteEntry[]): Map<string, RouteEntry> => {
    const m = new Map<string, RouteEntry>();
    for (const r of sortRoutes(rs)) if (!m.has(routeKey(r))) m.set(routeKey(r), r);
    return m;
  };
  const before = byKey(baseline);
  const after = byKey(current);
  const changes: ApiChange[] = [];

  for (const [key, r] of before) {
    const now = after.get(key);
    if (!now) {
      changes.push({ kind: "removed-route", route: key, breaking: true, detail: "route no longer registered" });
      continue;
    }
    if (!r.authenticated && now.authenticated) {
      changes.push({
        kind: "auth-added",
        route: key,
        breaking: true,
        detail: `now requires auth (${now.middleware.filter((m) => AUTH_HINT.test(m)).join(", ")})`,
      });
    } else if (r.authenticated && !now.authenticated) {
      changes.push({
        kind: "auth-removed",
        route: key,
        breaking: false,
        detail: "auth guard removed — not breaking for consumers, but review it",
      });
    }
  }
  return changes.sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : a.kind < b.kind ? -1 : 1));
};
