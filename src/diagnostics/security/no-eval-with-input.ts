import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getCalleeName, getStaticStringValue, looksCallerControlled } from "../../core/ast.ts";

/**
 * `eval(x)` of anything that is not a plain static string. `eval` compiles and
 * runs its argument as source in the current scope. If the argument is dynamic —
 * and especially if it is caller-controlled — an attacker who influences that
 * value achieves arbitrary code execution inside your process.
 *
 * Even a "computed but internal" string is out of the safe zone: the boundary is
 * only clear when the source is a literal you can read at review time.
 *
 * ❌ app.post("/run", (req, res) => { const r = eval(req.body.expr); res.json({ r }); });
 * ❌ const result = eval("(" + payload + ")");
 * ✅ const result = eval("1 + 1"); // static literal — discouraged, but out of scope
 */

/** A statically-known primitive literal (string/number/bool) or a no-substitution template. */
const isStaticLiteral = (node: AstNode | null | undefined): boolean =>
  !!node && (node.type === "Literal" || getStaticStringValue(node) !== null);

export const noEvalWithInput = defineDiagnostic({
  id: "no-eval-with-input",
  title: "eval() of caller-controlled input",
  severity: "error",
  category: "Security",
  tags: ["injection"],
  recommendation:
    "Never eval() dynamic input. Parse structured data with JSON.parse, and replace dynamic dispatch with an explicit lookup table keyed on a validated string.",
  create: (ctx) => ({
    CallExpression: (node) => {
      if (getCalleeName(node) !== "eval") return; // bare `eval`, not `foo.eval`
      const arg0 = (node.arguments as AstNode[])[0];
      if (!arg0) return;
      if (isStaticLiteral(arg0)) return; // static string — discouraged but out of scope

      const tainted = looksCallerControlled(arg0, ctx.taintedBindings);
      ctx.report(
        arg0,
        tainted
          ? "eval() is running caller-controlled input as source code — this is arbitrary code execution."
          : "eval() is running a dynamically-built string as source code — the data/code boundary is lost.",
      );
    },
  }),
});
