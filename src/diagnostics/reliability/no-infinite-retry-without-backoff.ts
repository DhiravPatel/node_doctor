import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, isFunctionLike, isLiteralTrue } from "../../core/ast.ts";
import { findDescendant } from "../../core/walk.ts";

/**
 * A `while (true)` / `for (;;)` retry loop that awaits an operation and
 * `continue`s on failure, but has no delay and no attempt cap. When the
 * dependency is down, this becomes a tight, un-throttled retry storm: it pins a
 * CPU core, hammers the failing service (making its recovery harder), and never
 * gives up. A correct retry uses exponential backoff and a maximum attempt count.
 *
 * Opt-in (defaultEnabled:false): loop-shape inference is heuristic. It fires only
 * on the clear shape — infinite loop + await + try + continue, with NO delay call
 * and NO counter/update anywhere in the loop.
 *
 * ❌ while (true) { try { return await call(); } catch (e) { continue; } }
 * ✅ while (true) { try { return await call(); } catch (e) { await sleep(backoff()); } }
 * ✅ for (let n = 0; n < 5; n++) { try { return await call(); } catch (e) {} }  // bounded
 */

// Calls that introduce a delay / backoff between attempts.
const DELAY_CALLS = new Set(["setTimeout", "setImmediate", "delay", "sleep", "wait", "backoff", "pause"]);

const isTruthyLoopTest = (test: AstNode | null | undefined): boolean =>
  !!test && (isLiteralTrue(test) || (test.type === "Literal" && test.value === 1));

export const noInfiniteRetryWithoutBackoff = defineDiagnostic({
  id: "no-infinite-retry-without-backoff",
  title: "Retry loop without backoff",
  severity: "warn",
  category: "Reliability",
  tags: ["reliability"],
  defaultEnabled: false,
  recommendation:
    "Add exponential backoff between attempts (`await sleep(base * 2 ** attempt)`) and a maximum-attempt cap so a downed dependency does not trigger a tight retry storm.",
  create: (ctx) => {
    const isDelayCall = (n: AstNode): boolean =>
      n.type === "CallExpression" && (() => { const m = getMethodName(n); return !!m && DELAY_CALLS.has(m); })();

    const isCounter = (n: AstNode): boolean =>
      n.type === "UpdateExpression" ||
      (n.type === "AssignmentExpression" && (n.operator === "+=" || n.operator === "-="));

    const check = (node: AstNode): void => {
      const body = node.body as AstNode | undefined;
      if (!body) return;

      // The loop's own control flow must contain an awaited call and a continue.
      const hasAwait = findDescendant(body, (n) => n.type === "AwaitExpression", isFunctionLike);
      if (!hasAwait) return;
      const hasContinue = findDescendant(body, (n) => n.type === "ContinueStatement", isFunctionLike);
      if (!hasContinue) return;
      const hasTry = findDescendant(body, (n) => n.type === "TryStatement", isFunctionLike);
      if (!hasTry) return; // retry-on-error shape

      // Silent if a delay/backoff exists (may be inside `new Promise(r => setTimeout)`,
      // so do NOT skip nested functions here).
      if (findDescendant(node, isDelayCall)) return;
      // Silent if any counter/update exists — likely a max-attempt bound.
      if (findDescendant(node, isCounter)) return;

      ctx.report(
        node,
        "Infinite retry loop awaits and `continue`s on error with no delay and no attempt cap — a downed dependency turns this into a tight retry storm that pins the CPU.",
      );
    };

    return {
      WhileStatement: (node) => {
        if (isTruthyLoopTest(node.test as AstNode)) check(node);
      },
      ForStatement: (node) => {
        // `for (;;)` — no test at all.
        if (node.test == null) check(node);
      },
    };
  },
});
