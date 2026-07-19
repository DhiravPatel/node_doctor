import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getCalleeName, getStaticStringValue, looksCallerControlled } from "../../core/ast.ts";

/**
 * `new Function(...)` / `Function(...)` built from a non-literal argument. The
 * Function constructor is `eval` wearing a constructor's clothes: every argument
 * is compiled as source. Building the body (or the parameter list) from a dynamic
 * value hands the compiler attacker-influenced text.
 *
 * ❌ const fn = new Function("x", req.query.body);
 * ❌ const fn = Function("return " + expr);
 * ✅ const add = new Function("a", "b", "return a + b"); // all static literals
 */

/** A statically-known primitive literal or a no-substitution template. */
const isStaticLiteral = (node: AstNode | null | undefined): boolean =>
  !!node && (node.type === "Literal" || getStaticStringValue(node) !== null);

export const noFunctionConstructorWithInput = defineDiagnostic({
  id: "no-function-constructor-with-input",
  title: "Function constructor built from input",
  severity: "error",
  category: "Security",
  tags: ["injection"],
  recommendation:
    "Avoid the Function constructor for dynamic input — it compiles its arguments as source. Use a fixed dispatch table or a purpose-built safe expression interpreter instead.",
  create: (ctx) => {
    const check = (node: AstNode): void => {
      if (getCalleeName(node) !== "Function") return; // bare `Function`, not `foo.Function`
      const args = (node.arguments as AstNode[]) ?? [];
      if (args.length === 0) return;
      if (args.every(isStaticLiteral)) return; // fully static — out of scope

      const tainted = args.some((a) => looksCallerControlled(a, ctx.taintedBindings));
      ctx.report(
        node,
        tainted
          ? "The Function constructor is compiling caller-controlled input as source code — this is arbitrary code execution."
          : "The Function constructor is compiling a dynamically-built string as source code — the data/code boundary is lost.",
      );
    };
    return {
      NewExpression: check,
      CallExpression: check,
    };
  },
});
