import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getCalleeName, isFunctionLike } from "../../core/ast.ts";

/**
 * An `async` function passed as the executor of `new Promise(...)`.
 *
 * Why it matters: the Promise constructor ignores its executor's return value,
 * so it also ignores the promise an async executor returns — including its
 * rejection. Any error thrown *after the first `await`* rejects that ignored
 * promise, not the one you constructed, which then hangs unresolved forever (or
 * surfaces as an unhandledRejection). The executor's `resolve`/`reject` are the
 * only channel out, and a post-await throw bypasses them.
 *
 * ❌ new Promise(async (resolve, reject) => { const x = await load(); resolve(x); });
 * ✅ new Promise((resolve, reject) => { load().then(resolve, reject); });
 * ✅ (async () => { try { ... } catch (e) { ... } })();  // async IIFE, not an executor
 */
export const noAsyncExecutor = defineDiagnostic({
  id: "no-async-executor",
  title: "Async function passed as a Promise executor",
  severity: "error",
  category: "Bugs",
  tags: ["async"],
  recommendation:
    "Keep the executor synchronous and do the async work inside with explicit `resolve`/`reject` (`new Promise((resolve, reject) => { work().then(resolve, reject); })`), or drop the constructor and use an async IIFE wrapped in try/catch.",
  create: (ctx) => ({
    NewExpression: (node) => {
      if (getCalleeName(node) !== "Promise") return;
      const executor = (node.arguments as AstNode[])?.[0];
      if (!isFunctionLike(executor) || !executor.async) return;
      ctx.report(
        executor,
        "Async function used as a Promise executor — the constructor ignores the returned promise, so any rejection thrown after the first `await` is swallowed and the Promise never settles.",
      );
    },
  }),
});
