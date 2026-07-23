import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode, DiagnosticContext } from "../../core/types.ts";
import {
  getMethodName,
  getStaticStringValue,
  isFunctionLike,
  rootObjectName,
  staticMemberPath,
  unwrapChain,
} from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";
import { findEnclosingRequestHandler } from "../../core/request-path.ts";

/**
 * A personalized/authenticated HTTP response served with a *shared*-cacheable
 * `Cache-Control` (`public` or `s-maxage=…`). A CDN or shared proxy is allowed
 * to store such a response and hand the exact bytes to the *next* requester —
 * so if the payload was built from the current user's identity (their profile,
 * their session, their bearer token), a different user receives it. That is a
 * silent cross-user data leak, and the response never had to be re-requested by
 * an attacker: normal traffic behind a shared cache is enough.
 *
 * Fires only when ALL of these hold inside the SAME request handler:
 *   1. the handler sets `Cache-Control` to a shared-cacheable value —
 *      `res.set/setHeader/header("Cache-Control", "public, …")`, the object form
 *      `res.set({ "Cache-Control": "public, …" })`, or the koa/fastify receivers
 *      `ctx`/`reply` — where the value has `public` or a positive `s-maxage` and
 *      NOT `private`/`no-store`; and
 *   2. user-identity data actually reaches the RESPONSE BODY — an identity source
 *      (`req.user`/`session`/`cookies`/`auth`/`userId`, `req.headers.authorization`/
 *      `cookie`, `req.get("authorization")`, or koa's `ctx.state.user`), directly or
 *      through a `const u = req.user` / `const { user } = req` binding, appears
 *      inside a response payload (`res.json/send/end/write/render(...)`, a
 *      `return`ed value, or `ctx.body = …`); and
 *   3. the handler does NOT already key the response per-user with
 *      `Vary: Authorization`/`Cookie`, and does NOT also set a corrective
 *      `private`/`no-store` that would override the value on the wire.
 *
 * WHY "reaches the body", not "reads identity anywhere": an identity read used only
 * to GATE access (`if (!req.user) return res.sendStatus(401)`) or to validate a CSRF
 * token does not personalize the payload — the body may be a shared catalog that is
 * legitimately public-cacheable. Coupling any handler-body identity read to the
 * cache header flagged those correct handlers, so the rule now requires the identity
 * to land in the response itself.
 *
 * Deliberately silent (precision — opt-in greenfield header/auth inference):
 *   - `Cache-Control` with `private`/`no-store`, or overridden by a later such set;
 *   - a response correctly keyed per user with `Vary: Authorization`/`Cookie`;
 *   - an identity read that never reaches the response body (auth gate, CSRF check);
 *   - a header set outside any request handler (module-scope boot config);
 *   - `max-age=…` alone, or `s-maxage=0` — browser-private / shared-cache opt-out,
 *     not a shared-cache retention instruction;
 *   - dynamic, non-string header values we cannot read statically;
 *   - identity reads / payloads inside a NESTED function of the handler (pruned).
 *
 * ❌ app.get("/me", (req, res) => { const u = req.user; res.set("Cache-Control", "public, max-age=60"); res.json(u); });
 * ✅ app.get("/me", (req, res) => { const u = req.user; res.set("Cache-Control", "private, no-store"); res.json(u); });
 * ✅ app.get("/me", (req, res) => { const u = req.user; res.set("Vary", "Authorization"); res.set("Cache-Control", "public, max-age=30"); res.json(u); }); // keyed per user
 * ✅ app.get("/catalog", (req, res) => { if (!req.user) return res.sendStatus(401); res.set("Cache-Control", "public, max-age=3600"); res.json(CATALOG); }); // identity only gates access
 */

/** Response-object receivers whose header setters we watch (express/koa/fastify). */
const RESPONSE_RECEIVERS = new Set(["res", "response", "reply", "ctx"]);
/** Methods that set an HTTP response header. */
const HEADER_SET_METHODS = new Set(["set", "setHeader", "header"]);

/** Receivers whose members/reads carry the current user's identity. */
const IDENTITY_RECEIVERS = new Set(["req", "request", "ctx"]);
/** Direct properties that name a user-identity source (compared case-folded). */
const IDENTITY_PROPS = new Set(["user", "session", "cookies", "auth", "userid", "currentuser"]);
/** Request-header names that carry identity, read via `req.get(name)`/`req.headers.<name>`. */
const IDENTITY_HEADERS = new Set(["authorization", "cookie"]);
/** Header-reader methods on the request object. */
const HEADER_READ_METHODS = new Set(["get", "header"]);

