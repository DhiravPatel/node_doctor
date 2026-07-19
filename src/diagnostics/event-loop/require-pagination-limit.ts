import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, getReceiverName } from "../../core/ast.ts";
import { DB_RECEIVER_HINTS } from "../../core/signals.ts";
import { findDescendant } from "../../core/walk.ts";

/**
 * A Prisma-style `findMany({...})` with no `take`/`limit` — an unbounded result
 * set. As the table grows, a query that returned 10 rows in development returns
 * 10 million in production: it drains the connection pool, balloons memory
 * serializing the result, and stalls the event loop stringifying it. A bounded
 * page (`take`) keeps the cost flat regardless of table size.
 *
 * ❌ const users = await prisma.user.findMany({ where: { active: true } });
 * ✅ const users = await prisma.user.findMany({ where: { active: true }, take: 50 });
 * ✅ const rows = items.findMany();   // non-db receiver → not our concern
 */

/** Segment-aware db-receiver test — short hints require a whole-segment match. */
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

/** A `take:`/`limit:` property (identifier or string key), anywhere in the options. */
const isBoundProp = (n: AstNode): boolean => {
  if (n.type !== "Property") return false;
  const key = n.key;
  if (!n.computed && key?.type === "Identifier" && (key.name === "take" || key.name === "limit")) {
    return true;
  }
  if (key?.type === "Literal" && (key.value === "take" || key.value === "limit")) return true;
  return false;
};

export const requirePaginationLimit = defineDiagnostic({
  id: "require-pagination-limit",
  title: "Unbounded findMany without a take/limit",
  severity: "warn",
  category: "Performance",
  tags: ["db", "performance"],
  requires: ["prisma"],
  recommendation:
    "Always pass a `take` (or SQL `LIMIT`) and paginate with a cursor/offset. An unbounded `findMany` grows with the table and eventually drains the pool, the heap, and the event loop.",
  create: (ctx) => ({
    CallExpression: (node) => {
      if (getMethodName(node) !== "findMany") return;

      const receiver = getReceiverName(node);
      if (!receiver || !isDbReceiver(receiver)) return;

      // No options object at all → not enough signal to flag precisely.
      const arg0 = (node.arguments as AstNode[])[0];
      if (!arg0 || arg0.type !== "ObjectExpression") return;

      // A `take`/`limit` anywhere in the options means it is already bounded.
      if (findDescendant(arg0, isBoundProp) !== null) return;

      ctx.report(
        node,
        "`findMany` has no `take`/`limit` — the result set is unbounded and grows with the table.",
      );
    },
  }),
});
