import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";

/**
 * A `try/catch` whose catch clause does nothing but rethrow the exact error it
 * caught. It adds a stack frame and visual noise while changing behaviour not at
 * all — the error would propagate identically with no try/catch at all. Any real
 * handling (logging, wrapping, transforming) or a `finally` block makes the
 * construct meaningful and is left alone.
 *
 * ❌ try { await save(order); } catch (err) { throw err; }
 * ✅ await save(order);                                    // just let it propagate
 * ✅ try { await save(order); } catch (err) { throw new SaveError("failed", { cause: err }); }
 * ✅ try { await save(order); } catch (err) { logger.error(err); throw err; }
 * ✅ try { await save(order); } finally { release(); }     // finally does real work
 */
export const noRedundantTryCatchRethrow = defineDiagnostic({
  id: "no-redundant-try-catch-rethrow",
  title: "try/catch that only rethrows",
  severity: "warn",
  category: "Maintainability",
  tags: ["error-handling"],
  recommendation:
    "Remove the redundant try/catch and let the error propagate, or add real handling (log, wrap with `{ cause }`, or recover).",
  create: (ctx) => ({
    TryStatement: (node) => {
      // A finally block does real work — the try/catch is not redundant.
      if (node.finalizer) return;
      const handler = node.handler as AstNode | null;
      if (!handler) return;

      // Must bind the error to a plain identifier (`catch (err)`).
      const param = handler.param as AstNode | null;
      if (!param || param.type !== "Identifier") return;

      const body = handler.body as AstNode | null;
      if (!body || body.type !== "BlockStatement") return;

      // Catch body must be EXACTLY `throw <same binding>;` and nothing else.
      const stmts = body.body as AstNode[];
      if (stmts.length !== 1) return;
      const only = stmts[0]!;
      if (only.type !== "ThrowStatement") return;
      const arg = only.argument as AstNode | null;
      if (!arg || arg.type !== "Identifier" || arg.name !== param.name) return;

      ctx.report(handler, `\`catch (${param.name}) { throw ${param.name}; }\` only rethrows — the try/catch adds nothing.`);
    },
  }),
});
