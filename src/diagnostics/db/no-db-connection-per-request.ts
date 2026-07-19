import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, getReceiverName } from "../../core/ast.ts";
import { isOnRequestPath } from "../../core/request-path.ts";

/**
 * A database client, pool, or connection constructed on the request path.
 *
 * Why it matters: a client/pool is meant to be a long-lived, shared singleton
 * that owns a bounded set of TCP connections. Constructing a fresh one inside a
 * handler means every request opens (and usually leaks) a new connection —
 * within seconds the database's `max_connections` is exhausted and every query,
 * including the health check, starts failing. The exact same constructor at
 * module scope is the correct one-time cost. Position flips the verdict.
 *
 * ❌ app.post("/u", (req, res) => { const db = new PrismaClient(); ... })
 * ❌ router.get("/x", async (req, res) => { const pool = new Pool(cfg); ... })
 * ✅ const prisma = new PrismaClient();  // module scope, reused per request
 * ✅ app.post("/u", (req, res) => prisma.user.create({ data: req.body }));
 *
 * Fires when: a client/pool constructor or connect() call is on a request path.
 * Stays silent when: the construction is at module scope or a non-handler.
 */

/** Constructor names that create a DB client/pool holding connections. */
const CLIENT_CTORS = new Set(["PrismaClient", "Pool", "Client"]);

/** Factory functions that create a DB pool/connection. */
const CLIENT_FACTORIES = new Set(["createPool", "createConnection"]);

export const noDbConnectionPerRequest = defineDiagnostic({
  id: "no-db-connection-per-request",
  title: "Database client/pool constructed inside a handler",
  severity: "error",
  category: "Performance",
  tags: ["db", "performance"],
  recommendation:
    "Construct the client/pool once at module scope and reuse the singleton across requests (e.g. `const prisma = new PrismaClient();`). A per-request client opens a new connection every time and exhausts the pool.",
  create: (ctx) => {
    const flag = (node: AstNode, what: string): void => {
      if (!isOnRequestPath(node, ctx.requestHandlers)) return;
      ctx.report(
        node,
        `${what} is constructed on the request path — a new database connection per request exhausts the pool. Build it once at module scope and reuse it.`,
      );
    };

    return {
      NewExpression: (node) => {
        const ctor = getMethodName(node);
        if (!ctor || !CLIENT_CTORS.has(ctor)) return;
        flag(node, `\`new ${ctor}()\``);
      },
      CallExpression: (node) => {
        const method = getMethodName(node);
        if (!method) return;
        if (CLIENT_FACTORIES.has(method)) {
          flag(node, `\`${method}()\``);
          return;
        }
        // mongoose.connect(...) — opening the shared connection per request.
        if (method === "connect" && getReceiverName(node) === "mongoose") {
          flag(node, "`mongoose.connect()`");
        }
      },
    };
  },
});
