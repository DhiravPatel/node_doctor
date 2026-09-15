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
 *
 * FOUR REGISTRATION SHAPES are understood, because a route table that silently
 * reports zero routes is worse than no route table at all:
 *
 *   - the verb form — `app.get("/p", mw, handler)` — which Express, Fastify,
 *     Hono, Koa (`@koa/router`) and AdonisJS all share;
 *   - Fastify's `route({ method, url, preHandler, handler })` object;
 *   - AdonisJS's controller tuple, group prefixes and `resource()` expansion;
 *   - NestJS's decorators, which are not calls at all.
 *
 * The AdonisJS rules are MEASURED against the real router (`@adonisjs/core`
 * 6.21.0), by registering routes into it and reading back what it committed —
 * not from documentation. `router.resource("/users", C)` expands to exactly
 * seven routes, `.apiOnly()` drops `create` and `edit` to leave five, and nested
 * `group().prefix()` calls compose outermost-first:
 *
 *   resource("/users", C)          GET /users · GET /users/create · POST /users
 *                                  GET /users/:id · GET /users/:id/edit
 *                                  PUT /users/:id · DELETE /users/:id
 *   …then .apiOnly()               the same minus /users/create and /users/:id/edit
 *   group(group(get("/x"))) with
 *     .prefix("/v2") / .prefix("/api")   →  GET /api/v2/x
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

/**
 * Markers strong enough to read inside a camelCase name with no separators.
 *
 * NestJS writes its guards as `JwtAuthGuard`, which the segment-aware `AUTH_HINT`
 * cannot see, so a route guarded by `@UseGuards(JwtAuthGuard)` was reported as
 * UNAUTHENTICATED — the expensive direction. The obvious repair, splitting
 * camelCase before applying `AUTH_HINT`, was WRONG and a test caught it:
 * `AUTH_HINT` also contains `admin`, `role`, `can`, `login` and `session`, all of
 * which sit inside ordinary handler names, so `adminPage` and `canDelete` started
 * reading as guards and a removed guard stopped being reported.
 *
 * These five are the ones that essentially never appear in a non-auth middleware
 * name, so they can be matched without word boundaries.
 */
const STRONG_AUTH_MARKER = /(auth|guard|jwt|passport|bearer)/i;

/** Does this middleware name look like an auth guard? */
const looksLikeAuth = (name: string): boolean => AUTH_HINT.test(name) || STRONG_AUTH_MARKER.test(name);

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
  // AdonisJS's controller tuple: `[UsersController, "show"]`. Without this the
  // route is dropped entirely, which is how the surface came to report ZERO
  // routes for an Adonis app.
  if (arg.type === "ArrayExpression") {
    const items = (arg.elements as (AstNode | null)[]) ?? [];
    const controller = items[0];
    const action = items[1];
    const name =
      controller?.type === "Identifier"
        ? (controller.name as string)
        : controller
          ? getStaticStringValue(controller)
          : null;
    const method = action ? getStaticStringValue(action) : null;
    if (name && method) return `${name}.${method}`;
    return name;
  }
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


/**
 * AdonisJS's `resource()` expansion, MEASURED by registering one into the real
 * `@adonisjs/core` 6.21.0 router and reading back what it committed. `apiOnly()`
 * drops the two rows marked `browser`, which are the HTML form endpoints.
 */
const ADONIS_RESOURCE_ROUTES: { method: string; suffix: string; action: string; browser: boolean }[] = [
  { method: "GET", suffix: "", action: "index", browser: false },
  { method: "GET", suffix: "/create", action: "create", browser: true },
  { method: "POST", suffix: "", action: "store", browser: false },
  { method: "GET", suffix: "/:id", action: "show", browser: false },
  { method: "GET", suffix: "/:id/edit", action: "edit", browser: true },
  { method: "PUT", suffix: "/:id", action: "update", browser: false },
  { method: "DELETE", suffix: "/:id", action: "destroy", browser: false },
];

/** Chained calls that attach a guard to a route or a group. */
const GUARD_CHAIN_METHODS = new Set(["use", "middleware"]);

/** Join path segments the way a router does: one slash, no trailing one. */
const joinPath = (...parts: string[]): string => {
  const joined = parts
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && p !== "/")
    .map((p) => (p.startsWith("/") ? p : `/${p}`))
    .join("")
    .replace(/\/{2,}/g, "/");
  return joined.length > 0 ? joined.replace(/\/$/, "") || "/" : "/";
};

/** The names a chained `.use(…)` / `.middleware(…)` attaches, in order. */
const chainedGuards = (call: AstNode): string[] => {
  const names: string[] = [];
  let current: AstNode | undefined = call;
  // `router.group(cb).prefix("/api").use([middleware.auth()])`
  while (current) {
    const parent = current.parent as AstNode | undefined;
    if (parent?.type !== "MemberExpression" || parent.object !== current || parent.computed) break;
    const property = parent.property as AstNode | undefined;
    const outer = parent.parent as AstNode | undefined;
    if (outer?.type !== "CallExpression" || outer.callee !== parent) break;
    if (property?.type === "Identifier" && GUARD_CHAIN_METHODS.has(String(property.name))) {
      for (const argument of ((outer.arguments as AstNode[] | undefined) ?? [])) {
        const items =
          argument.type === "ArrayExpression" ? (((argument.elements as (AstNode | null)[]) ?? []).filter(Boolean) as AstNode[]) : [argument];
        for (const item of items) {
          const name = middlewareName(item);
          if (name) names.push(name);
        }
      }
    }
    current = outer;
  }
  return names;
};

