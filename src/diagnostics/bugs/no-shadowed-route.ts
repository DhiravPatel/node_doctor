import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, getReceiverName, getStaticStringValue } from "../../core/ast.ts";

/**
 * A route made unreachable by an earlier, more general route on the same router
 * (§4). Express, Fastify, Koa-router and friends match registrations top-to-bottom
 * and stop at the first hit, so a parameter route registered *before* a static one
 * it covers turns that static route into dead code:
 *
 *   router.get("/users/:id", show);   // matches "me" too
 *   router.get("/users/me",  me);     // never runs — ":id" already caught it
 *
 * The handler you wrote is never called; the request quietly hits the wrong one.
 * It is the routing bug that survives review because both lines look correct in
 * isolation — only their *order* is wrong.
 *
 * Gated to **Express**, and off when **Fastify** is present, because the whole
 * claim rests on *order-based* matching. Fastify and hapi resolve routes by a
 * radix tree where a static route wins over a parameter route regardless of
 * registration order — so `fastify.get("/users/:id")` before `/users/me` is NOT a
 * bug there, and firing on it would be a false positive. Express, Koa-router and
 * restify match top-to-bottom; requiring Express is the sound, high-value subset.
 *
 * Precision, sound toward silence:
 *  - Only routes on the **same router instance** — resolved through `ctx.scope` to
 *    the same binding, not just the same variable *name*. Two `express.Router()`
 *    built in two factory functions are both called `router` but are different
 *    routers, so they are never compared; a receiver we cannot resolve to a
 *    binding is left alone entirely. Reassigning the receiver to a fresh router
 *    resets its collected routes.
 *  - Same **file**, in source order, with the **same method** (or an earlier
 *    `.all`), and **literal** paths.
 *  - The shadowed route must be fully static — reasoning about one parameter route
 *    shadowing another is subtler and left alone.
 *  - A **constrained** parameter (`:id(\\d+)`) is NOT assumed to match anything: we
 *    cannot evaluate the constraint, so `:id(\\d+)` does not shadow `/me`. This is
 *    what keeps the rule from a false positive on the common numeric-id pattern.
 *  - An exact duplicate is `no-duplicate-route-definition`'s job, not this one.
 *
 * ❌ r.get("/u/:id", show); r.get("/u/me", me);        // "/u/me" is dead
 * ✅ r.get("/u/me", me);  r.get("/u/:id", show);        // specific first — correct
 * ✅ r.get("/u/:id(\\d+)", show); r.get("/u/me", me);   // constraint can't match "me"
 * ✅ r.get("/u/:id", show); adminR.get("/u/me", me);    // different routers
 */

const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "all"]);

interface Route {
  receiver: string;
  /** The resolved binding of the receiver — its identity, not its name. */
  binding: unknown;
  method: string;
  /** Path segments, no leading empty. */
  segments: string[];
  node: AstNode;
}

/** A segment shape: a literal, an unconstrained param, a constrained param, or a wildcard. */
type SegKind = { kind: "literal"; value: string } | { kind: "param" } | { kind: "constrained" } | { kind: "wildcard" };

const classifySegment = (seg: string): SegKind => {
  if (seg === "*" || seg === "(.*)" || seg === "(.*)?") return { kind: "wildcard" };
  if (seg.startsWith(":")) {
    // `:id` matches any single segment; `:id(\\d+)` only matches its regex, which
    // we cannot evaluate — treat as "might not match" so it never shadows.
    return seg.includes("(") ? { kind: "constrained" } : { kind: "param" };
  }
  return { kind: "literal", value: seg };
};

const splitSegments = (path: string): string[] => path.split("/").filter((s) => s.length > 0);

/**
 * Does the earlier route `a` provably match every request the fully-static route
 * `b` matches (making `b` dead), while being strictly more general than `b`?
 */
