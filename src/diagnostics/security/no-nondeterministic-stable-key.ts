import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode, Visitors, DiagnosticContext } from "../../core/types.ts";
import {
  getCalleeName,
  getMethodName,
  getReceiverName,
  staticMemberPath,
  unwrapChain,
  isFunctionLike,
} from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";

/**
 * A RANDOM value (`Math.random()`, `crypto.randomUUID()`) reaching a place that
 * MUST be stable: an HMAC/signature payload, a cache key, or an idempotency key.
 * These keys are only useful if identical logical inputs produce an identical key,
 * and a random draw can NEVER reproduce — it silently breaks the key on the very
 * next call.
 *
 * Production failure modes this catches:
 *  - `idempotencyKey: crypto.randomUUID()`: a retried request gets a fresh key, so
 *    the "idempotent" endpoint charges the card / creates the order twice.
 *  - `cache.set(\`u:${Math.random()}\`, v)`: every write lands under a unique key,
 *    so the cache never hits and grows without bound.
 *  - `hmac.update(payload + Math.random())`: the receiver recomputes the MAC over
 *    the same payload and it never matches, so every verification fails.
 *
 * WHY ONLY RANDOM, NOT TIME (precision-first; a false positive here is a release
 * blocker). `Date.now()`/`process.hrtime()`/`performance.now()` are DELIBERATELY
 * excluded: a timestamp in a stable-key sink is, far more often than not, correct —
 *  - a *signed request* (Stripe/Slack/SigV4 style) signs `timestamp.body` and
 *    transmits the timestamp alongside the signature; the verifier reuses the
 *    transmitted value, so the MAC reproduces exactly;
 *  - a *time-bucketed* cache or fixed-window rate-limit key
 *    (`\`rl:${userId}:${Math.floor(Date.now()/1000)}\``) is intentionally stable
 *    for the whole window — that is the entire point of the bucket.
 *  Separating those legitimate uses from a genuine raw-`Date.now()` key leak is not
 *  decidable from a single file, so time is left alone. A random draw has no such
 *  legitimate stable-key use, which is what makes it an unambiguous signal.
 *
 * Only the three stable-key sinks below fire. A random token, salt, nonce, or temp
 * filename SHOULD be random — none of those are stable-key sinks, so they stay
 * silent. If the source cannot be tied to one of the exact sinks, this says nothing.
 *
 * ❌ await redis.set(`job:${Math.random()}`, x);  // key differs every call
 * ❌ headers.idempotencyKey = crypto.randomUUID(); // retry is not deduped
 * ❌ hmac.update(userId + Math.random());          // signature never reproduces
 * ✅ hmac.update(userId + ":" + amount);           // stable payload
 * ✅ cache.set(`m:${Math.floor(Date.now()/6e4)}`, v); // time bucket — silent
 * ✅ const token = crypto.randomUUID();             // a token SHOULD be random
 */

// Nondeterministic (random) call sources, matched by fully-static callee path.
// Time sources (Date.now/hrtime/performance.now) are intentionally absent — see the
// header: a timestamp in a stable-key sink is usually a signed or bucketed value,
// not a bug, and the two cannot be told apart from one file.
const NONDET_CALL_PATHS = new Set([
  "Math.random",
  "crypto.randomUUID",
  "globalThis.crypto.randomUUID",
]);

// Bare method names that are crypto-specific enough to match unqualified
// (e.g. after `const { randomUUID } = require("node:crypto")`).
const NONDET_BARE_NAMES = new Set(["randomUUID"]);

// Property names whose value must be a stable key.
const STABLE_KEY_PROPS = new Set([
  "idempotencyKey",
  "idempotency_key",
  "cacheKey",
  "dedupeKey",
  "etag",
]);

// Key/value stores whose first `.set(...)` argument is the (must-be-stable) key.
const SET_RECEIVERS = new Set(["cache", "redis"]);

/** Is `node` itself a call to a known random source (`Math.random()`/`randomUUID()`)? */
const isNondetSource = (node: AstNode): boolean => {
  if (node.type !== "CallExpression") return false;
  const path = getCalleeName(node);
  if (path && NONDET_CALL_PATHS.has(path)) return true;
  // A bare, crypto-specific name (no receiver) — `randomUUID()`.
  const method = getMethodName(node);
  return !!method && NONDET_BARE_NAMES.has(method) && getReceiverName(node) === null;
};

/**
 * The nondeterministic source node inside `expr` — directly present, or one hop
 * away through a `const x = Date.now()` binding. Returns the source node (for
 * anchoring/labelling) or null. Nested functions are pruned: a source that only
 * appears inside a callback is not part of this synchronous key expression.
 */