/** Normalize a header name for a robust, case/separator-insensitive compare. */
const normalizeHeaderName = (name: string): string => name.toLowerCase().replace(/[-_]/g, "");
const isCacheControlName = (name: string): boolean => normalizeHeaderName(name) === "cachecontrol";

/**
 * Is this `Cache-Control` value shared-cacheable *and* not corrected? `private`
 * or `no-store` mean a shared cache must not store the response, so their
 * presence is dispositive silence — even alongside `public` (a contradictory
 * header still errs safe under the stricter directive).
 *
 * `public` firing regardless of TTL is deliberate: marking an authenticated
 * response `public` at all authorizes a shared cache to store it — the mistake is
 * the keyword, not the freshness window. But a bare `s-maxage=0` is the OPPOSITE
 * instruction ("shared caches must revalidate immediately"), so an `s-maxage`
 * directive only counts when its value is POSITIVE — otherwise `s-maxage=0` (a
 * correct opt-out) would be read as a leak.
 */
const isSharedCacheableValue = (value: string): boolean => {
  const v = value.toLowerCase();
  if (v.includes("private") || v.includes("no-store")) return false;
  if (v.includes("public")) return true;
  const sMaxAge = /s-maxage\s*=\s*(\d+)/.exec(v);
  return sMaxAge !== null && Number(sMaxAge[1]) > 0;
};

/**
 * The statically-known `Cache-Control` value this header-set call assigns, or
 * null when the call sets some other header, is a getter, or the value is
 * dynamic. Handles the two-arg string form and the object form.
 */
const cacheControlValue = (call: AstNode): string | null => {
  const args = (call.arguments as AstNode[] | undefined) ?? [];

  // Two-arg string form: res.set("Cache-Control", "public, max-age=60").
  const name = getStaticStringValue(args[0]);
  if (name !== null) {
    if (!isCacheControlName(name)) return null;
    // A single-arg call is a getter; a dynamic value we cannot prove → null.
    return getStaticStringValue(args[1]);
  }

  // Object form: res.set({ "Cache-Control": "public, max-age=60" }).
  const obj = args[0];
  if (obj && obj.type === "ObjectExpression") {
    for (const prop of (obj.properties as AstNode[] | undefined) ?? []) {
      if (prop.type !== "Property" || prop.computed) continue;
      const key = prop.key as AstNode | undefined;
      const keyName =
        key?.type === "Identifier"
          ? (key.name as string)
          : key?.type === "Literal" && typeof key.value === "string"
            ? key.value
            : null;
      if (keyName && isCacheControlName(keyName)) return getStaticStringValue(prop.value);
    }
  }
  return null;
};

/** Does this member expression read a user-identity property (`req.user`, `req.headers.authorization`, …)? */
const isIdentityMember = (node: AstNode): boolean => {
  const path = staticMemberPath(node);
  if (!path) return false;
  const parts = path.split(".");
  if (parts.length < 2) return false;
  if (!IDENTITY_RECEIVERS.has(parts[0]!.toLowerCase())) return false;
  // req.headers.authorization / req.headers.cookie
  if (parts.length >= 3 && parts[1]!.toLowerCase() === "headers") {
    return IDENTITY_HEADERS.has(parts[2]!.toLowerCase());
  }
  // koa: ctx.state.user / ctx.state.session — `ctx.state` is THE idiomatic koa
  // location for the authenticated user (koa-passport et al. write there).
  if (parts.length >= 3 && parts[1]!.toLowerCase() === "state") {
    return IDENTITY_PROPS.has(parts[2]!.toLowerCase());
  }
  // req.user / req.session / req.cookies / req.auth / req.userId / req.currentUser
  if (parts.length === 2) return IDENTITY_PROPS.has(parts[1]!.toLowerCase());
  return false;
};

/** Does this call read an identity header — `req.get("authorization")` / `req.header("cookie")`? */
const isIdentityHeaderRead = (node: AstNode): boolean => {
  const method = getMethodName(node);
  if (!method || !HEADER_READ_METHODS.has(method)) return false;
  const root = rootObjectName(node.callee);
  if (!root || !IDENTITY_RECEIVERS.has(root.toLowerCase())) return false;
  const arg0 = getStaticStringValue((node.arguments as AstNode[] | undefined)?.[0]);
  return !!arg0 && IDENTITY_HEADERS.has(arg0.toLowerCase());
};

