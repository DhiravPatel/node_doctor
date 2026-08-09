import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode, Visitors } from "../../core/types.ts";
import { hasAiImport, isLlmCall } from "./signals.ts";

/**
 * §109 — a model call with no cap on how much it may generate.
 *
 * Output tokens are the expensive half of an LLM bill and the slow half of the
 * latency. Without a cap the ceiling is whatever the model's default maximum
 * happens to be — a number set by the provider, changed by the provider, and
 * different for every model you might swap in:
 *
 *   ❌ await openai.chat.completions.create({ model, messages });
 *   ✅ await openai.chat.completions.create({ model, messages, max_tokens: 1024 });
 *   ✅ await generateText({ model, prompt, maxTokens: 512 });
 *
 * The failure is not an error, which is why it survives review. A prompt that
 * usually returns a sentence returns forty thousand tokens the day a user pastes
 * a document into it, or the day a retrieval step returns something that sends
 * the model into a repetition loop. The request is slow, the response is
 * enormous, the bill is real, and nothing anywhere logged a problem.
 *
 * Swapping models makes it worse rather than better: the same code that was
 * implicitly capped at 4k on one model is implicitly capped at 64k on its
 * successor, and the change arrives as a pricing surprise rather than a diff.
 *
 * PRECISION MODEL. The claim is "this call sets no limit", so it is made only
 * where every key is visible:
 *
 *   - The call must be one `isLlmCall` proves is a model call, in a file that
 *     imports an AI SDK.
 *   - The options must be an **object literal**. A variable, a call, or a
 *     parameter hides its keys, and a claim about absent keys needs to see all
 *     of them.
 *   - A **spread** anywhere in that literal is a silence: `{ ...defaults }` may
 *     well carry the cap, and this rule cannot follow it.
 *   - Any of the cap's names across the SDKs counts, in either casing
 *     convention, and a computed key that could be one is a silence too.
 *
 * NOT VERIFIED HERE: Anthropic's Messages API documents `max_tokens` as a
 * *required* parameter, which would make its absence an error rather than a
 * cost risk. That needs a live API call to confirm, which this analyzer cannot
 * make, so the message claims only the part that is checkable offline.
 */

/** The cap, under every name the SDKs give it. */
const TOKEN_LIMIT_KEYS = new Set([
  "max_tokens",
  "maxTokens",
  "max_output_tokens",
  "maxOutputTokens",
  "max_completion_tokens",
  "maxCompletionTokens",
  "maxOutputTokenCount",
]);

export const requireLlmTokenLimit = defineDiagnostic({
  id: "require-llm-token-limit",
  title: "Model call with no output-token limit",
  severity: "warn",
  category: "Performance",
  tags: ["ai", "cost", "performance"],
  requires: ["ai"],
  confidence: "high",
  defaultEnabled: false,
  recommendation:
    "Set an output cap — `max_tokens` on the OpenAI and Anthropic clients, `maxTokens` on the Vercel AI SDK, `maxOutputTokens` on Google's. Without one the ceiling is the model's default maximum, which differs per model and changes under you: the same code implicitly capped at 4k today is capped at 64k after a model swap, and the difference arrives as a bill.",
  create: (ctx): Visitors => {
    // `requires` gates selection in a real scan; self-check so the rule is also
    // inert when driven directly (LSP / tests) without the `ai` capability.
    if (!ctx.hasCapability("ai") || !hasAiImport(ctx.program)) return {};

    return {
      CallExpression: (node) => {
        if (!isLlmCall(node)) return;

        const args = (node.arguments as AstNode[] | undefined) ?? [];
        const options = args.find((a) => a.type === "ObjectExpression");
        // No visible options object: the keys are somewhere this cannot see.
        if (!options) return;

        for (const prop of (options.properties as AstNode[] | undefined) ?? []) {
          // A spread may carry the cap, and this rule cannot follow it.
          if (prop.type === "SpreadElement") return;
          if (prop.type !== "Property") continue;
          const key = prop.key as AstNode | undefined;
          if (prop.computed) {
            // `{ [k]: 512 }` could be the cap under any name.
            if (key?.type !== "Literal" || typeof key.value !== "string") return;
            if (TOKEN_LIMIT_KEYS.has(key.value as string)) return;
            continue;
          }
          const name = key?.type === "Identifier" ? (key.name as string) : null;
          const literal = key?.type === "Literal" && typeof key.value === "string" ? (key.value as string) : null;
          const resolved = name ?? literal;
          if (resolved !== null && TOKEN_LIMIT_KEYS.has(resolved)) return;
        }

        ctx.report(
          options,
          "This model call sets no output-token limit, so how much it may generate is whatever the provider's default maximum happens to be for the model in use — a number the provider sets, changes, and varies per model. A prompt that normally returns a sentence returns forty thousand tokens the day a user pastes a document into it, and nothing logs a problem. Set `max_tokens` (or `maxTokens` / `maxOutputTokens`, per SDK).",
        );
      },
    };
  },
});
