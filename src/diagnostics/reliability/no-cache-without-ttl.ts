import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getCalleeName, getMethodName, getReceiverName, getStaticStringValue } from "../../core/ast.ts";
import { walk } from "../../core/walk.ts";

/**
 * OPT-IN (defaultEnabled: false). A cache write with no expiry. The entry then
 * lives until the process (or the Redis instance) is restarted: the working set
 * grows without bound, memory climbs until an eviction policy starts dropping
 * keys at random, and a value that changed hours ago is still served.
 *
 * Ships disabled because cache APIs vary far too much to be safe by default —
 * a wrapper's `set(key, value)` may well apply a default TTL internally, and
 * that is invisible here. Enable it deliberately, per project, once the cache
 * client is known.
 *
 * ❌ await redis.set(`user:${id}`, JSON.stringify(user));
 * ❌ cache.set(key, value, { staleWhileRevalidate: true });   // options, but no expiry
 * ✅ await redis.set(key, value, "EX", 60);
 * ✅ await redis.setex(key, 60, value);
 * ✅ cache.set(key, value, { ttl: 300 });
 * ✅ memcached.set(key, value, 300, cb);                      // positional lifetime
 * ✅ map.set(key, value);                                     // a plain Map is not a cache
 */

/**
 * Receiver names that identify a cache client (last segment, normalized), so
 * `this.redis.set(...)` matches and `map.set(...)` / `headers.set(...)` do not.
 */
/**
 * Constructors whose `set` we actually understand. A name built from anything
 * else is a bespoke class — its `set` may be a builder, a field assignment or a
 * bounded store, and guessing produced a verified false positive.
 */
/** Explicit-expiry calls that make a separate `set` legitimate. */
const EXPIRY_METHODS = new Set(["expire", "pexpire", "expireat", "pexpireat", "setex", "psetex", "ttl"]);

const RAW_CLIENT_CTORS = new Set(["Redis", "IORedis", "Memcached", "Memcache", "Client", "RedisClient"]);

const CACHE_RECEIVERS = new Set([
  "redis",
  "redisclient",
  "rediscache",
  "ioredis",
  "cache",
  "cacheclient",
  "cachestore",
  "memcached",
  "memcache",
  "memcacheclient",
  "memcachedclient",
]);

/** Redis `SET` expiry modifiers — their presence means the key expires. */
const REDIS_TTL_FLAGS = new Set(["ex", "px", "exat", "pxat", "keepttl"]);

/**
 * Option keys that carry an expiry, across redis/node-cache/lru-cache/memcached
 * wrappers. Deliberately generous: every name added here only ever *silences*
 * the rule, and an unfamiliar-but-real expiry option is the likeliest way this
 * check would produce a false positive.
 */
const TTL_KEYS = new Set([
  "ex",
  "px",
  "exat",
  "pxat",
  "keepttl",
  "ttl",
  "ttls",
  "ttlms",
  "ttlseconds",
  "maxttl",
  "expire",
  "expires",
  "expiry",
  "expiresin",
  "expirein",
  "expireat",
  "expiresat",
  "expireafter",
  "expiresafter",
  "expiration",
  "revalidate",
  "revalidateafter",
  "lifetime",
  "maxage",
  "age",
  "duration",
  "seconds",
  "timeout",
]);

/** Constructors whose instances are plain collections, not cache clients. */
const COLLECTION_CTORS = new Set(["Map", "Set", "WeakMap", "WeakSet"]);

/** Type names that mark a binding as a plain collection (`cache: Map<string, X>`). */
const COLLECTION_TYPES = new Set([
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "ReadonlyMap",
  "ReadonlySet",
]);

/**
 * Construction-time options that give a cache a lifetime story — an LRU bound or
 * a default TTL applied to every `set`. Their presence at the constructor means
 * individual writes need no expiry of their own.
 */
const BOUNDED_CTOR_KEYS = new Set([
  "max",
  "maxsize",
  "maxkeys",
  "maxentries",
  "maxage",
  "ttl",
  "stdttl",
  "ttlautopurge",
  "checkperiod",
]);

const normalize = (name: string): string => name.toLowerCase().replace(/[_-]/g, "");

