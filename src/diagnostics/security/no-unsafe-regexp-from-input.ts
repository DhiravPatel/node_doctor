import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getCalleeName, looksCallerControlled } from "../../core/ast.ts";

/**
 * `new RegExp(x)` (or `RegExp(x)`) whose pattern is caller-controlled. An
 * attacker who controls the source of a regular expression controls its grammar:
 * a crafted pattern like `(a+)+$` triggers catastrophic backtracking (ReDoS),
 * pinning the single event-loop thread, and an injected fragment can break out of
 * an intended sub-match.
 *
 * ❌ app.get("/find", (req, res) => { const re = new RegExp(req.query.q); ... });
 * ✅ const re = new RegExp("^[a-z0-9_]+$"); // fixed, literal pattern
 * ✅ const re = new RegExp(escapeRegExp(userInput)); // escaped, not raw
 */
export const noUnsafeRegexpFromInput = defineDiagnostic({
  id: "no-unsafe-regexp-from-input",
  title: "RegExp constructed from caller input",
  severity: "warn",
  category: "Security",
  tags: ["injection", "event-loop"],
  recommendation:
    "Never build a RegExp from raw input. Escape the value with an escape-regexp helper before interpolating it, or match against a fixed pattern and treat input as data.",
  create: (ctx) => {
    const check = (node: AstNode): void => {
      if (getCalleeName(node) !== "RegExp") return;
      const arg0 = (node.arguments as AstNode[])[0];
      if (!arg0) return;
      // Precision gate: only caller-controlled sources. A static literal or an
      // internal (non-tainted) variable stays silent.
      if (!looksCallerControlled(arg0, ctx.taintedBindings)) return;
      ctx.report(
        arg0,
        "RegExp pattern is built from caller-controlled input — this enables ReDoS (catastrophic backtracking) and pattern injection.",
      );
    };
    return {
      NewExpression: check,
      CallExpression: check,
    };
  },
});
