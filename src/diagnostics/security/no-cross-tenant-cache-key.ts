import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode, DiagnosticContext } from "../../core/types.ts";
import {
  getMethodName,
  getReceiverName,
  staticMemberPath,
  rootObjectName,
  isFunctionLike,
  unwrapChain,
} from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";

/**
 * §140 — Cache-key correctness & cross-tenant poisoning.
 *
 * A cache write `cache.set(key, value)` whose VALUE is derived from a specific
 * user/tenant identity but whose KEY omits that identity. User A's per-user data
 * is then stored under a key that user B *also* computes, so B is served A's data
 * straight from cache. It is a silent cross-tenant data leak: no error, no crash,
 * intermittent (only on a cache hit under the right interleaving), and nearly
 * impossible to reproduce or attribute after the fact — which is exactly why it
 * is the flagship, highest-severity item in this wave.
 *
 *   ❌ cache.set(`orders:${status}`, await getOrders(req.user.id));
 *      // key varies by `status`, value varies by user → B gets A's orders
 *   ✅ cache.set(`orders:${req.user.id}:${status}`, await getOrders(req.user.id));
 *
 * WHY IT FIRES (all must hold):
 *   1. A cache-WRITE sink: `<recv>.set|setex|put(...)` where the receiver's last
 *      dotted segment (lowercased) names a cache (cache/redis/memcache(d)/lru/kv/
 *      store/cacheClient/redisClient, or ends in "cache"/"redis"). The KEY is
 *      arg0; the VALUE is arg1 (arg2 for `setex(key, ttl, value)`).
 *   2. The VALUE references a tenant/user IDENTITY source — a request-rooted
 *      member path (req./request./ctx./session.) containing a user/tenant/org/
 *      account segment (e.g. req.user.id, req.tenantId, ctx.state.user), or a
 *      bare `userId`/`tenantId`/`orgId`/`accountId`/`organizationId` identifier.
 *      Each match reduces to an identity TOKEN (userid/tenantid/orgid/accountid).
 *   3. The KEY does NOT carry the same identity token the value has.
 *
 * DELIBERATE SILENCE (precision-first — a false positive here is a release
 * blocker, so the rule ships opt-in and reasons narrowly):
 *   - The key already includes the id (`cache:${req.user.id}:${status}`) — the
 *     token is present on both sides, no leak.
 *   - The value has no identity reference at all (a genuinely shared/global
 *     entry, e.g. `cache.set(`config:${env}`, loadConfig())`).
 *   - A non-cache `.set` — `Map.set`, `headers.set`, a DOM `.set` — is excluded
 *     by the receiver-name gate.
 *   - The identity is referenced only inside a NESTED function of the value
 *     (`memoize(() => getOrders(req.user.id))`) — pruned, because that closure's
 *     body is not the value written now.
 *   - A cache READ (`cache.get`) is never flagged.
 *   - No cross-file taint: this is the file-local slice where the identity source
 *     appears directly in the value expression (including as a call argument,
 *     e.g. `getOrders(req.user.id)`). We do not infer identity through an opaque
 *     helper whose body lives elsewhere.
 *
 * Identity extraction is deliberately conservative: a member property named
 * `userId` on a non-request root (`row.userId`) is NOT counted, only request-
 * rooted paths and genuine bare-identifier references — over-collecting on the
 * value side is what would manufacture a false leak.
 */

/** Cache-write method names. For `setex` the value is arg2, otherwise arg1. */
const CACHE_WRITE_METHODS = new Set(["set", "setex", "put"]);

/**
 * Receiver last-segments (lowercased) that name a cache client. `endsWith`
 * "cache"/"redis" additionally covers `usersCache`, `sessionRedis`, etc.
 */
// `store` is intentionally NOT here: it names too many non-cache objects (a Redux/
// Zustand state container, a data-access store, a session store), and the
// identity-token gate cannot tell them apart from a cache — a false positive.
const CACHE_RECEIVERS = new Set([
  "cache",
  "redis",
  "memcache",
  "memcached",
  "lru",
  "kv",
  "cacheclient",
  "redisclient",
]);

/**
 * Audit-metadata property keys. An identity that is the VALUE of one of these
 * (`{ …data…, createdBy: req.user.id }`) is a stamp of *who* wrote a SHARED entry,
 * not a per-tenant data dependency — counting it would manufacture a false leak.
 */
const AUDIT_KEY_RE =
  /^(?:created|updated|modified|deleted|audited|requested|changed|last\w*)?by$|^(?:author|owner)$/i;

/** Key words that scope an entry per-session (⇒ already per-user), so the id is fine inside. */
const SESSION_SCOPE_RE = /^(?:sid|sessionid|session_id)$/i;

const isCacheReceiverSegment = (seg: string): boolean =>
  CACHE_RECEIVERS.has(seg) || seg.endsWith("cache") || seg.endsWith("redis");

