import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, getStaticStringValue, findEnclosingFunction } from "../../core/ast.ts";
import { findDescendant } from "../../core/walk.ts";

/**
 * `a.pipe(b)` with no error handler anywhere near it. `.pipe()` does NOT forward
 * errors: if the source or destination emits `'error'` and nothing is listening,
 * the error becomes an `uncaughtException` and crashes the whole process (taking
 * every other in-flight request with it). `stream.pipeline(...)` forwards errors
 * to a single callback and cleans up dangling streams; a bare `.pipe()` needs an
 * explicit `.on('error', ...)` on each stream.
 *
 * ❌ fs.createReadStream(path).pipe(res);
 * ✅ pipeline(fs.createReadStream(path), res, (err) => { if (err) next(err); });
 * ✅ const rs = fs.createReadStream(path); rs.on("error", next); rs.pipe(res);
 */

// RxJS/Observable operator names — `obs.pipe(map(...))` is not a stream pipe.
const RXJS_OPERATORS = new Set([
  "map", "filter", "tap", "catchError", "switchMap", "mergeMap", "concatMap",
  "exhaustMap", "take", "takeUntil", "takeWhile", "skip", "debounceTime",
  "throttleTime", "distinctUntilChanged", "startWith", "scan", "reduce",
  "retry", "retryWhen", "finalize", "share", "shareReplay", "delay", "pluck",
  "first", "last", "mapTo", "withLatestFrom", "combineLatestWith", "mergeAll",
  "toArray", "bufferTime", "auditTime", "sampleTime",
]);

export const noMissingStreamErrorHandler = defineDiagnostic({
  id: "no-missing-stream-error-handler",
  title: "Stream pipe without an error handler",
  severity: "warn",
  category: "Reliability",
  tags: ["lifecycle"],
  recommendation:
    "Use `stream.pipeline(src, dest, cb)` (it forwards errors and cleans up), or attach `.on('error', handler)` to both the source and destination stream.",
  create: (ctx) => {
    const isErrorHandler = (n: AstNode): boolean => {
      if (n.type !== "CallExpression") return false;
      const m = getMethodName(n);
      if (m !== "on" && m !== "once" && m !== "addListener") return false;
      return getStaticStringValue((n.arguments as AstNode[])?.[0]) === "error";
    };
    const isPipeline = (n: AstNode): boolean =>
      n.type === "CallExpression" && getMethodName(n) === "pipeline";

    return {
      CallExpression: (node) => {
        if (getMethodName(node) !== "pipe") return;

        // A stream pipe writes to exactly one destination per call. RxJS pipe
        // typically takes operator calls — exclude a single operator argument.
        const args = (node.arguments as AstNode[]) ?? [];
        if (args.length !== 1) return;
        const dest = args[0];
        if (dest?.type === "CallExpression") {
          const m = getMethodName(dest);
          if (m && RXJS_OPERATORS.has(m)) return; // RxJS observable, not a stream
        }

        // Search the enclosing function (or whole module) for a nearby error
        // handler or a pipeline() usage — either makes this safe.
        const scope = findEnclosingFunction(node) ?? ctx.program;
        const guarded = findDescendant(scope, (n) => isErrorHandler(n) || isPipeline(n));
        if (guarded) return;

        ctx.report(
          node,
          "`.pipe()` does not forward stream errors — an `'error'` with no handler becomes an uncaughtException and crashes the process. Use `stream.pipeline(...)` or attach `.on('error', ...)`.",
        );
      },
    };
  },
});
