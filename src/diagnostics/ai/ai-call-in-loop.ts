import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode, Visitors } from "../../core/types.ts";
import { getMethodName, isFunctionLike } from "../../core/ast.ts";
import type { ScopeResolver } from "../../core/scope.ts";
import { hasAiImport, isLlmCall } from "./signals.ts";

/**
 * An LLM call inside a loop. Each iteration is a network round trip to a model:
 * seconds of latency and cents of cost, multiplied by the collection size. Over a
 * caller-sized list this is a latency blow-up, a bill blow-up, and — because the
 * calls fire back-to-back — a provider rate-limit storm that starts failing the
 * *other* requests too. The batch/parallel form is almost always what was meant.
 *
 * We only fire on a genuinely-scaling loop. A `.map`/`for..of` over a hardcoded
 * array literal of ≤ 3 elements is a fixed fan-out (e.g. "summarize in English,
 * French, German") whose cost does not grow with input, so it stays silent.
 *
 * ❌ for (const doc of docs) { await generateText({ prompt: doc.body }); }
 * ❌ await Promise.all(users.map((u) => generateObject({ prompt: u.bio })));
 * ✅ await generateText({ prompt: docs.map((d) => d.body).join("\n") });  // one call
 * ✅ for (const lang of ["en", "fr"]) { await translate(lang); }  // fixed fan-out ≤ 3
 */

const LOOP_STATEMENTS = new Set([
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
]);

// Array-iteration methods whose callback body runs once per element.
const ITERATION_METHODS = new Set(["map", "forEach", "flatMap"]);

/** An ArrayExpression literal with ≤ 3 elements is a fixed, non-scaling fan-out. */
const isSmallArrayLiteral = (node: AstNode | null | undefined): boolean =>
  !!node &&
  node.type === "ArrayExpression" &&
  Array.isArray(node.elements) &&
  node.elements.length <= 3;

/**
 * Resolve the iterable a loop/iteration ranges over to an array literal, either
 * directly (`for (const x of [a, b])`) or through a `const arr = [a, b]` binding.
 * Returns the ArrayExpression if statically known, else null.
 */
const iterableArrayLiteral = (
  iterable: AstNode | null | undefined,
  scope: ScopeResolver,
): AstNode | null => {
  if (!iterable) return null;
  if (iterable.type === "ArrayExpression") return iterable;
  if (iterable.type === "Identifier") {
    const binding = scope.getBinding(iterable.name, iterable);
    // Only trust a `const` binding — a `let`/`var` array could be reassigned or grown.
    if (binding && binding.kind === "const" && binding.initNode?.type === "ArrayExpression") {
      return binding.initNode;
    }
  }
  return null;
};

export const aiCallInLoop = defineDiagnostic({
  id: "ai-call-in-loop",
  title: "LLM call inside a loop",
  severity: "warn",
  category: "Performance",
  tags: ["ai", "performance", "cost"],
  requires: ["ai"],
  confidence: "high",
  recommendation:
    "Batch the work into one call (fold the items into a single prompt) or bound a parallel fan-out with `Promise.all(items.map(...))` plus a concurrency limit. A model call per iteration is N round trips, N× the cost, and a rate-limit risk.",
  create: (ctx): Visitors => {
    // `requires` gates selection in a real scan; self-check so the rule is also
    // inert when driven directly (LSP / tests) without the `ai` capability.
    if (!ctx.hasCapability("ai") || !hasAiImport(ctx.program)) return {};

    return {
      CallExpression: (node) => {
        if (!isLlmCall(node)) return;

        // Walk up to the first loop OR iteration-callback, stopping at any other
        // function boundary (a call nested in an unrelated inner function is not
        // "in this loop").
        let cur: AstNode | null | undefined = node.parent;
        while (cur) {
          if (LOOP_STATEMENTS.has(cur.type)) {
            // Silence a fixed fan-out over a small literal (for..of only carries an iterable).
            if (cur.type === "ForOfStatement") {
              const lit = iterableArrayLiteral(cur.right as AstNode, ctx.scope);
              if (isSmallArrayLiteral(lit)) return;
            }
            ctx.report(
              node,
              "An LLM call runs once per loop iteration — N model round trips for one request, N× latency and cost, and a rate-limit risk. Batch or bound-parallelize it.",
            );
            return;
          }

          if (isFunctionLike(cur)) {
            // Is this function the callback of a `.map`/`.forEach`/`.flatMap`?
            const parent = cur.parent;
            if (
              parent?.type === "CallExpression" &&
              (parent.arguments as AstNode[])?.includes(cur) &&
              ITERATION_METHODS.has(getMethodName(parent) ?? "")
            ) {
              const receiver = (parent.callee as AstNode)?.object as AstNode | undefined;
              const lit = iterableArrayLiteral(receiver, ctx.scope);
              if (isSmallArrayLiteral(lit)) return;
              ctx.report(
                node,
                "An LLM call runs once per array element — N model round trips for one request, N× latency and cost, and a rate-limit risk. Batch or bound-parallelize it.",
              );
            }
            // Either way, we crossed a function boundary: stop climbing.
            return;
          }
          cur = cur.parent;
        }
      },
    };
  },
});
