import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, isFunctionLike, isResultDiscarded, unwrapChain } from "../../core/ast.ts";

/**
 * An `async` function passed to a synchronous array method. These methods do not
 * await:
 *   - forEach / discarded map → N floating promises (errors vanish, ordering
 *     lost, the surrounding function resolves before the work finishes);
 *   - filter / find / some / every / sort → the returned promise is always
 *     truthy, so the predicate silently matches every element.
 *
 * ❌ users.forEach(async (u) => { await send(u); });
 * ❌ const active = users.filter(async (u) => await isActive(u));
 * ✅ for (const u of users) { await send(u); }
 * ✅ await Promise.all(users.map((u) => send(u)));
 */

const FLOATING = new Set(["forEach"]);
const COERCING = new Set(["filter", "find", "findIndex", "findLast", "findLastIndex", "some", "every", "sort"]);
const MAPPING = new Set(["map", "flatMap"]);

const isArrayMethodCall = (node: AstNode): boolean => {
  const callee = unwrapChain(node.callee);
  return !!callee && callee.type === "MemberExpression";
};

export const noAsyncArrayCallback = defineDiagnostic({
  id: "no-async-array-callback",
  title: "Async callback passed to a synchronous array method",
  severity: "error",
  category: "Bugs",
  tags: ["async", "concurrency"],
  recommendation:
    "Use `for...of` with `await` for sequential work, or `await Promise.all(collection.map(fn))` for parallel work. For an async predicate, resolve first (`const flags = await Promise.all(items.map(pred))`) then filter synchronously.",
  create: (ctx) => ({
    CallExpression: (node) => {
      const method = getMethodName(node);
      if (!method) return;
      if (!isArrayMethodCall(node)) return;

      const callback = (node.arguments as AstNode[])[0];
      if (!isFunctionLike(callback) || !callback.async) return;

      if (FLOATING.has(method)) {
        ctx.report(
          callback,
          `An async callback passed to \`${method}\` is never awaited — its rejections vanish and the surrounding function resolves before the work completes.`,
        );
      } else if (COERCING.has(method)) {
        ctx.report(
          callback,
          `An async callback passed to \`${method}\` returns a promise, which is always truthy — the predicate matches every element.`,
        );
      } else if (MAPPING.has(method) && isResultDiscarded(node)) {
        ctx.report(
          callback,
          `The promise array from an async \`${method}\` is discarded — the work runs unawaited and failures are lost.`,
        );
      }
    },
  }),
});
