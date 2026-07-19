import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getCalleeName, getMethodName, isFunctionLike, unwrapChain } from "../../core/ast.ts";
import { findDescendant } from "../../core/walk.ts";

/**
 * `Promise.all` (or allSettled/race/any) over `collection.map(asyncFn)` with no
 * concurrency limit. This opens one connection *per element* simultaneously. On
 * a caller-supplied collection it is a self-inflicted DoS — socket exhaustion,
 * pool starvation, or an upstream rate-limit ban.
 *
 * ❌ await Promise.all(restaurants.map((r) => fetch(`.../${r.id}`)));
 * ✅ const limit = pLimit(5);
 *    await Promise.all(restaurants.map((r) => limit(() => fetch(`.../${r.id}`))));
 * ✅ await Promise.all([fetchA(), fetchB()]);  // literal, known-small
 */

const COMBINATORS = new Set(["Promise.all", "Promise.allSettled", "Promise.race", "Promise.any"]);
const LIMITER_RE = /(limit|semaphore|throttle|pqueue|pmap|pall|bottleneck|maplimit)/i;

const usesConcurrencyLimiter = (mapper: AstNode): boolean =>
  findDescendant(mapper, (n) => {
    if (n.type !== "CallExpression") return false;
    const name = getCalleeName(n) ?? getMethodName(n) ?? "";
    return LIMITER_RE.test(name);
  }) !== null;

export const noUnboundedPromiseAll = defineDiagnostic({
  id: "no-unbounded-promise-all",
  title: "Unbounded Promise.all over a mapped collection",
  severity: "warn",
  category: "Reliability",
  tags: ["async", "concurrency", "network"],
  recommendation:
    "Bound the fan-out instead of removing the parallelism: wrap each task with a concurrency limiter (`p-limit`), e.g. `collection.map((x) => limit(() => work(x)))`, so at most N run at once.",
  create: (ctx) => ({
    CallExpression: (node) => {
      const callee = getCalleeName(node);
      if (!callee || !COMBINATORS.has(callee)) return;

      const arg0 = (node.arguments as AstNode[])[0];
      if (!arg0 || arg0.type !== "CallExpression" || getMethodName(arg0) !== "map") return;

      const mapCallee = unwrapChain(arg0.callee);
      if (!mapCallee || mapCallee.type !== "MemberExpression") return;
      const collection = mapCallee.object as AstNode;
      // A literal array is known-small and fine.
      if (collection.type === "ArrayExpression") return;

      const mapper = (arg0.arguments as AstNode[])[0];
      if (!isFunctionLike(mapper)) return;

      // The mapper must actually produce async work (async keyword or a call).
      // An arrow's expression body may itself be the call, so test it inclusively.
      const body = (mapper.body ?? mapper) as AstNode;
      const producesWork =
        mapper.async ||
        body.type === "CallExpression" ||
        findDescendant(body, (n) => n.type === "CallExpression", isFunctionLike) !== null;
      if (!producesWork) return;

      if (usesConcurrencyLimiter(mapper)) return;

      ctx.report(
        node,
        "`Promise.all` over a mapped collection opens one operation per element with no concurrency limit — an unbounded fan-out on caller-sized input.",
      );
    },
  }),
});
