import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import {
  getCalleeName,
  getMethodName,
  getReceiverName,
  getStaticStringValue,
  rootObjectName,
  isFunctionLike,
} from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";
import { QUERY_METHODS, DB_RECEIVER_HINTS } from "../../core/signals.ts";

/**
 * §138 — Health-check correctness & cascading-failure risk: the "too deep
 * liveness" slice.
 *
 * A LIVENESS probe answers exactly one question: "is this process alive, or is
 * it wedged and in need of a restart?" The orchestrator (Kubernetes, ECS, a load
 * balancer) polls it on every pod, and a failing liveness probe means "kill this
 * pod and start a fresh one." That is the whole contract.
 *
 * The self-inflicted outage this rule catches: a liveness probe that reaches
 * OUT to a downstream dependency — a DB query, an outbound HTTP call, a Redis
 * ping. When that one dependency goes slow or down, the probe fails on EVERY pod
 * simultaneously, so the orchestrator concludes every pod is dead and restarts
 * the entire fleet. One slow database has now become a total, cluster-wide
 * outage, and the restart storm actively prevents recovery: fresh pods hammer
 * the already-struggling dependency on boot. A dependency check in a liveness
 * probe converts "one thing is degraded" into "everything is down."
 *
 * Dependency health belongs in a READINESS probe instead: a failing readiness
 * probe only pulls the pod out of the load-balancer rotation (stop sending it
 * traffic) — it does NOT restart the process — so a shared-dependency blip
 * degrades capacity gracefully instead of triggering a restart cascade.
 *
 * FIRES — a `.get(path, handler)` registration whose path is a liveness/health
 * path AND whose handler body (nested functions pruned) makes a downstream
 * dependency call:
 *   ❌ app.get("/healthz", async (req, res) => { await db.query("SELECT 1"); res.sendStatus(200); });
 *   ❌ app.get("/health",  async (req, res) => { await fetch("http://other/health"); res.json({ ok: true }); });
 *   ❌ app.get("/livez",   async (req, res) => { await redis.ping(); res.sendStatus(200); });
 *
 * DELIBERATE SILENCE (precision-first — a false positive here is a release
 * blocker):
 *   ✅ app.get("/readyz", async (req, res) => { await db.query("SELECT 1"); res.sendStatus(200); });
 *        // a READINESS probe SHOULD check dependencies — that is exactly its job.
 *   ✅ app.get("/healthz", (req, res) => res.sendStatus(200));
 *        // a shallow, dependency-free liveness probe is correct. We deliberately do
 *        // NOT flag the "too shallow always-200" case: it is a weaker, far noisier
 *        // signal and firing on it would grade every trivially-correct probe.
 *   ✅ app.get("/users", async (req, res) => { await db.query(sql); });
 *        // not a health path — an ordinary route SHOULD talk to its dependencies.
 *   ✅ app.get("/healthz", (req, res) => res.json({ uptime: process.uptime() }));
 *        // process metrics are self-contained, not a downstream dependency.
 *   ✅ a dependency call that lives only inside a nested, uninvoked closure.
 *
 * A "downstream dependency call" is one of three tight, high-confidence shapes:
 *   1. a DB query — a QUERY_METHODS method on a db-shaped receiver (segment-aware,
 *      the same test used by the N+1 rule so `em` does not match `items`);
 *   2. an outbound network call — global `fetch`, `axios`/`got` (any call rooted
 *      there), or `http`/`https` `.request`/`.get`;
 *   3. a redis/cache call — `.ping`/`.get`/`.set` on a redis/cache-shaped receiver.
 * An awaited form of any of these is covered for free: we match the CallExpression
 * itself, which is present whether or not it is awaited.
 *
 * Reported on the handler's dependency call. OPT-IN (defaultEnabled:false).
 */

