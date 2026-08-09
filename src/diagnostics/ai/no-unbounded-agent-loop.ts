import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode, Visitors } from "../../core/types.ts";
import { collectDescendants } from "../../core/walk.ts";
import { hasAiImport, isLlmCall } from "./signals.ts";

/**
 * §109 — an agent loop that nothing bounds.
 *
 * The standard agent shape is a loop that calls the model, runs whatever tools
 * it asked for, feeds the results back, and repeats until the model says it is
 * finished:
 *
 *   ❌ while (true) {
 *        const result = await generateText({ messages, tools });
 *        if (result.finishReason === "stop") break;
 *        messages.push(...(await runTools(result.toolCalls)));
 *      }
 *   ✅ for (let step = 0; step < MAX_STEPS; step++) { … }
 *   ✅ let steps = 0;
 *      while (true) {
 *        if (++steps > MAX_STEPS) throw new Error("agent exceeded step budget");
 *        …
 *      }
 *
 * The exit condition is **the model's own output**, so the only thing standing
 * between this loop and an unbounded bill is the model choosing to stop. It does
 * not always choose to stop. A tool that returns an error the model tries to
 * "fix", two tools that undo each other, a prompt that never satisfies its own
 * success criterion — each produces a loop that runs until something else breaks:
 * the request timeout if you are lucky, the monthly spend cap if you are not.
 * Every serious agent framework ships a `maxSteps`/`max_iterations` guard for
 * exactly this reason.
 *
 * This is the sibling of `ai-call-in-loop`, which is about a loop whose size the
 * *input* controls. Here the size is controlled by nothing at all.
 *
 * PRECISION MODEL. The claim is "nothing in this loop counts", which is a
 * syntactic fact:
 *
 *   - The loop must be **syntactically infinite** — `while (true)`, `for (;;)`,
 *     `do … while (true)`. A loop with a real test already has a bound, and
 *     whether that bound is big enough is not a question syntax answers.
 *   - It must contain a call `isLlmCall` proves is a model call, in this file,
 *     which must itself import an AI SDK.
 *   - Any counter at all is a silence: an `i++`/`i--` anywhere in the body, or a
 *     `+=`/`-=` by a number. The claim is that the loop counts NOTHING; whether
 *     an existing counter is compared correctly is a different question, and one
 *     this rule does not ask.
 */

/** Loop forms whose test can be syntactically infinite. */
const isInfiniteLoop = (node: AstNode): boolean => {
  if (node.type === "ForStatement") {
    // `for (;;)` — an absent test, or a literal `true`.
    const test = node.test as AstNode | null | undefined;
    return !test || (test.type === "Literal" && test.value === true);
  }
  if (node.type === "WhileStatement" || node.type === "DoWhileStatement") {
    const test = node.test as AstNode | undefined;
    return test?.type === "Literal" && test.value === true;
  }
  return false;
};

/** Does anything in this subtree count? An increment, or a numeric compound add. */
const containsCounter = (node: AstNode): boolean =>
  collectDescendants(
    node,
    (n) =>
      n.type === "UpdateExpression" ||
      (n.type === "AssignmentExpression" &&
        (n.operator === "+=" || n.operator === "-=") &&
        (n.right as AstNode | undefined)?.type === "Literal" &&
        typeof (n.right as AstNode).value === "number"),
    undefined,
    true,
  ).length > 0;

export const noUnboundedAgentLoop = defineDiagnostic({
  id: "no-unbounded-agent-loop",
  title: "Agent loop with no step bound",
  severity: "warn",
  category: "Reliability",
  tags: ["ai", "cost", "reliability"],
  requires: ["ai"],
  confidence: "high",
  recommendation:
    "Bound the loop with a step budget — `for (let step = 0; step < MAX_STEPS; step++)`, or a counter that throws when it is exceeded. An agent loop whose only exit is the model deciding to stop runs until the request times out or the spend cap does, and a tool that keeps returning an error the model keeps trying to fix will get there.",
  create: (ctx): Visitors => {
    // `requires` gates selection in a real scan; self-check so the rule is also
    // inert when driven directly (LSP / tests) without the `ai` capability.
    if (!ctx.hasCapability("ai") || !hasAiImport(ctx.program)) return {};

    /** Report each infinite loop once, however many model calls it contains. */
    const reported = new Set<AstNode>();

    return {
      CallExpression: (node) => {
        if (!isLlmCall(node)) return;

        // Walk out to the nearest enclosing loop, stopping at a function
        // boundary: a call nested in an inner function is not "in this loop".
        let current: AstNode | null | undefined = node.parent;
        while (current) {
          if (
            current.type === "FunctionDeclaration" ||
            current.type === "FunctionExpression" ||
            current.type === "ArrowFunctionExpression"
          ) {
            return;
          }
          if (
            current.type === "ForStatement" ||
            current.type === "WhileStatement" ||
            current.type === "DoWhileStatement" ||
            current.type === "ForOfStatement" ||
            current.type === "ForInStatement"
          ) {
            break;
          }
          current = current.parent;
        }
        if (!current || !isInfiniteLoop(current)) return;

        // A counter anywhere in the loop means the author has a step budget;
        // whether it is checked correctly is a different claim.
        const body = (current.body as AstNode | undefined) ?? current;
        if (containsCounter(body)) return;
        if (reported.has(current)) return;
        reported.add(current);

        ctx.report(
          current,
          "This loop calls a model and never counts an iteration, so nothing bounds how many calls it makes — the only exit is the model choosing to stop. A tool that keeps failing, or a success criterion the model never satisfies, turns this into an unbounded spend that runs until the request times out. Give it a step budget.",
        );
      },
    };
  },
});
