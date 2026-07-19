import { defineDiagnostic } from "../../core/types.ts";
import { containsTryStatement, isResultDiscarded, unwrapChain } from "../../core/ast.ts";

/**
 * An immediately-invoked async function expression whose result is floated —
 * neither awaited, nor chained with `.catch(...)`, nor guarded by a `try` inside
 * its body.
 *
 * Why it matters: an async IIFE returns a promise. When that promise is
 * discarded, a rejection inside the body has nowhere to go — it becomes an
 * unhandledRejection, which on modern Node crashes the process by default. IIFEs
 * are the usual way to run async work from a synchronous scope (module top level,
 * an event listener), exactly where there is no caller to catch for you.
 *
 * A chained `.catch(...)` makes the inner call the object of a MemberExpression
 * (so its result is no longer discarded) and is therefore naturally not flagged;
 * an awaited IIFE propagates to its caller and is skipped too.
 *
 * ❌ (async () => { await migrate(); })();
 * ✅ (async () => { await migrate(); })().catch((err) => log.error(err));
 * ✅ (async () => { try { await migrate(); } catch (err) { log.error(err); } })();
 */
export const noMissingCatchOnAsyncIife = defineDiagnostic({
  id: "no-missing-catch-on-async-iife",
  title: "Async IIFE with no error handling",
  severity: "warn",
  category: "Reliability",
  tags: ["async", "lifecycle"],
  recommendation:
    "Attach a `.catch(err => ...)` to the invocation, or wrap the whole body in a `try/catch`. A floating async IIFE turns any rejection into an unhandledRejection, which crashes the process by default.",
  create: (ctx) => ({
    CallExpression: (node) => {
      const callee = unwrapChain(node.callee);
      if (!callee || !callee.async) return;
      if (callee.type !== "FunctionExpression" && callee.type !== "ArrowFunctionExpression") return;
      // Awaited IIFEs propagate to their caller; only floated ones are unhandled.
      if (node.parent?.type === "AwaitExpression") return;
      if (!isResultDiscarded(node)) return;
      // A try inside the body already contains the rejection.
      if (containsTryStatement(callee)) return;
      ctx.report(
        callee,
        "Async IIFE result is discarded with no `.catch(...)` and no `try` inside — a rejection here becomes an unhandledRejection.",
      );
    },
  }),
});
