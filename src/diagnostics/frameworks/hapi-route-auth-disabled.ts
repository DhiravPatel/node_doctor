import { defineDiagnostic } from "../../core/types.ts";
import { getPropertyValue } from "../../core/ast.ts";
import {
  hapiRouteMethods,
  hapiRouteObjects,
  hapiRouteOptions,
  hapiRoutePath,
} from "./hapi-route-shape.ts";

/**
 * A state-changing hapi route that opts out of the server's auth strategy with
 * `auth: false`. Once a default strategy is registered
 * (`server.auth.default("jwt")`), every route inherits it — so `auth: false` is a
 * deliberate, per-route hole. On a POST/PUT/PATCH/DELETE that is an unauthenticated
 * write endpoint: anyone who can reach the host can mutate data. This is the exact
 * shape behind "the debug route we left in" incidents, because `auth: false` is
 * usually added to unblock a local test and never removed.
 *
 * Public entry points legitimately run unauthenticated, so any route whose static
 * path names one (health, metrics, login, register, webhook, …) is silent, as is
 * every GET and every route whose path is not a static string.
 *
 * ❌ server.route({ method: "POST", path: "/admin/users", options: { auth: false }, handler: create });
 * ✅ server.route({ method: "POST", path: "/admin/users", options: { auth: "jwt" }, handler: create });
 * ✅ server.route({ method: "POST", path: "/login", options: { auth: false }, handler: login });
 */

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Path fragments that mark a legitimately unauthenticated endpoint. Matched as
 * substrings of the lowercased path, which is deliberately generous: an extra
 * match costs a missed finding, a missed match costs a false positive.
 */
const PUBLIC_PATH_FRAGMENTS = [
  "auth",
  "callback",
  "confirm",
  "contact",
  "feedback",
  "forgot",
  "health",
  "hook",
  "invite",
  "live",
  "log-in",
  "login",
  "logout",
  "metrics",
  "newsletter",
  "oauth",
  "password",
  "ping",
  "public",
  "ready",
  "register",
  "reset",
  "saml",
  "session",
  "sign-in",
  "sign-out",
  "sign-up",
  "signin",
  "signout",
  "signup",
  "sso",
  "status",
  "subscribe",
  "token",
  "verify",
  "waitlist",
  "webhook",
];

const isPublicPath = (path: string): boolean => {
  const lowered = path.toLowerCase();
  return PUBLIC_PATH_FRAGMENTS.some((fragment) => lowered.includes(fragment));
};

export const hapiRouteAuthDisabled = defineDiagnostic({
  id: "hapi-route-auth-disabled",
  title: "hapi route disables auth on a state-changing endpoint",
  severity: "error",
  category: "Security",
  requires: ["hapi"],
  tags: ["hapi", "auth", "access-control"],
  recommendation:
    "Remove `auth: false` so the route inherits the server's default strategy, or name the strategy explicitly (`auth: \"jwt\"`). If the endpoint really is public, scope it to a dedicated public path prefix.",
  create: (ctx) => ({
    CallExpression: (node) => {
      for (const route of hapiRouteObjects(node)) {
        const methods = hapiRouteMethods(route);
        if (!methods) continue; // unresolvable method — say nothing
        if (!methods.every((m) => MUTATING_METHODS.has(m))) continue;

        const options = hapiRouteOptions(route);
        if (options.kind !== "object") continue;

        const auth = getPropertyValue(options.node, "auth");
        // Only a literal `false` is a full opt-out. `{ mode: "try" }`, `"jwt"`,
        // and anything non-static keep authentication in play.
        if (!auth || auth.type !== "Literal" || auth.value !== false) continue;

        const path = hapiRoutePath(route);
        if (path === null) continue; // dynamic path — the allowlist cannot apply
        if (isPublicPath(path)) continue;

        ctx.report(
          auth,
          `This hapi \`${methods.join("/")}\` route sets \`auth: false\` — a state-changing endpoint served with no authentication.`,
        );
      }
    },
  }),
});
