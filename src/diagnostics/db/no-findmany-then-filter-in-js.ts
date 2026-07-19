import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, getReceiverName, getPropertyValue } from "../../core/ast.ts";
import { DB_RECEIVER_HINTS } from "../../core/signals.ts";

/**
 * A db `findMany()`/`find()` with no `where`, whose full result set is then
 * filtered in JavaScript.
 *
 * Why it matters: `(await db.user.findMany()).filter(u => u.active)` drags every
 * row across the wire and into process memory, then throws most of them away.
 * The predicate belongs in the query's `where` so the database (which has the
 * indexes) does the selection and returns only the rows you keep. As the table
 * grows this quietly turns an O(1) indexed lookup into a full-table scan plus a
 * large allocation on every request.
 *
 * ❌ const active = (await db.user.findMany()).filter((u) => u.active);
 * ✅ const active = await db.user.findMany({ where: { active: true } });
 * ✅ const recent = items.filter((i) => i.fresh);  // plain array, not a query
 *
 * Fires when: `.filter(...)` is called directly on a db `findMany`/`find` call
 * that carries no `where` argument.
 * Stays silent when: a `where` is present, or the receiver is not db-shaped.
 */

/** Segment-aware db-receiver test (short hints require a whole-segment match). */
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

/** Unwrap `await x` / optional-chain / `x!` down to the underlying expression. */
const unwrap = (node: AstNode | null | undefined): AstNode | null => {
  let cur = node ?? null;
  while (cur) {
    if (cur.type === "AwaitExpression") {
      cur = cur.argument;
      continue;
    }
    if (cur.type === "ChainExpression") {
      cur = cur.expression;
      continue;
    }
    if (cur.type === "TSNonNullExpression" || cur.type === "ParenthesizedExpression") {
      cur = cur.expression;
      continue;
    }
    return cur;
  }
  return null;
};

const FETCH_ALL_METHODS = new Set(["findMany", "find"]);

export const noFindmanyThenFilterInJs = defineDiagnostic({
  id: "no-findmany-then-filter-in-js",
  title: "Fetch-all then filter in JavaScript",
  severity: "warn",
  category: "Performance",
  tags: ["db", "performance"],
  recommendation:
    "Move the predicate into the query's `where` (e.g. `db.user.findMany({ where: { active: true } })`) so the database returns only the rows you keep instead of streaming the whole table into JS.",
  create: (ctx) => ({
    CallExpression: (node) => {
      // Must be `<something>.filter(...)`.
      if (getMethodName(node) !== "filter") return;
      const callee = node.callee as AstNode;
      if (callee?.type !== "MemberExpression") return;

      // A JS `.filter` predicate must actually be supplied.
      if (((node.arguments as AstNode[]) ?? []).length === 0) return;

      // The object of `.filter` must be a (possibly awaited) db fetch-all call.
      const inner = unwrap(callee.object);
      if (!inner || inner.type !== "CallExpression") return;

      const queryMethod = getMethodName(inner);
      if (!queryMethod || !FETCH_ALL_METHODS.has(queryMethod)) return;

      const receiver = getReceiverName(inner);
      if (!receiver || !isDbReceiver(receiver)) return;

      // Silent when the query already narrows with a `where`.
      const arg0 = (inner.arguments as AstNode[])[0];
      if (arg0 && arg0.type === "ObjectExpression" && getPropertyValue(arg0, "where")) return;

      ctx.report(
        node,
        `\`${queryMethod}()\` fetches every row and the result is filtered in JavaScript — push the predicate into the query's \`where\` so the database returns only the matching rows.`,
      );
    },
  }),
});
