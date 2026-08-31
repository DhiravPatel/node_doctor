import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getStaticStringValue, unwrapChain } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";

/**
 * Hono middleware mounted on a bare path. It guards that path and nothing
 * beneath it, so every child route is unprotected.
 *
 *   ❌ app.use("/admin", requireAdmin);
 *      app.get("/admin/users", listUsers);      // NOT guarded
 *   ✅ app.use("/admin/*", requireAdmin);
 *      app.get("/admin/users", listUsers);      // guarded
 *
 * Express's `app.use(path, …)` is a PREFIX mount: it covers everything below the
 * path. Hono's `use()` takes an ordinary route pattern, so `"/admin"` matches the
 * single path `/admin`. The two read identically and behave differently, which is
 * the entire defect — it is an Express habit that compiles.
 *
 * MEASURED, the same middleware and routes on both frameworks, requesting without
 * the required header so a guarded route must answer 401:
 *
 *   Hono 4.13.5    use("/admin")    GET /admin              → 401 guarded
 *                                   GET /admin/users        → **200 UNGUARDED**
 *                                   GET /admin/users/1/keys → **200 UNGUARDED**
 *                  use("/admin/*")  all three               → 401 guarded
 *   Express 5.2.1  use("/admin")    GET /admin/users        → 401 guarded
 *                                   GET /admin/users/1/keys → 401 guarded
 *
 * A mounted sub-app does not change it: `app.use("/admin", auth)` followed by
 * `app.route("/admin", adminRoutes)` leaves `/admin/users` answering **200**,
 * while `app.use("/admin/*", auth)` guards it.
 *
 * Nothing errors, no route 404s, and the guarded parent path behaves exactly as
 * intended — so a smoke test of `/admin` passes and every page under it is open.
 * When the middleware is an auth check, this is an authorization bypass whose
 * only symptom is that the wrong people can read things.
 *
 * PRECISION MODEL. The rule reports only when it can prove there IS something
 * underneath, so a genuinely single-path middleware is never touched:
 *
 *   - The call is `<app>.use("<literal path>", …)` where the path contains no
 *     wildcard. `app.use(mw)` with no path at all applies globally and is
 *     correct; so are `"*"`, `"/admin/*"` and any pattern already ending in a
 *     wildcard.
 *   - The receiver is provably a Hono app — its binding initializes to a
 *     `new Hono(…)` (or `new OpenAPIHono(…)`) construction — and the file
 *     imports from `hono`/`@hono/*`. The `hono` capability is project-wide, so
 *     without this an Express `app.use("/admin", …)` sitting in the same repo
 *     would be reported, and Express is the framework where that spelling is
 *     RIGHT.
 *   - The same file registers at least one route strictly beneath the path —
 *     `app.get("/admin/users", …)` or `app.route("/admin", subApp)`. That
 *     registration is the proof that the middleware misses something; without it
 *     the mount may legitimately cover the only path there is.
 *
 * The last condition is also the rule's recall limit, stated rather than hidden:
 * a project that registers its child routes in another file gets no finding. That
 * under-reports, which is the direction this project accepts.
 *
 * Gated on the `hono` capability.
 */

/** Route-registration methods whose first argument is a path. */
const ROUTE_METHODS = new Set([
  "get", "post", "put", "patch", "delete", "options", "head", "all", "on", "route",
]);

/** Does this path already cover everything beneath it? */
const coversChildren = (path: string): boolean => path === "*" || path.includes("*");

/** The dotted receiver of a member call, as an Identifier node. */
const receiverIdentifier = (node: AstNode): AstNode | null => {
  const callee = unwrapChain(node.callee as AstNode);
  if (!callee || callee.type !== "MemberExpression" || callee.computed) return null;
  const object = unwrapChain(callee.object as AstNode);
  return object?.type === "Identifier" ? object : null;
};

/** The method name of a member call. */
const methodName = (node: AstNode): string | null => {
  const callee = unwrapChain(node.callee as AstNode);
  if (!callee || callee.type !== "MemberExpression" || callee.computed) return null;
  const property = callee.property as AstNode | undefined;
  return property?.type === "Identifier" ? String(property.name) : null;
};

