import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";

/**
 * A completely empty `catch` block — the error is caught and silently discarded.
 *
 * Why it matters: swallowing an error silently converts a failure into a
 * successful-looking no-op. The bug still happened, but nothing logs and the
 * caller sees a clean path — the incidents that take days to trace.
 *
 * OPT-IN (`defaultEnabled: false`). An empty catch with an intentional comment,
 * and `catch { return null }` for an optional read, are common and legitimate;
 * to stay precision-first this diagnostic is off by default and enforces the stricter
 * "never an empty catch" policy only for teams that opt in.
 *
 * ❌ try { await save(order); } catch (e) {}
 * ✅ try { await save(order); } catch (e) { log.error(e); throw e; }
 */
export const noSwallowedErrorEmptyCatch = defineDiagnostic({
  id: "no-swallowed-error-empty-catch",
  title: "Empty catch swallows the error",
  severity: "warn",
  category: "Bugs",
  tags: ["error-handling"],
  defaultEnabled: false,
  recommendation:
    "Do something with the error: log it (`log.error(err)`), rethrow it (`throw err`), forward it (`next(err)`), or return a meaningful fallback. An empty catch hides the failure entirely.",
  create: (ctx) => ({
    CatchClause: (node) => {
      const body = node.body as AstNode | undefined;
      if (!body || body.type !== "BlockStatement") return;
      const stmts = (body.body as AstNode[]) ?? [];
      if (stmts.length === 0) {
        ctx.report(node, "This catch block is empty — the error is caught and silently discarded.");
      }
    },
  }),
});
