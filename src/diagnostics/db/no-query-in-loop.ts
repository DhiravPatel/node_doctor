import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, getReceiverName, isFunctionLike } from "../../core/ast.ts";
import { QUERY_METHODS, DB_RECEIVER_HINTS } from "../../core/signals.ts";

/**
 * A database query inside a loop — the N+1. One query to list, then one query
 * per row: N round trips inside a single request, each holding a pool
 * connection. Invisible with five rows, catastrophic with five thousand.
 *
 * Uses *segment-aware* receiver matching to avoid the historical FP where the
 * token `em` (TypeORM's EntityManager) matched inside "it-em-s" and flagged
 * `items.find()`. Short hints must match a whole segment; longer hints may match
 * a sub-segment (`orderRepo` → `repo`).
 *
 * ❌ for (const o of orders) { o.items = await db.orderItem.findMany({ where: { orderId: o.id } }); }
 * ✅ const orders = await db.order.findMany({ include: { items: true } });
 * ✅ for (const o of orders) { const m = lookupTable.find((r) => r.id === o.id); }  // Array.find
 */

const LOOP_TYPES = new Set([
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
]);

/** Segment-aware db-receiver test. Short hints require an exact segment match. */
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

/** The nearest enclosing loop, but stop at a function boundary. */
const enclosingLoopInSameFunction = (node: AstNode): AstNode | null => {
  let cur: AstNode | null | undefined = node.parent;
  while (cur) {
    if (isFunctionLike(cur)) return null; // crossed into a nested function
    if (LOOP_TYPES.has(cur.type)) return cur;
    cur = cur.parent;
  }
  return null;
};

export const noQueryInLoop = defineDiagnostic({
  id: "no-query-in-loop",
  title: "Database query inside a loop (N+1)",
  severity: "error",
  category: "Performance",
  tags: ["db", "n+1", "performance"],
  recommendation:
    "Fetch the set in one round trip: a JOIN, a `WHERE id IN (...)`, or the ORM's eager-load (`include` / `with` / `populate`). A query per iteration is N round trips for one request.",
  create: (ctx) => ({
    CallExpression: (node) => {
      const method = getMethodName(node);
      if (!method || !QUERY_METHODS.has(method)) return;

      const receiver = getReceiverName(node);
      if (!receiver || !isDbReceiver(receiver)) return;

      if (!enclosingLoopInSameFunction(node)) return;

      ctx.report(
        node,
        "A database query runs once per loop iteration — N round trips for one request. Batch it into a single query.",
      );
    },
  }),
});
