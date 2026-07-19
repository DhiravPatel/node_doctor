import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, isResultDiscarded } from "../../core/ast.ts";
import { isModuleScopePosition } from "../../core/request-path.ts";
import { collectDescendants } from "../../core/walk.ts";

/**
 * A `setInterval` at module scope whose handle is never captured, cleared, or
 * `.unref()`'d. An un-`unref`'d interval holds a ref that keeps the event loop
 * (and the process) alive forever — it blocks a clean shutdown and, if the
 * callback closes over growing state, leaks. A real periodic task either stores
 * the handle and `clearInterval`s it on shutdown, or calls `.unref()` so it does
 * not by itself pin the process.
 *
 * ❌ setInterval(() => flush(), 5_000);                 // handle discarded
 * ❌ const t = setInterval(() => flush(), 5_000);       // never cleared / unref'd
 * ✅ const t = setInterval(() => flush(), 5_000); t.unref();
 * ✅ const t = setInterval(() => flush(), 5_000);
 *    process.on("SIGTERM", () => clearInterval(t));
 * ✅ function poll() { setInterval(tick, 1000); }        // inside a function, not module scope
 */
export const noUnclearedModuleInterval = defineDiagnostic({
  id: "no-uncleared-module-interval",
  title: "Module-scope setInterval never cleared",
  severity: "warn",
  category: "Reliability",
  tags: ["lifecycle", "memory"],
  recommendation:
    "Store the handle and `clearInterval(handle)` on shutdown, or call `handle.unref()` so the interval does not by itself keep the process alive.",
  create: (ctx) => {
    const intervals: AstNode[] = [];

    const isInlineUnref = (node: AstNode): boolean => {
      const p = node.parent;
      return (
        !!p &&
        p.type === "MemberExpression" &&
        p.object === node &&
        !p.computed &&
        p.property?.type === "Identifier" &&
        p.property.name === "unref"
      );
    };

    return {
      CallExpression: (node) => {
        if (getMethodName(node) !== "setInterval") return;
        if (!isModuleScopePosition(node)) return;
        intervals.push(node);
      },

      "Program:exit": () => {
        if (intervals.length === 0) return;

        // File-level escape hatches: any clearInterval or any .unref() means the
        // author has a lifecycle story somewhere — favor silence (precision).
        let fileHasClear = false;
        let fileHasUnref = false;
        for (const call of collectDescendants(ctx.program, (n) => n.type === "CallExpression")) {
          const m = getMethodName(call);
          if (m === "clearInterval") fileHasClear = true;
          else if (m === "unref") fileHasUnref = true;
        }

        for (const node of intervals) {
          if (isInlineUnref(node)) continue;

          if (isResultDiscarded(node)) {
            // No handle captured at all — it can never be cleared.
            ctx.report(
              node,
              "Module-scope `setInterval` handle is discarded — it is never cleared or `.unref()`'d, so it keeps the process alive and cannot be stopped on shutdown.",
            );
            continue;
          }

          // Handle is assigned somewhere; only flag if the file neither clears
          // any interval nor unref's anything.
          if (!fileHasClear && !fileHasUnref) {
            ctx.report(
              node,
              "Module-scope `setInterval` is never cleared or `.unref()`'d — it keeps the process alive and blocks a clean shutdown.",
            );
          }
        }
      },
    };
  },
});
