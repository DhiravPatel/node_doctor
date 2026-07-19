import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getCalleeName, getMethodName, isFunctionLike, rootObjectName } from "../../core/ast.ts";

/**
 * A network call (`fetch`, `axios.*`, `http(s).request`) lexically inside a
 * database transaction callback.
 *
 * Why it matters: the callback passed to `$transaction`/`transaction`/
 * `withTransaction` runs with a connection checked out and a transaction held
 * open for its whole duration. Awaiting a network round trip inside it pins that
 * pooled connection to the latency (and timeouts) of a third party and keeps row
 * locks held the entire time — a slow upstream turns into lock contention, pool
 * starvation, and deadlocks across otherwise-unrelated requests.
 *
 * ❌ await db.$transaction(async (tx) => {
 *      const o = await tx.order.create({ data });
 *      await fetch(`https://pay/${o.id}`);   // network I/O holding the tx open
 *    });
 * ✅ const o = await db.$transaction((tx) => tx.order.create({ data }));
 *    await fetch(`https://pay/${o.id}`);      // external I/O after commit
 *
 * Fires when: a fetch/axios/http(s).request call sits inside a transaction
 * callback.
 * Stays silent when: only DB work happens inside the transaction.
 */

/** Calls that open a transaction and take a callback of transactional work. */
const TX_METHODS = new Set(["$transaction", "transaction", "withTransaction"]);

/** Is `node` a network/external I/O call? */
const isExternalCall = (node: AstNode): boolean => {
  if (getCalleeName(node) === "fetch") return true;
  const root = rootObjectName(node);
  if (root === "axios") return true; // axios(cfg), axios.get(...), axios.request(...)
  if ((root === "http" || root === "https") && getMethodName(node) === "request") return true;
  return false;
};

/** Is `fn` the callback argument of a transaction-opening call? */
const isTransactionCallback = (fn: AstNode): boolean => {
  const p = fn.parent as AstNode | null | undefined;
  if (!p || p.type !== "CallExpression") return false;
  const args = (p.arguments as AstNode[]) ?? [];
  if (!args.includes(fn)) return false;
  const method = getMethodName(p);
  return !!method && TX_METHODS.has(method);
};

export const noExternalCallInsideOpenTransaction = defineDiagnostic({
  id: "no-external-call-inside-open-transaction",
  title: "Network call inside an open transaction",
  severity: "warn",
  category: "Reliability",
  tags: ["db", "reliability"],
  recommendation:
    "Do the external I/O before the transaction (pass the result in) or after it commits — keep the `$transaction` callback pure DB work. A network round trip inside it pins the connection and holds row locks for the upstream's full latency.",
  create: (ctx) => ({
    CallExpression: (node) => {
      if (!isExternalCall(node)) return;

      // Walk enclosing functions outward; fire if any is a transaction callback.
      let cur: AstNode | null | undefined = node.parent;
      while (cur) {
        if (isFunctionLike(cur) && isTransactionCallback(cur)) {
          ctx.report(
            node,
            "A network call runs inside a database transaction callback — it pins the pooled connection and holds row locks for the upstream's full round trip. Move external I/O outside the transaction.",
          );
          return;
        }
        cur = cur.parent;
      }
    },
  }),
});
