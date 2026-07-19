import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, getReceiverName } from "../../core/ast.ts";
import { QUERY_METHODS, DB_RECEIVER_HINTS } from "../../core/signals.ts";

/**
 * A db-shaped query used as a bare statement — never awaited, returned, chained,
 * or assigned. The promise (and any rejection it carries) floats.
 *
 * Why it matters: `db.user.update({ ... })` written as its own statement returns
 * a promise that nothing consumes. The write may still be in flight when the
 * handler responds, ordering guarantees are gone, and a rejection becomes an
 * unhandledRejection that can crash the process instead of being caught. The fix
 * is one keyword: `await` it (or `return` its promise).
 *
 * ❌ db.user.update({ where: { id }, data: { seen: true } });   // floating
 * ✅ await db.user.update({ where: { id }, data: { seen: true } });
 * ✅ return db.user.create({ data });
 * ✅ db.user.create({ data }).catch(next);   // chained
 *
 * Fires when: a `QUERY_METHODS` call on a db-shaped receiver is a standalone
 * ExpressionStatement.
 * Stays silent when: awaited, returned, chained, assigned, or voided.
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

export const noMissingAwaitOnQuery = defineDiagnostic({
  id: "no-missing-await-on-query",
  title: "Floating database query (missing await)",
  severity: "error",
  category: "Bugs",
  tags: ["db", "async"],
  recommendation:
    "`await` the query (or `return` its promise, or chain `.then`/`.catch`). A bare query statement floats its promise: the write may not finish before you respond and a rejection becomes an unhandledRejection.",
  create: (ctx) => ({
    CallExpression: (node) => {
      const method = getMethodName(node);
      if (!method || !QUERY_METHODS.has(method)) return;

      const receiver = getReceiverName(node);
      if (!receiver || !isDbReceiver(receiver)) return;

      // Determine how the call's value is used. Skip a wrapping optional chain.
      let value: AstNode = node;
      let parent = node.parent as AstNode | null | undefined;
      if (parent?.type === "ChainExpression") {
        value = parent;
        parent = parent.parent;
      }
      if (!parent) return;

      // Floating only when the call *is* the whole expression statement — i.e.
      // not awaited (AwaitExpression), returned (ReturnStatement/arrow body),
      // assigned (VariableDeclarator/AssignmentExpression), chained (its parent
      // would be a MemberExpression), or voided (UnaryExpression).
      if (parent.type !== "ExpressionStatement" || parent.expression !== value) return;

      ctx.report(
        node,
        `\`${method}()\` is a floating query — its promise is never awaited, returned, or chained, so the write may not finish and a rejection goes unhandled.`,
      );
    },
  }),
});
