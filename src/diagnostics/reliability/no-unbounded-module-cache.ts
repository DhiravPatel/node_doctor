import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getCalleeName } from "../../core/ast.ts";
import { isModuleScopePosition } from "../../core/request-path.ts";
import { collectDescendants } from "../../core/walk.ts";

/**
 * A module-scope `Map`/`Set` that is written but never evicted. A cache that is
 * only ever written to is a memory leak with a friendly name: it survives every
 * request, grows forever, and the pod OOMs at 3am. A real cache has an eviction
 * story — a TTL sweep, a max size, or an explicit delete.
 *
 * ❌ const sessionCache = new Map(); function remember(t, u) { sessionCache.set(t, u); }
 * ✅ setInterval(() => sessionCache.clear(), 60_000);
 * ✅ const cache = new LRUCache({ max: 10_000 });   // bounded, not a bare Map
 * ✅ const cache = new WeakMap();                    // self-evicting
 * ✅ function group(items) { const m = new Map(); ...; return m; }  // function-scoped
 */

const WRITE_METHODS = new Set(["set", "add", "push"]);
const EVICT_METHODS = new Set(["delete", "clear", "evict", "prune", "expire", "reset", "pop", "shift", "splice"]);

export const noUnboundedModuleCache = defineDiagnostic({
  id: "no-unbounded-module-cache",
  title: "Module-scope cache with no eviction",
  severity: "warn",
  category: "Reliability",
  tags: ["memory", "lifecycle"],
  recommendation:
    "Give the cache an eviction story: a TTL sweep (`setInterval(() => cache.clear(), ...)`), a bounded `LRUCache({ max })`, or a `WeakMap` that self-evicts. A write-only module-scope Map/Set grows without bound.",
  create: (ctx) => {
    const caches = new Map<string, AstNode>(); // name → id node of the declaration

    return {
      VariableDeclarator: (node) => {
        if (node.id?.type !== "Identifier") return;
        if (!isModuleScopePosition(node)) return;
        const init = node.init as AstNode | null;
        if (!init || init.type !== "NewExpression") return;
        const ctor = getCalleeName(init);
        if (ctor !== "Map" && ctor !== "Set") return; // WeakMap/WeakSet/LRUCache excluded
        caches.set(node.id.name, node.id);
      },

      "Program:exit": () => {
        if (caches.size === 0) return;

        const writes = new Set<string>();
        const evicts = new Set<string>();
        const calls = collectDescendants(
          ctx.program,
          (n) =>
            n.type === "CallExpression" &&
            n.callee?.type === "MemberExpression" &&
            n.callee.object?.type === "Identifier" &&
            n.callee.property?.type === "Identifier",
        );
        for (const call of calls) {
          const obj = call.callee.object.name as string;
          const method = call.callee.property.name as string;
          if (WRITE_METHODS.has(method)) writes.add(obj);
          if (EVICT_METHODS.has(method)) evicts.add(obj);
        }

        for (const [name, idNode] of caches) {
          if (writes.has(name) && !evicts.has(name)) {
            ctx.report(
              idNode,
              `Module-scope \`${name}\` is written but never evicted — it grows without bound and eventually OOMs the process.`,
            );
          }
        }
      },
    };
  },
});