// Path matching is SEGMENT-based, not substring/`\b`-based: a `\b` treats the
// hyphen in `/health-tips` as a boundary and wrongly matches it, while `/healthcheck`
// (no separator) fails a `health\b` boundary and is wrongly missed. So we split the
// path into `/`-segments, strip `-`/`_` from each, and match the whole normalized
// segment against a fixed set.
const norm = (seg: string): string => seg.toLowerCase().replace(/[-_]/g, "");
const pathSegments = (path: string): string[] =>
  path.replace(/[?#].*$/, "").split("/").filter(Boolean).map(norm);

/** Normalized liveness segment names — the probe must only prove the process is alive. */
const LIVENESS_SEGMENTS = new Set([
  "health",
  "healthz",
  "healthcheck",
  "healthchecks",
  "livez",
  "live",
  "liveness",
  "alive",
  "ping",
  "status",
]);

/**
 * Readiness segment names. A readiness probe is SUPPOSED to check dependencies, so a
 * path with a `ready`/`readyz`/`readiness` segment is silent even when it also names
 * a liveness segment (`/health/ready`) — readiness takes precedence.
 */
const READINESS_SEGMENTS = new Set(["ready", "readyz", "readiness"]);

const isReadinessPath = (path: string): boolean => pathSegments(path).some((s) => READINESS_SEGMENTS.has(s));
const isLivenessPath = (path: string): boolean => pathSegments(path).some((s) => LIVENESS_SEGMENTS.has(s));

/** Global network entry points that issue an outbound request. */
const NETWORK_GLOBALS = new Set(["fetch", "axios", "got"]);

/** `http`/`https` methods that issue an outbound request. */
const HTTP_REQUEST_METHODS = new Set(["request", "get"]);

/** Networked-store methods that reach across the network — `.ping`/`.get`/`.set`. */
const REDIS_CACHE_METHODS = new Set(["ping", "get", "set"]);

// NETWORKED stores only. A bare `cache` is deliberately NOT here: an in-process
// cache (an LRU, a Map, `node-cache`) is a local read with no network hop, so it
// cannot cause the cascading failure this rule is about — flagging `cache.get` on a
// liveness probe would be a false positive. Only stores that are genuinely a network
// dependency (redis/memcached) qualify.
const REDIS_CACHE_HINTS = ["redis", "ioredis", "memcache", "memcached"];

/**
 * Segment-aware db-receiver test — the exact shape used by no-query-in-loop.
 * Short hints (`db`, `em`) must match a whole dotted segment; longer hints may
 * match a sub-segment (`orderRepo` → `repo`).
 */
const isDbReceiver = (receiver: string): boolean => {
  const segments = receiver.split(".").map((s) => s.toLowerCase());
  for (const seg of segments) {
    for (const hint of DB_RECEIVER_HINTS) {
      if (hint.length < 4) {
        if (seg === hint) return true;
      } else if (seg.includes(hint)) {
        return true;
      }
    }
  }
  return false;
};

/** A redis/cache receiver — any dotted segment names a redis client or cache. */
const isRedisCacheReceiver = (receiver: string): boolean => {
  const segments = receiver.split(".").map((s) => s.toLowerCase());
  return segments.some((seg) => REDIS_CACHE_HINTS.some((hint) => seg.includes(hint)));
};

/** A QUERY_METHODS call on a db-shaped receiver. */
const isDbQueryCall = (call: AstNode): boolean => {
  const method = getMethodName(call);
  if (!method || !QUERY_METHODS.has(method)) return false;
  const receiver = getReceiverName(call);
  return !!receiver && isDbReceiver(receiver);
};

/** `fetch(...)`, `axios(...)`/`axios.get(...)`, `got(...)`, `http(s).request/get(...)`. */
const isOutboundNetworkCall = (call: AstNode): boolean => {
  const root = rootObjectName(call.callee);
  if (root && NETWORK_GLOBALS.has(root)) return true;
  if (root === "http" || root === "https") {
    const method = getMethodName(call);
    return !!method && HTTP_REQUEST_METHODS.has(method);
  }
  return false;
};

/** `.ping`/`.get`/`.set` on a redis/cache-shaped receiver. */
const isRedisCacheCall = (call: AstNode): boolean => {
  const method = getMethodName(call);
  if (!method || !REDIS_CACHE_METHODS.has(method)) return false;
  const receiver = getReceiverName(call);
  return !!receiver && isRedisCacheReceiver(receiver);
};

/** Any of the three downstream-dependency shapes. */
const isDependencyCall = (n: AstNode): boolean =>
  n.type === "CallExpression" &&
  (isDbQueryCall(n) || isOutboundNetworkCall(n) || isRedisCacheCall(n));

/** A human label for the dependency call, e.g. "db.query" or "fetch". */
const dependencyLabel = (call: AstNode): string =>
  getCalleeName(call) ?? getMethodName(call) ?? "a dependency call";

export const noLivenessCheckWithDependency = defineDiagnostic({
  id: "no-liveness-check-with-dependency",
  title: "Liveness probe checks a downstream dependency",
  severity: "warn",
  category: "Reliability",
  confidence: "high",
  tags: ["reliability"],
  defaultEnabled: false,
  scope: "file",
  recommendation:
    "Keep the liveness probe trivial — return 200 without touching any dependency, so it only proves the process is alive. Move the DB/HTTP/Redis check to a separate readiness endpoint (`/readyz`): a failing readiness probe pulls the pod out of rotation instead of restarting it, so a shared-dependency blip degrades capacity gracefully rather than restarting the whole fleet.",
  create: (ctx) => {
    // A handler can be registered on more than one path; report it once.
    const scanned = new Set<AstNode>();

    /** Pull handler function nodes out of a registration argument. */
    const collectHandlers = (arg: AstNode | null | undefined, out: AstNode[]): void => {
      if (!arg) return;
      if (isFunctionLike(arg)) {
        out.push(arg);
        return;
      }
      // Wrapper call — `asyncHandler(fn)` — and middleware arrays.
      if (arg.type === "CallExpression") {
        for (const inner of (arg.arguments as AstNode[]) ?? []) collectHandlers(inner, out);
        return;
      }
      if (arg.type === "ArrayExpression") {
        for (const el of (arg.elements as (AstNode | null)[]) ?? []) collectHandlers(el, out);
        return;
      }
      if (arg.type === "Identifier") {
        const binding = ctx.scope.getBinding(arg.name, arg);
        if (binding && binding.initNode && isFunctionLike(binding.initNode)) out.push(binding.initNode);
      }
    };

    /**
     * The first downstream-dependency call in the handler's OWN body, in source
     * order (nested functions pruned), or null. `includeSelf` handles an arrow
     * whose expression body IS the dependency call.
     */
    const findDependencyCall = (handler: AstNode): AstNode | null => {
      const body = handler.body as AstNode | undefined;
      if (!body) return null;
      const matches = collectDescendants(body, isDependencyCall, isFunctionLike, true);
      return matches[0] ?? null;
    };

    return {
      CallExpression: (node) => {
        if (getMethodName(node) !== "get") return;
        const args = (node.arguments as AstNode[]) ?? [];
        // `.get(path, handler)` — a real route registration has at least a path
        // and a handler, which keeps `map.get(key)` / `params.get(k)` out.
        if (args.length < 2) return;

        const path = getStaticStringValue(args[0]);
        if (!path) return;
        // Readiness SHOULD check dependencies — silent, even for `/health/ready`.
        if (isReadinessPath(path)) return;
        if (!isLivenessPath(path)) return;

        const handlers: AstNode[] = [];
        for (const arg of args.slice(1)) collectHandlers(arg, handlers);

        for (const handler of handlers) {
          if (scanned.has(handler)) continue;
          scanned.add(handler);
          const dependency = findDependencyCall(handler);
          if (!dependency) continue;
          ctx.report(
            dependency,
            `this liveness probe (\`GET ${path}\`) checks a downstream dependency (\`${dependencyLabel(dependency)}\`) — when that dependency is slow or down, every pod reports unhealthy and the orchestrator restarts the whole fleet, turning one dependency failure into a total outage. A liveness probe should only confirm the process is alive; move dependency checks to a separate readiness endpoint.`,
          );
        }
      },
    };
  },
});