/** Member-path roots whose identity segments are trusted request identity. */
const REQUEST_IDENTITY_ROOTS = new Set(["req", "request", "ctx", "session"]);

/**
 * Each group maps a family of identity words (as whole-word matches inside a
 * lowercased dotted path) to a single canonical token. Ordered so the more
 * specific `*id` form is tried first inside its own alternation.
 */
const IDENTITY_GROUPS: ReadonlyArray<{ re: RegExp; token: string }> = [
  { re: /\b(?:currentuser|userid|user)\b/, token: "userid" },
  { re: /\b(?:tenantid|tenant)\b/, token: "tenantid" },
  { re: /\b(?:orgid|organization|org)\b/, token: "orgid" },
  { re: /\b(?:accountid|account)\b/, token: "accountid" },
];

/** Bare identifiers (exact, case-sensitive) that stand in for an identity. */
const BARE_IDENTITY: ReadonlyMap<string, string> = new Map([
  ["userId", "userid"],
  ["tenantId", "tenantid"],
  ["orgId", "orgid"],
  ["accountId", "accountid"],
  ["organizationId", "orgid"],
]);

/** Deterministic reporting order for the missing token. */
const TOKEN_ORDER: readonly string[] = ["userid", "tenantid", "orgid", "accountid"];

const IDENTITY_PHRASE: Record<string, string> = {
  userid: "the user's identity",
  tenantid: "the tenant's identity",
  orgid: "the organization's identity",
  accountid: "the account's identity",
};

const IDENTITY_NOUN: Record<string, string> = {
  userid: "user id",
  tenantid: "tenant id",
  orgid: "organization id",
  accountid: "account id",
};

/**
 * Is this Identifier a genuine value reference rather than a member property or
 * an object-literal key? `req.userId`'s `userId` and `{ userId: 1 }`'s key are
 * not bare identity references — counting them would inflate the value side.
 */
const isReferenceIdentifier = (n: AstNode): boolean => {
  const p = n.parent;
  if (!p) return true;
  if (p.type === "MemberExpression" && p.property === n && !p.computed) return false;
  if (p.type === "Property" && p.key === n && !p.computed) return false;
  return true;
};

/**
 * Is `node` the value of an AUDIT-metadata property (`createdBy: req.user.id`),
 * anywhere up its enclosing-object chain? Such an id stamps who wrote a shared
 * entry — it is not a per-tenant data dependency, so it must not count toward the
 * value's identity.
 */
const isAuditFieldValue = (node: AstNode): boolean => {
  let cur: AstNode = node;
  let p: AstNode | null | undefined = node.parent;
  while (p) {
    if (p.type === "Property" && !p.computed && p.value === cur) {
      const key = p.key as AstNode | undefined;
      const name =
        key?.type === "Identifier"
          ? (key.name as string)
          : key?.type === "Literal" && typeof key.value === "string"
            ? key.value
            : null;
      if (name && AUDIT_KEY_RE.test(name)) return true;
    }
    // Stop climbing once we leave any object-literal context (a call/statement).
    if (p.type === "CallExpression" || p.type === "ReturnStatement" || p.type === "VariableDeclarator") break;
    cur = p;
    p = p.parent;
  }
  return false;
};

/**
 * Collect identity tokens present in `expr` (pruning nested functions), mapped to
 * a representative source snippet for the first occurrence of each token — used
 * both as the token set and, for the value side, to name the leaking source.
 */
const identityTokens = (ctx: DiagnosticContext, expr: AstNode): Map<string, string> => {
  const out = new Map<string, string>();
  const nodes = collectDescendants(
    expr,
    (n) => n.type === "MemberExpression" || n.type === "Identifier",
    isFunctionLike,
    true,
  );
  for (const n of nodes) {
    if (isAuditFieldValue(n)) continue; // an audit stamp, not a per-tenant dependency
    const tokens: string[] = [];
    if (n.type === "MemberExpression") {
      const path = staticMemberPath(n);
      if (!path) continue;
      const root = rootObjectName(n);
      if (!root || !REQUEST_IDENTITY_ROOTS.has(root.toLowerCase())) continue;
      const lower = path.toLowerCase();
      for (const { re, token } of IDENTITY_GROUPS) {
        if (re.test(lower)) tokens.push(token);
      }
    } else {
      // Identifier
      if (!isReferenceIdentifier(n)) continue;
      const token = BARE_IDENTITY.get(n.name);
      if (token) tokens.push(token);
    }
    if (tokens.length === 0) continue;
    const snippet = ctx.sourceText.slice(n.start, n.end);
    for (const token of tokens) {
      if (!out.has(token)) out.set(token, snippet);
    }
  }
  return out;
};

/**
 * Key expressions we can read END-TO-END to prove whether the id is present: a
 * template literal, a string literal, or a `+` concatenation of them. A key-building
 * CALL (`makeKey(...)`) or a MEMBER access (`keys.orders`) is deliberately NOT
 * concrete — the key's real content lives inside the function/object, so we cannot
 * prove it omits the id and must stay silent rather than risk a false positive.
 */