/** The literal a chained `.prefix("…")` carries, or null. */
const chainedPrefix = (call: AstNode): string | null => {
  let current: AstNode | undefined = call;
  while (current) {
    const parent = current.parent as AstNode | undefined;
    if (parent?.type !== "MemberExpression" || parent.object !== current || parent.computed) return null;
    const property = parent.property as AstNode | undefined;
    const outer = parent.parent as AstNode | undefined;
    if (outer?.type !== "CallExpression" || outer.callee !== parent) return null;
    if (property?.type === "Identifier" && String(property.name) === "prefix") {
      return getStaticStringValue(((outer.arguments as AstNode[] | undefined) ?? [])[0]);
    }
    current = outer;
  }
  return null;
};

interface GroupScope {
  start: number;
  end: number;
  prefix: string;
  guards: string[];
}

/**
 * Every `router.group(() => …)` in the module, with the prefix and guards its
 * chain attaches. Measured: nested groups compose outermost-first, so the scopes
 * containing a route are applied in order of increasing `start`.
 */
const collectGroupScopes = (program: AstNode): GroupScope[] => {
  const scopes: GroupScope[] = [];
  walk(program, {
    enter: (node) => {
      if (node.type !== "CallExpression" || getMethodName(node) !== "group") return;
      const callback = ((node.arguments as AstNode[] | undefined) ?? [])[0];
      if (!isFunctionLike(callback)) return;
      const start = typeof callback.start === "number" ? callback.start : 0;
      const end = typeof callback.end === "number" ? callback.end : 0;
      scopes.push({ start, end, prefix: chainedPrefix(node) ?? "", guards: chainedGuards(node) });
    },
  });
  return scopes.sort((a, b) => a.start - b.start);
};

/** The prefix and guards every group enclosing this offset contributes. */
const enclosingGroups = (scopes: GroupScope[], offset: number): { prefix: string; guards: string[] } => {
  const prefixes: string[] = [];
  const guards: string[] = [];
  for (const scope of scopes) {
    if (offset < scope.start || offset > scope.end) continue;
    if (scope.prefix) prefixes.push(scope.prefix);
    guards.push(...scope.guards);
  }
  return { prefix: prefixes.length > 0 ? joinPath(...prefixes) : "", guards };
};

/** HTTP-method decorators NestJS puts on a controller method. */
const NEST_METHOD_DECORATORS = new Map([
  ["Get", "GET"],
  ["Post", "POST"],
  ["Put", "PUT"],
  ["Patch", "PATCH"],
  ["Delete", "DELETE"],
  ["Options", "OPTIONS"],
  ["Head", "HEAD"],
  ["All", "ALL"],
]);

/** A decorator's callee name, for `@Foo(…)` and bare `@Foo`. */
const decoratorName = (decorator: AstNode): string | null => {
  const expression = decorator.expression as AstNode | undefined;
  if (expression?.type === "Identifier") return String(expression.name);
  if (expression?.type === "CallExpression") {
    const callee = expression.callee as AstNode | undefined;
    if (callee?.type === "Identifier") return String(callee.name);
  }
  return null;
};

/** A decorator's arguments, or an empty list for the bare form. */
const decoratorArguments = (decorator: AstNode): AstNode[] => {
  const expression = decorator.expression as AstNode | undefined;
  return expression?.type === "CallExpression" ? (((expression.arguments as AstNode[]) ?? [])) : [];
};

/** The guard names a `@UseGuards(…)` on this node attaches. */
const nestGuards = (node: AstNode): string[] => {
  const names: string[] = [];
  for (const decorator of ((node.decorators as AstNode[] | undefined) ?? [])) {
    const name = decoratorName(decorator);
    if (name !== "UseGuards" && name !== "Auth" && name !== "Roles") continue;
    if (name !== "UseGuards") {
      names.push(name);
      continue;
    }
    for (const argument of decoratorArguments(decorator)) {
      const guard = middlewareName(argument);
      if (guard) names.push(guard);
    }
  }
  return names;
};