/** Is this a `Map<…>`-style type annotation? */
const isCollectionType = (annotated: AstNode | null | undefined): boolean => {
  const holder = annotated?.typeAnnotation as AstNode | undefined;
  const type = (holder?.typeAnnotation as AstNode | undefined) ?? holder;
  return (
    type?.type === "TSTypeReference" &&
    type.typeName?.type === "Identifier" &&
    COLLECTION_TYPES.has(type.typeName.name)
  );
};

/** Does this options object declare any kind of expiry? */
const hasTtlOption = (obj: AstNode): boolean =>
  ((obj.properties as AstNode[]) ?? []).some((prop) => {
    if (prop.type !== "Property") return true; // a spread may carry the TTL — assume it does
    const key = prop.key as AstNode | undefined;
    if (!key) return true;
    if (!prop.computed && key.type === "Identifier") return TTL_KEYS.has(normalize(key.name));
    if (key.type === "Literal" && typeof key.value === "string") return TTL_KEYS.has(normalize(key.value));
    return true; // computed/dynamic key — unresolvable, so assume an expiry
  });

export const noCacheWithoutTtl = defineDiagnostic({
  id: "no-cache-without-ttl",
  title: "Cache write with no TTL",
  severity: "warn",
  category: "Reliability",
  tags: ["cache", "memory"],
  defaultEnabled: false,
  recommendation:
    "Give every cache entry an expiry: `redis.set(key, value, 'EX', 60)` / `redis.setex(key, 60, value)`, or the client's TTL option (`cache.set(key, value, { ttl: 300 })`). Without one the entry never expires — memory grows without bound and stale data is served indefinitely.",
  create: (ctx) => {
    /**
     * Names in this file that are NOT a TTL-bearing cache client: a plain
     * `Map`/`Set` (by construction or by type annotation), or a cache
     * constructed with a bound/default TTL (`new LRUCache({ max, ttl })`).
     * Collected for bare identifiers and for `this.x`/`obj.x` property names
     * alike, since the receiver check only ever looks at the last segment.
     */
    const exempt = new Set<string>();
    /** Receivers given an explicit expiry via a separate call. */
    const expiredReceivers = new Set<string>();

    /** Unwrap the shapes that hide a construction: `a ? new X() : new Y()`, `a ?? new X()`. */
    const constructionsIn = (node: AstNode | null | undefined): AstNode[] => {
      if (!node) return [];
      if (node.type === "NewExpression") return [node];
      if (node.type === "ConditionalExpression") {
        return [...constructionsIn(node.consequent as AstNode), ...constructionsIn(node.alternate as AstNode)];
      }
      if (node.type === "LogicalExpression") {
        return [...constructionsIn(node.left as AstNode), ...constructionsIn(node.right as AstNode)];
      }
      // One hop: `const cache = flag ? a : b` where a and b are collections.
      if (node.type === "Identifier") {
        const bound = ctx.scope.getBinding(node.name as string, node)?.initNode as AstNode | undefined;
        if (bound && bound.type === "NewExpression") return [bound];
      }
      return [];
    };

    const noteInit = (name: string | null | undefined, initNode: AstNode | null | undefined): void => {
      if (!name) return;
      const constructions = constructionsIn(initNode);
      // Any branch being a plain collection is enough: `ignoreStrings ? a : b`
      // where both are `new WeakMap()` is a memo table, not a cache client.
      if (constructions.some((c) => { const n = getCalleeName(c); return !!n && COLLECTION_CTORS.has(n); })) {
        exempt.add(name);
        return;
      }
      const init = constructions[0];
      if (!init) return;
      const ctor = getCalleeName(init);
      // `new ResultCache(files)` — a bespoke class whose `set` may mean anything.
      // Only a known raw client has a TTL-bearing `set` we can reason about.
      if (ctor && !RAW_CLIENT_CTORS.has(ctor)) {
        exempt.add(name);
        return;
      }
      // `new LRUCache({ max: 500, ttl: 60_000 })` — the lifetime lives at the
      // constructor, so per-write TTLs are not expected.
      for (const arg of (init.arguments as AstNode[] | undefined) ?? []) {
        if (arg.type !== "ObjectExpression") continue;
        for (const prop of (arg.properties as AstNode[]) ?? []) {
          if (prop.type !== "Property" || prop.computed) continue;
          const key = prop.key as AstNode | undefined;
          const keyName =
            key?.type === "Identifier"
              ? key.name
              : key?.type === "Literal" && typeof key.value === "string"
                ? key.value
                : null;
          if (keyName && BOUNDED_CTOR_KEYS.has(normalize(keyName))) exempt.add(name);
        }
      }
    };

    return {
      Program: (root) => {
        walk(root, {
          enter: (node) => {
            // Whole-file pre-pass: a receiver given an explicit expiry anywhere
            // does expire its entries, just not in the same call.
            if (node.type === "CallExpression") {
              const m = getMethodName(node);
              if (m && EXPIRY_METHODS.has(m.toLowerCase())) {
                const r = getReceiverName(node);
                const last = r ? r.split(".").pop() : null;
                if (last) expiredReceivers.add(last);
              }
            }
            switch (node.type) {
              case "VariableDeclarator":
                if (node.id?.type === "Identifier") {
                  if (isCollectionType(node.id)) exempt.add(node.id.name);
                  noteInit(node.id.name, node.init as AstNode | null);
                }
                break;
              case "PropertyDefinition":
                if (!node.computed && node.key?.type === "Identifier") {
                  if (isCollectionType(node)) exempt.add(node.key.name);
                  noteInit(node.key.name, node.value as AstNode | null);
                }
                break;
              case "TSPropertySignature":
                if (!node.computed && node.key?.type === "Identifier" && isCollectionType(node)) {
                  exempt.add(node.key.name);
                }
                break;
              case "Identifier":
                // Params and any other annotated binding: `(cache: Map<string, X>)`.
                if (isCollectionType(node)) exempt.add(node.name);
                break;
              case "AssignmentExpression": {
                const left = node.left as AstNode;
                const name =
                  left?.type === "Identifier"
                    ? left.name
                    : left?.type === "MemberExpression" &&
                        !left.computed &&
                        left.property?.type === "Identifier"
                      ? left.property.name
                      : null;
                noteInit(name, node.right as AstNode);
                break;
              }
              default:
                break;
            }
          },
        });
      },

      CallExpression: (node) => {
        if (getMethodName(node) !== "set") return;

        const receiver = getReceiverName(node);
        if (!receiver) return;
        const segments = receiver.split(".");
        const own = segments[segments.length - 1];
        if (!own || !CACHE_RECEIVERS.has(normalize(own))) return;
        if (exempt.has(own)) return; // a plain Map/Set, or bounded at construction

        const args = (node.arguments as AstNode[] | undefined) ?? [];
        if (args.length < 2) return; // not a key/value write
        if (args.some((a) => a.type === "SpreadElement")) return; // arguments unknown

        // `redis.set(k, v)` then `redis.expire(k, ttl)` is the documented
        // two-call form (and what several cache wrappers expose). The entry does
        // expire; reporting it would be telling the author to fix what they did.
        if (expiredReceivers.has(own)) return;

        const options = args.slice(2);
        if (options.length === 0) {
          ctx.report(
            node,
            `\`${own}.set(...)\` writes a cache entry with no TTL — it never expires, so memory grows without bound and stale data is served indefinitely.`,
          );
          return;
        }

        // A redis expiry modifier anywhere in the tail ("EX", 60) means it expires.
        for (const opt of options) {
          const literal = getStaticStringValue(opt);
          if (literal !== null && REDIS_TTL_FLAGS.has(normalize(literal))) return;
        }

        // An options object is the only tail shape we can read confidently. A bare
        // number, identifier, or callback may be a positional lifetime — stay silent.
        const objects = options.filter((o) => o.type === "ObjectExpression");
        if (objects.length !== options.length) return;
        if (objects.some(hasTtlOption)) return;

        ctx.report(
          node,
          `\`${own}.set(...)\` passes options but no TTL — the entry never expires, so memory grows without bound and stale data is served indefinitely.`,
        );
      },
    };
  },
});
