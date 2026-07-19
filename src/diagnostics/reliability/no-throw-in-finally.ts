import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { isFunctionLike } from "../../core/ast.ts";

/**
 * A `throw` or `return` inside a `finally` block. `finally` runs during the
 * completion of the `try`/`catch`, so an abrupt completion here (throw/return)
 * *replaces* whatever the try or catch was doing — the original error is
 * swallowed and lost, or a real return value is silently overwritten. This is one
 * of the most reliable ways to make an exception vanish without a trace.
 *
 * ❌ try { return await work(); } finally { return cleanup(); }  // masks work()'s result/throw
 * ❌ try { risky(); } catch (e) { throw e; } finally { throw new Error("cleanup"); }
 * ✅ try { return await work(); } finally { await cleanup(); }   // finally has no abrupt completion
 * ✅ try { ... } finally { arr.forEach(() => { return; }); }     // return is in a nested fn, not finally
 */

const isThrowOrReturn = (t: string): boolean => t === "ThrowStatement" || t === "ReturnStatement";

export const noThrowInFinally = defineDiagnostic({
  id: "no-throw-in-finally",
  title: "throw or return inside a finally block",
  severity: "warn",
  category: "Bugs",
  tags: ["error-handling"],
  recommendation:
    "Do not `throw` or `return` from `finally`; let the original completion of the try/catch propagate. Do side-effect cleanup (e.g. `await cleanup()`) there instead.",
  create: (ctx) => {
    const check = (node: AstNode): void => {
      let child: AstNode = node;
      let cur: AstNode | null | undefined = node.parent;
      while (cur) {
        // Crossing a function boundary: a return/throw in a nested function
        // completes that function, not the finally — not our case.
        if (isFunctionLike(cur)) return;
        if (cur.type === "TryStatement") {
          // The first enclosing try decides: fire only if we reached it through
          // its finalizer branch (the throw/return lives in the finally block).
          if (cur.finalizer && cur.finalizer === child) {
            const kind = node.type === "ThrowStatement" ? "throw" : "return";
            ctx.report(
              node,
              `\`${kind}\` inside \`finally\` overrides the try/catch completion — it swallows any pending exception or replaces the return value.`,
            );
          }
          return;
        }
        child = cur;
        cur = cur.parent;
      }
    };

    return {
      ThrowStatement: (node) => {
        if (isThrowOrReturn(node.type)) check(node);
      },
      ReturnStatement: (node) => {
        if (isThrowOrReturn(node.type)) check(node);
      },
    };
  },
});