/** Any user-identity read reachable in the handler's OWN body (nested functions pruned). */
const isIdentityRead = (node: AstNode): boolean =>
  (node.type === "MemberExpression" && isIdentityMember(node)) ||
  (node.type === "CallExpression" && isIdentityHeaderRead(node));

/** Response methods whose argument(s) carry the response BODY. */
const RESPONSE_BODY_METHODS = new Set(["json", "send", "jsonp", "end", "write", "render"]);

/**
 * Does this expression carry user-identity data? A direct identity read, or an
 * identifier resolved one hop back to one — `const u = req.user`, or the
 * destructuring `const { user } = req` (init is `req`/`request`/`ctx` and the bound
 * name is an identity property). A property KEY (`{ user: … }`) is a name, not a
 * reference, so it is never resolved.
 */
const isIdentityExpr = (node: AstNode | null | undefined, ctx: DiagnosticContext): boolean => {
  const n = unwrapChain(node);
  if (!n) return false;
  if (isIdentityRead(n)) return true;
  if (n.type === "Identifier") {
    const parent = n.parent;
    if (parent && parent.type === "Property" && parent.key === n && !parent.computed) return false;
    const binding = ctx.scope.getBinding(n.name, n);
    const init = binding?.initNode ? unwrapChain(binding.initNode) : null;
    if (init && isIdentityRead(init)) return true;
    if (
      init &&
      init.type === "Identifier" &&
      IDENTITY_RECEIVERS.has(init.name.toLowerCase()) &&
      IDENTITY_PROPS.has(n.name.toLowerCase())
    ) {
      return true;
    }
  }
  return false;
};

/**
 * Does user-identity data actually reach a RESPONSE BODY in this handler? This is
 * the crux that separates a personalized payload (the leak) from an identity read
 * used only to GATE access (a `401` guard) or validate a CSRF token — those do not
 * put user data in the body, so shared-caching a public body is fine. We collect
 * every response-body payload (`res.json/send/jsonp/end/write/render(...)`, a
 * `return`ed value for fastify/hono, and `ctx.body = …` for koa) and look for an
 * identity expression inside any of them (nested functions pruned).
 */
const identityReachesBody = (handler: AstNode, ctx: DiagnosticContext): boolean => {
  const payloads: AstNode[] = [];
  for (const call of collectDescendants(handler, (n) => n.type === "CallExpression", isFunctionLike)) {
    const m = getMethodName(call);
    if (!m || !RESPONSE_BODY_METHODS.has(m)) continue;
    const root = rootObjectName(call.callee);
    if (!root || !RESPONSE_RECEIVERS.has(root.toLowerCase())) continue;
    for (const arg of (call.arguments as AstNode[] | undefined) ?? []) payloads.push(arg);
  }
  for (const ret of collectDescendants(handler, (n) => n.type === "ReturnStatement", isFunctionLike)) {
    if (ret.argument) payloads.push(ret.argument as AstNode);
  }
  for (const assign of collectDescendants(handler, (n) => n.type === "AssignmentExpression", isFunctionLike)) {
    const left = assign.left as AstNode;
    const path = left?.type === "MemberExpression" ? staticMemberPath(left) : null;
    if (path === "ctx.body" || path === "ctx.response.body") payloads.push(assign.right as AstNode);
  }
  for (const p of payloads) {
    if (isIdentityExpr(p, ctx)) return true;
    if (collectDescendants(p, (n) => isIdentityExpr(n, ctx), isFunctionLike).length > 0) return true;
  }
  return false;
};

/** Read a header name+value off a response header-set call (two-arg or object form). */
const headerSets = (call: AstNode): Array<{ name: string; value: string | null }> => {
  const out: Array<{ name: string; value: string | null }> = [];
  const args = (call.arguments as AstNode[] | undefined) ?? [];
  const name = getStaticStringValue(args[0]);
  if (name !== null) {
    out.push({ name, value: getStaticStringValue(args[1]) });
    return out;
  }
  const obj = args[0];
  if (obj && obj.type === "ObjectExpression") {
    for (const prop of (obj.properties as AstNode[] | undefined) ?? []) {
      if (prop.type !== "Property" || prop.computed) continue;
      const key = prop.key as AstNode | undefined;
      const keyName =
        key?.type === "Identifier"
          ? (key.name as string)
          : key?.type === "Literal" && typeof key.value === "string"
            ? key.value
            : null;
      if (keyName) out.push({ name: keyName, value: getStaticStringValue(prop.value) });
    }
  }
  return out;
};