/** Extract every route registered in one parsed module. */
export const extractRoutes = (
  program: AstNode,
  normalizedFilePath: string,
  locate: (offset: number) => { line: number; column: number },
): RouteEntry[] => {
  const routes: RouteEntry[] = [];
  const groupScopes = collectGroupScopes(program);

  const push = (node: AstNode, method: string, path: string, middleware: string[]): void => {
    const { line, column } = locate(typeof node.start === "number" ? node.start : 0);
    routes.push({
      method: method.toUpperCase() === "DEL" ? "DELETE" : method.toUpperCase(),
      path,
      middleware,
      authenticated: middleware.some(looksLikeAuth),
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
        // A route inside `router.group(…)` carries that group's prefix and
        // guards — measured against the real Adonis router, nested groups
        // compose outermost-first.
        const offset = typeof node.start === "number" ? node.start : 0;
        const group = enclosingGroups(groupScopes, offset);
        const path = literalPath === null ? "<dynamic>" : joinPath(group.prefix, literalPath);
        push(node, method, path, [...group.guards, ...middleware, ...chainedGuards(node)]);
        return;
      }

      // AdonisJS `router.resource("/users", Controller)` — seven routes, or five
      // after `.apiOnly()`. Both numbers were read back out of the real router.
      if (method === "resource") {
        const first = args[0];
        const controller = args[1];
        const base = first ? getStaticStringValue(first) : null;
        if (base === null || !controller) return;
        const controllerName = middlewareName(controller);
        if (controllerName === null) return;

        let apiOnly = false;
        let current: AstNode | undefined = node;
        while (current) {
          const parent = current.parent as AstNode | undefined;
          if (parent?.type !== "MemberExpression" || parent.object !== current || parent.computed) break;
          const property = parent.property as AstNode | undefined;
          const outer = parent.parent as AstNode | undefined;
          if (outer?.type !== "CallExpression" || outer.callee !== parent) break;
          if (property?.type === "Identifier" && String(property.name) === "apiOnly") apiOnly = true;
          current = outer;
        }

        const offset = typeof node.start === "number" ? node.start : 0;
        const group = enclosingGroups(groupScopes, offset);
        const guards = [...group.guards, ...chainedGuards(node)];
        // A resource path is written either as a path or as a dotted resource
        // name; both are turned into the same slash form the router commits.
        const basePath = base.replace(/\./g, "/");
        for (const row of ADONIS_RESOURCE_ROUTES) {
          if (apiOnly && row.browser) continue;
          push(node, row.method, joinPath(group.prefix, basePath, row.suffix), [
            ...guards,
            `${controllerName}.${row.action}`,
          ]);
        }
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
          } else if (key === "auth") {
            // hapi declares auth on the route itself: `auth: "jwt"`, or
            // `auth: { strategy: "session" }`. Without this the route reads as
            // UNAUTHENTICATED, which is the expensive direction.
            const strategy =
              getStaticStringValue(value) ??
              (value.type === "ObjectExpression"
                ? (getStaticStringValue(
                    ((value.properties as AstNode[]) ?? [])
                      .filter((pr) => pr.type === "Property")
                      .find((pr) => {
                        const k = pr.key as AstNode | undefined;
                        return k?.type === "Identifier" && (String(k.name) === "strategy" || String(k.name) === "strategies");
                      })?.value as AstNode,
                  ) ?? "auth")
                : null);
            if (strategy !== null) middleware.push(`auth:${strategy}`);
          } else if (key === "options" || key === "config") {
            // hapi nests the same declaration one level down.
            if (value.type !== "ObjectExpression") continue;
            for (const inner of ((value.properties as AstNode[]) ?? [])) {
              if (inner.type !== "Property") continue;
              const innerKey = inner.key as AstNode | undefined;
              if (innerKey?.type !== "Identifier" || String(innerKey.name) !== "auth") continue;
              const innerValue = inner.value as AstNode;
              const strategy =
                getStaticStringValue(innerValue) ??
                (innerValue.type === "ObjectExpression" ? "auth" : null);
              if (strategy !== null) middleware.push(`auth:${strategy}`);
            }
          }
        }
        if (middleware.length > 0) push(node, verb, path, middleware);
      }
    },
  });

  // NestJS registers routes with DECORATORS rather than calls, so nothing in the
  // walk above can see them — which is why the surface reported zero routes for
  // a Nest app. The controller's own `@Controller(prefix)` supplies the base.
  walk(program, {
    enter: (node) => {
      if (node.type !== "ClassDeclaration" && node.type !== "ClassExpression") return;
      const controller = ((node.decorators as AstNode[] | undefined) ?? []).find(
        (d) => decoratorName(d) === "Controller",
      );
      if (!controller) return;
      const prefix = getStaticStringValue(decoratorArguments(controller)[0]) ?? "";
      const classGuards = nestGuards(node);

      const body = (node.body as AstNode | undefined)?.body as AstNode[] | undefined;
      for (const member of body ?? []) {
        if (member.type !== "MethodDefinition" || !isFunctionLike(member.value)) continue;
        const key = member.key as AstNode | undefined;
        const handler = key?.type === "Identifier" ? String(key.name) : (getStaticStringValue(key) ?? "<handler>");
        for (const decorator of ((member.decorators as AstNode[] | undefined) ?? [])) {
          const verb = NEST_METHOD_DECORATORS.get(decoratorName(decorator) ?? "");
          if (verb === undefined) continue;
          const suffix = getStaticStringValue(decoratorArguments(decorator)[0]) ?? "";
          push(member, verb, joinPath(prefix, suffix), [...classGuards, ...nestGuards(member), handler]);
        }
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
        detail: `now requires auth (${now.middleware.filter(looksLikeAuth).join(", ")})`,
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