const isConcreteKeyExpr = (n: AstNode | null | undefined): boolean =>
  !!n && (n.type === "TemplateLiteral" || n.type === "Literal" || n.type === "BinaryExpression");

/**
 * The identity tokens carried by the KEY, or `null` when the key is OPAQUE — a
 * bare variable/parameter we cannot read. Firing on an opaque key would be a false
 * positive: `const cacheKey = \`orders:${req.user.id}\`` already carries the id, we
 * just can't see it here. So we resolve a key identifier ONE hop to its
 * initializer and analyze that; if it does not resolve to a concrete key
 * expression, we return null and the caller stays silent (precision over recall).
 */
const concreteKeyExpr = (ctx: DiagnosticContext, key: AstNode): AstNode | null => {
  const k = unwrapChain(key);
  if (isConcreteKeyExpr(k)) return k;
  if (k && k.type === "Identifier") {
    const init = unwrapChain(ctx.scope.getBinding(k.name, k)?.initNode);
    if (isConcreteKeyExpr(init)) return init;
  }
  return null; // opaque — cannot prove the key omits the identity
};

/**
 * Does the key scope the entry per SESSION (`sess:${sid}`, `${sessionId}`)? A
 * session id already uniquely identifies the user, so the entry is per-user and
 * embedding a `userId` in the value is not a cross-tenant leak.
 */
const keyScopesPerSession = (expr: AstNode): boolean =>
  collectDescendants(expr, (n) => n.type === "MemberExpression" || n.type === "Identifier", isFunctionLike, true).some(
    (n) => {
      if (n.type === "Identifier") return isReferenceIdentifier(n) && SESSION_SCOPE_RE.test(n.name as string);
      const prop = !n.computed && n.property?.type === "Identifier" ? (n.property.name as string) : null;
      return !!prop && SESSION_SCOPE_RE.test(prop);
    },
  );

/** The key text for the message, with surrounding template backticks trimmed. */
const keyDisplay = (ctx: DiagnosticContext, key: AstNode): string => {
  const raw = ctx.sourceText.slice(key.start, key.end);
  if (raw.length >= 2 && raw.startsWith("`") && raw.endsWith("`")) return raw.slice(1, -1);
  return raw;
};

export const noCrossTenantCacheKey = defineDiagnostic({
  id: "no-cross-tenant-cache-key",
  title: "Cache key omits the tenant/user identity its value depends on",
  severity: "warn",
  category: "Security",
  confidence: "high",
  tags: ["security", "cache"],
  defaultEnabled: false,
  scope: "file",
  recommendation:
    "Include the user/tenant identifier in the cache key (e.g. `orders:${req.user.id}:${status}`) so each tenant's value is keyed separately. A key that omits the id lets one user be served another user's cached data.",
  create: (ctx) => ({
    CallExpression: (node) => {
      const method = getMethodName(node);
      if (!method || !CACHE_WRITE_METHODS.has(method)) return;

      // Receiver-name gate: only real cache clients, never Map/headers/DOM `.set`.
      const receiver = getReceiverName(node);
      if (!receiver) return;
      const segment = receiver.split(".").pop()!.toLowerCase();
      if (!isCacheReceiverSegment(segment)) return;

      const args = (node.arguments as AstNode[] | undefined) ?? [];
      const key = args[0];
      const value = method === "setex" ? args[2] : args[1];
      if (!key || !value) return;
      // Spread/`...` args (arg node type SpreadElement) can't be reasoned about.
      if (key.type === "SpreadElement" || value.type === "SpreadElement") return;

      const valueTokens = identityTokens(ctx, value);
      if (valueTokens.size === 0) return; // shared/global entry — nothing per-tenant

      // Resolve the key to a concrete, readable expression; stay silent on an
      // OPAQUE key we cannot prove omits the identity (it may carry the id where it
      // was built).
      const keyExpr = concreteKeyExpr(ctx, key);
      if (keyExpr === null) return;
      // A per-session key already scopes the entry per user — the value's id is fine.
      if (keyScopesPerSession(keyExpr)) return;
      const keyTokens = identityTokens(ctx, keyExpr);

      for (const token of TOKEN_ORDER) {
        const source = valueTokens.get(token);
        if (source === undefined) continue; // value doesn't depend on this identity
        if (keyTokens.has(token)) continue; // key already carries it — safe

        ctx.report(
          node,
          `the cached value depends on ${IDENTITY_PHRASE[token]} (\`${source}\`) but the key \`${keyDisplay(
            ctx,
            key,
          )}\` omits it — user A's data will be served to user B from cache. Add the ${IDENTITY_NOUN[token]} to the cache key.`,
        );
        return; // one finding per cache-write sink
      }
    },
  }),
});