const findNondet = (expr: AstNode, ctx: DiagnosticContext): AstNode | null => {
  const directs = collectDescendants(expr, isNondetSource, isFunctionLike, true);
  if (directs.length > 0) return directs[0]!;
  const idents = collectDescendants(expr, (n) => n.type === "Identifier", isFunctionLike, true);
  for (const id of idents) {
    const binding = ctx.scope.getBinding(id.name, id);
    if (binding?.initNode && isNondetSource(binding.initNode)) return binding.initNode;
  }
  return null;
};

/** A short human label for a source node, e.g. "Date.now()" or "process.pid". */
const sourceLabel = (node: AstNode): string => {
  if (node.type === "MemberExpression") return staticMemberPath(node) ?? "a nondeterministic value";
  const path = getCalleeName(node) ?? getMethodName(node);
  return path ? `${path}()` : "a nondeterministic value";
};

/**
 * Does `receiver` denote a crypto hash/hmac object — the result of
 * `crypto.createHash(...)` / `crypto.createHmac(...)`, directly, through a chained
 * `.update()`/`.copy()`, or through a binding? This gate is what keeps the common,
 * unrelated `.update()` (ORMs, arrays, streams) from ever firing.
 */
const isHashObject = (receiver: AstNode | null | undefined, ctx: DiagnosticContext): boolean => {
  const r = unwrapChain(receiver);
  if (!r) return false;
  if (r.type === "CallExpression") {
    const m = getMethodName(r);
    if (m === "createHash" || m === "createHmac") return true;
    // Chained on a hash object: crypto.createHash("sha256").update(a).update(b).
    if (m === "update" || m === "copy") {
      const inner = unwrapChain(r.callee);
      return isHashObject(inner?.type === "MemberExpression" ? inner.object : null, ctx);
    }
    return false;
  }
  if (r.type === "Identifier") {
    const binding = ctx.scope.getBinding(r.name, r);
    if (!binding?.initNode) return false;
    const m = getMethodName(binding.initNode);
    return m === "createHash" || m === "createHmac";
  }
  return false;
};

/** The receiver object of a member call, or null. */
const callReceiverNode = (node: AstNode): AstNode | null => {
  const callee = unwrapChain(node.callee);
  return callee?.type === "MemberExpression" ? (callee.object ?? null) : null;
};

export const noNondeterministicStableKey = defineDiagnostic({
  id: "no-nondeterministic-stable-key",
  title: "Nondeterministic value used as a stable key",
  severity: "warn",
  category: "Bugs",
  confidence: "high",
  tags: ["correctness", "crypto"],
  recommendation:
    "Build the key from the stable logical inputs only. Sign/cache/deduplicate over the request's identifying fields; never seed a stable key with `Math.random()`/`crypto.randomUUID()` at call time. For an idempotency key, use the value the CLIENT sends (stable across its retries), not a fresh random draw.",
  create: (ctx): Visitors => {
    const report = (src: AstNode, sink: string): void =>
      ctx.report(
        src,
        `\`${sourceLabel(src)}\` flows into ${sink} — it changes every run, so the key is not reproducible and the check silently breaks.`,
      );

    return {
      CallExpression: (node) => {
        const method = getMethodName(node);
        const args = (node.arguments as AstNode[]) ?? [];
        if (args.length === 0) return;

        // Sink 1: crypto hmac/hash `.update(payload)`.
        if (method === "update" && isHashObject(callReceiverNode(node), ctx)) {
          const src = findNondet(args[0]!, ctx);
          if (src) report(src, "an HMAC/hash `.update()` payload");
          return;
        }

        // Sink 3: `cache.set(key, ...)` / `redis.set(key, ...)` — first arg is the key.
        if (method === "set") {
          const recv = getReceiverName(node);
          const last = recv ? recv.split(".").pop()! : null;
          if (last && SET_RECEIVERS.has(last)) {
            const src = findNondet(args[0]!, ctx);
            if (src) report(src, `a \`${last}.set()\` cache key`);
          }
        }
      },

      // Sink 2a: `{ idempotencyKey: <expr>, ... }`.
      Property: (node) => {
        if (node.computed) return;
        const key = node.key;
        const name =
          key?.type === "Identifier"
            ? key.name
            : key?.type === "Literal" && typeof key.value === "string"
              ? key.value
              : null;
        if (!name || !STABLE_KEY_PROPS.has(name)) return;
        const value = node.value as AstNode | undefined;
        if (!value) return;
        const src = findNondet(value, ctx);
        if (src) report(src, `the \`${name}\` value`);
      },

      // Sink 2b: `obj.idempotencyKey = <expr>`.
      AssignmentExpression: (node) => {
        const left = node.left as AstNode;
        if (left?.type !== "MemberExpression" || left.computed) return;
        const prop = left.property;
        if (prop?.type !== "Identifier" || !STABLE_KEY_PROPS.has(prop.name)) return;
        const src = findNondet(node.right as AstNode, ctx);
        if (src) report(src, `the \`${prop.name}\` value`);
      },
    };
  },
});