/** Does this file import from `hono` / `@hono/*`? */
const importsHono = (program: AstNode): boolean =>
  ((program.body as AstNode[] | undefined) ?? []).some((statement) => {
    if (statement.type !== "ImportDeclaration") return false;
    const source = (statement.source as AstNode | undefined)?.value;
    return typeof source === "string" && /^hono(\/|$)|^@hono\//.test(source);
  });

export const noHonoExactPathMiddleware = defineDiagnostic({
  id: "no-hono-exact-path-middleware",
  title: "Hono middleware mounted on a bare path, leaving every route beneath it unguarded",
  severity: "error",
  category: "Security",
  confidence: "high",
  requires: ["hono"],
  tags: ["hono", "auth", "http"],
  recommendation:
    'Add the wildcard: `app.use("/admin/*", requireAdmin)`. Express\'s `app.use(path, …)` is a prefix mount that covers everything below it, but Hono\'s `use()` takes an ordinary route pattern, so `"/admin"` matches only the single path `/admin` — measured on Hono 4.13.5, `/admin/users` answers 200 unguarded while `/admin` answers 401. Mounting a sub-app with `app.route("/admin", …)` does not change it.',
  create: (ctx) => {
    let honoImported = false;
    /** Bindings initialized to a `new Hono()` construction. */
    const honoApps = new Set<string>();
    /** Every path registered on a route method in this file. */
    const registeredPaths: string[] = [];

    return {
      Program: (root) => {
        honoImported = importsHono(root);
        if (!honoImported) return;

        for (const declarator of collectDescendants(root, (n) => n.type === "VariableDeclarator")) {
          const id = declarator.id as AstNode | undefined;
          const init = unwrapChain(declarator.init as AstNode);
          if (id?.type !== "Identifier" || init?.type !== "NewExpression") continue;
          const callee = init.callee as AstNode | undefined;
          if (callee?.type !== "Identifier" || !/Hono$/.test(String(callee.name))) continue;
          honoApps.add(String(id.name));
        }

        for (const call of collectDescendants(root, (n) => n.type === "CallExpression")) {
          const method = methodName(call);
          if (method === null || !ROUTE_METHODS.has(method)) continue;
          const path = getStaticStringValue(((call.arguments as AstNode[] | undefined) ?? [])[0]);
          if (path !== null) registeredPaths.push(path);
        }
      },

      CallExpression: (node) => {
        if (!honoImported) return;
        if (methodName(node) !== "use") return;

        const receiver = receiverIdentifier(node);
        if (!receiver || !honoApps.has(String(receiver.name))) return;

        const args = (node.arguments as AstNode[] | undefined) ?? [];
        // `app.use(mw)` with no path applies globally and is correct.
        if (args.length < 2) return;
        const path = getStaticStringValue(args[0]);
        if (path === null || coversChildren(path)) return;

        // Only report when this file proves there IS something underneath.
        const prefix = path.endsWith("/") ? path : `${path}/`;
        const shadowed = registeredPaths.filter((registered) => registered.startsWith(prefix));
        // `app.route("/admin", sub)` registers the same path, and its children
        // live in the sub-app — measured as equally unguarded.
        const mountsSubApp = collectDescendants(ctx.program, (n) => {
          if (n.type !== "CallExpression" || methodName(n) !== "route") return false;
          return getStaticStringValue(((n.arguments as AstNode[] | undefined) ?? [])[0]) === path;
        }).length > 0;
        if (shadowed.length === 0 && !mountsSubApp) return;

        const example = shadowed[0] ?? `${path}/…`;
        ctx.report(
          node,
          `Hono's \`use()\` takes a route pattern, not a prefix — so this guards \`${path}\` and **nothing beneath it**. Measured on Hono 4.13.5, the same middleware on \`use("${path}")\` answers 401 for \`${path}\` and **200, unguarded**, for \`${example}\`, while Express's \`use("${path}")\` guards both. ${mountsSubApp ? `Mounting a sub-app with \`route("${path}", …)\` does not change it.` : `This file registers \`${example}\`, which the middleware never runs for.`} Write \`use("${path}/*", …)\`.`,
        );
      },
    };
  },
});