const shadows = (a: Route, b: Route): boolean => {
  // Method: same, or an earlier catch-all `.all`.
  if (a.method !== b.method && a.method !== "all") return false;

  const as = a.segments.map(classifySegment);
  const bs = b.segments;

  // `b` must be fully static for a sound "this route is dead" claim.
  if (bs.some((s) => classifySegment(s).kind !== "literal")) return false;

  // A trailing wildcard on `a` matches any deeper path sharing the static prefix.
  const aHasTrailingWildcard = as.length > 0 && as[as.length - 1]!.kind === "wildcard";
  if (!aHasTrailingWildcard && as.length !== bs.length) return false;
  if (aHasTrailingWildcard && bs.length < as.length - 1) return false;

  let strictlyMoreGeneral = false;
  const compareLen = aHasTrailingWildcard ? as.length - 1 : as.length;
  for (let i = 0; i < compareLen; i++) {
    const seg = as[i]!;
    if (seg.kind === "literal") {
      if (seg.value !== bs[i]) return false; // a static segment that differs → no match
    } else if (seg.kind === "param" || seg.kind === "wildcard") {
      strictlyMoreGeneral = true; // a covers a static segment of b
    } else {
      // constrained param — cannot prove it matches b's literal → no shadow
      return false;
    }
  }
  if (aHasTrailingWildcard) strictlyMoreGeneral = true;

  return strictlyMoreGeneral;
};

export const noShadowedRoute = defineDiagnostic({
  id: "no-shadowed-route",
  title: "Route made unreachable by an earlier, more general route",
  severity: "warn",
  category: "Bugs",
  confidence: "high",
  // Order-based matching only — see the doc comment. Express guaranteed present;
  // Fastify's tree-router guaranteed absent.
  requires: ["express"],
  disabledWhen: ["fastify"],
  tags: ["express", "routing"],
  recommendation:
    "Register the specific route BEFORE the parameter route on the same router — matching is top-to-bottom and stops at the first hit, so `/users/:id` before `/users/me` swallows `/users/me`. Move the static route up, or add a constraint (`:id(\\d+)`) so the param cannot match it.",
  create: (ctx) => {
    let routes: Route[] = [];
    return {
      // Reassigning the receiver to a new router instance (`router = Router()`)
      // invalidates everything registered on the old one — a fresh instance
      // starts with an empty match table, so earlier routes cannot shadow.
      AssignmentExpression: (node) => {
        const left = node.left as AstNode;
        if (left?.type !== "Identifier") return;
        const binding = ctx.scope.getBinding(left.name as string, left);
        if (binding) routes = routes.filter((r) => r.binding !== binding);
      },
      CallExpression: (node) => {
        const method = getMethodName(node);
        if (!method || !HTTP_VERBS.has(method)) return;
        const receiver = getReceiverName(node);
        if (!receiver) return;
        // Resolve the receiver to its binding — `router` in two factory functions
        // is two different routers. A receiver we cannot resolve (a bare global, a
        // `this.x` member) is not compared: we cannot prove it is the same instance.
        const callee = node.callee as AstNode | undefined;
        const receiverNode = callee?.type === "MemberExpression" ? (callee.object as AstNode) : undefined;
        if (receiverNode?.type !== "Identifier") return;
        const binding = ctx.scope.getBinding(receiverNode.name as string, receiverNode);
        if (!binding) return;

        const args = node.arguments as AstNode[];
        const path = getStaticStringValue(args[0]);
        if (path === null || args.length < 2) return;

        const route: Route = { receiver, binding, method, segments: splitSegments(path), node };
        // Registration order is walk order (pre-order over the program), so any
        // route already collected was registered earlier.
        for (const earlier of routes) {
          if (earlier.binding !== route.binding) continue;
          if (shadows(earlier, route)) {
            const earlierPath = "/" + earlier.segments.join("/");
            ctx.report(
              node,
              `This route is unreachable — \`${earlier.receiver}.${earlier.method}("${earlierPath}")\` is registered earlier and already matches it, so this handler never runs. Register the specific route before the parameter route.`,
            );
            return; // one shadower is enough
          }
        }
        routes.push(route);
      },
    };
  },
});