/** Every response header-set / `res.vary()` call in the handler (nested funcs pruned). */
const responseHeaderCalls = (handler: AstNode): AstNode[] =>
  collectDescendants(handler, (n) => {
    if (n.type !== "CallExpression") return false;
    const m = getMethodName(n);
    if (!m || (!HEADER_SET_METHODS.has(m) && m !== "append" && m !== "vary")) return false;
    const root = rootObjectName(n.callee);
    return !!root && RESPONSE_RECEIVERS.has(root.toLowerCase());
  }, isFunctionLike);

const varyKeysIdentity = (value: string | null): boolean => !!value && /authorization|cookie/i.test(value);

/**
 * Does the handler key the response per-user with `Vary: Authorization`/`Cookie`
 * (or `res.vary("Authorization")`)? That makes a shared cache include the identity
 * header in its cache key, so user A's bytes are never served to user B — it is the
 * rule's OWN recommended fix, and must never be flagged.
 */
const keysPerUser = (handler: AstNode): boolean => {
  for (const call of responseHeaderCalls(handler)) {
    if (getMethodName(call) === "vary") {
      if (varyKeysIdentity(getStaticStringValue((call.arguments as AstNode[] | undefined)?.[0]))) return true;
      continue;
    }
    for (const { name, value } of headerSets(call)) {
      if (normalizeHeaderName(name) === "vary" && varyKeysIdentity(value)) return true;
    }
  }
  return false;
};

/**
 * Does the handler ALSO set `Cache-Control` to `private`/`no-store` somewhere? A
 * later same-header `res.set` wins on the wire (last write), and the common
 * "public default, tighten to private when authed" pattern sets both — so the
 * presence of a corrective directive means the response is (at least on the real
 * path) protected. We back off rather than flag a `public` value that is overridden.
 */
const correctsCacheControl = (handler: AstNode, offending: AstNode): boolean => {
  for (const call of responseHeaderCalls(handler)) {
    if (call === offending) continue;
    const value = cacheControlValue(call);
    if (value !== null && /private|no-store/i.test(value)) return true;
  }
  return false;
};

export const noSharedCacheAuthenticatedResponse = defineDiagnostic({
  id: "no-shared-cache-authenticated-response",
  title: "Authenticated response served with a shared-cacheable Cache-Control",
  severity: "warn",
  category: "Security",
  confidence: "high",
  defaultEnabled: false,
  tags: ["privacy", "http"],
  recommendation:
    "For an authenticated or personalized response, set `Cache-Control: private, no-store` (or drop `public`/`s-maxage`) so a CDN/shared proxy cannot store and re-serve it. If it must be shared-cacheable, key it per user with `Vary: Authorization`.",
  create: (ctx) => ({
    CallExpression: (node) => {
      const method = getMethodName(node);
      if (!method || !HEADER_SET_METHODS.has(method)) return;
      const root = rootObjectName(node.callee);
      if (!root || !RESPONSE_RECEIVERS.has(root.toLowerCase())) return;

      const value = cacheControlValue(node);
      if (value === null || !isSharedCacheableValue(value)) return;

      // The enclosing request handler is the gate — a header set at module scope
      // (boot config) has no per-user response to leak.
      const handler = findEnclosingRequestHandler(node, ctx.requestHandlers);
      if (!handler) return;

      // Correct per-user keying (`Vary: Authorization`) — the rule's own remedy.
      if (keysPerUser(handler)) return;
      // A corrective `private`/`no-store` elsewhere overrides this value on the wire.
      if (correctsCacheControl(handler, node)) return;
      // Fire ONLY when user-identity data reaches the response BODY — an identity
      // read used only to gate access or validate a CSRF token does not personalize
      // the payload, so shared-caching a public body is legitimate.
      if (!identityReachesBody(handler, ctx)) return;

      ctx.report(
        node,
        "This handler serializes user-identity data into the response yet sets a shared-cacheable `Cache-Control` (`public`/`s-maxage`) — a CDN or shared proxy can store this personalized payload and hand it to the next user (a cross-user data leak). Set `Cache-Control: private, no-store`, drop `public`/`s-maxage` for authenticated responses, or key it per user with `Vary: Authorization`.",
      );
    },
  }),
});
