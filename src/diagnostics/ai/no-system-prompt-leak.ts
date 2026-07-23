import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode, Visitors } from "../../core/types.ts";
import { getMethodName, getObjectProperty, rootObjectName } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";
import { hasAiImport, isLlmCall } from "./signals.ts";

/**
 * A system prompt echoed back to the caller. The `system` option of an LLM call
 * holds your guardrails — role, policy, refusal rules — and often a secret
 * interpolated into them (an API key, an internal URL, a customer id). If the
 * *same binding* is later sent in an HTTP response, written to a log, or baked
 * into an error message, a jailbreak that coaxes the endpoint into reflecting it
 * hands an attacker the whole prompt, secrets included.
 *
 * PRECISION: fires only when the identifier passed as `system:` is, by scope
 * resolution, the identical binding that reaches the sink. Returning the model's
 * *answer* (`res.json({ text })`) uses a different binding and stays silent — as
 * do inline string-literal system prompts (no binding to track).
 *
 * ❌ const system = `You are ${persona}. Secret: ${KEY}`;
 *    await generateText({ system, prompt });
 *    res.json({ system });                         // leaks the guardrails
 * ✅ const { text } = await generateText({ system, prompt });
 *    res.json({ text });                           // returns the answer, fine
 */

// Response-object receivers whose write methods reach the caller.
const RESPONSE_ROOTS = new Set(["res", "reply", "response"]);
const RESPONSE_METHODS = new Set(["send", "json", "jsonp", "write", "end"]);

// Console / structured-logger write methods.
const LOG_METHODS = new Set(["log", "info", "warn", "error", "debug", "trace", "fatal"]);
const LOG_ROOTS = new Set(["console", "logger", "log"]);

// Error constructors — a system prompt interpolated into a thrown message leaks
// on any error path that surfaces `err.message` to the client.
const ERROR_CONSTRUCTORS = new Set(["Error", "TypeError", "RangeError", "EvalError"]);

export const noSystemPromptLeak = defineDiagnostic({
  id: "no-system-prompt-leak",
  title: "System prompt echoed back to the caller",
  severity: "warn",
  category: "Security",
  tags: ["ai", "prompt", "leak"],
  requires: ["ai"],
  recommendation:
    "Never return, log, or embed the `system` prompt in a caller-visible value. Send only the model's answer back, and keep any secret interpolated into the prompt out of responses and logs.",
  create: (ctx): Visitors => {
    // All cross-referencing happens once, at the Program root, so a leak that
    // textually precedes the LLM call is still bound correctly.
    return {
      Program: (program) => {
        if (!ctx.hasCapability("ai") || !hasAiImport(program)) return;

        // 1. Collect the declaration nodes of every identifier used as a `system:`
        //    option of an LLM call.
        const systemDecls = new Set<AstNode>();
        for (const call of collectDescendants(program, isLlmCall)) {
          const options = (call.arguments as AstNode[])?.[0];
          if (!options || options.type !== "ObjectExpression") continue;
          const prop = getObjectProperty(options, "system");
          const value = prop?.value as AstNode | undefined;
          if (!value || value.type !== "Identifier") continue;
          const binding = ctx.scope.resolveIdentifier(value);
          if (binding) systemDecls.add(binding.declNode);
        }
        if (systemDecls.size === 0) return;

        // A subtree references the system prompt when one of its identifiers
        // resolves to a collected declaration (scope-accurate, shadow-safe).
        const referencesSystemPrompt = (node: AstNode | null | undefined): boolean => {
          if (!node) return false;
          for (const id of collectDescendants(node, (n) => n.type === "Identifier", undefined, true)) {
            const binding = ctx.scope.resolveIdentifier(id);
            if (binding && systemDecls.has(binding.declNode)) return true;
          }
          return false;
        };

        // 2. Find sinks whose argument references that same binding.
        const report = (node: AstNode, where: string): void =>
          ctx.report(
            node,
            `The LLM \`system\` prompt is ${where} — a jailbreak that reflects it leaks your guardrails and any secret interpolated into it. Return only the model's answer.`,
          );

        // HTTP responses and logs: member calls with a matching argument.
        for (const call of collectDescendants(program, (n) => n.type === "CallExpression")) {
          const method = getMethodName(call);
          if (!method) continue;
          const args = (call.arguments as AstNode[]) ?? [];
          const argRefs = args.some((a) => referencesSystemPrompt(a));
          if (!argRefs) continue;

          const root = rootObjectName(call.callee as AstNode);
          if (RESPONSE_METHODS.has(method) && root !== null && RESPONSE_ROOTS.has(root)) {
            report(call, "sent back in the HTTP response");
          } else if (LOG_METHODS.has(method) && root !== null && LOG_ROOTS.has(root)) {
            report(call, "written to a log");
          }
        }

        // Error constructors that embed the system prompt in their message.
        for (const ctor of collectDescendants(program, (n) => n.type === "NewExpression")) {
          const callee = ctor.callee as AstNode;
          if (callee?.type !== "Identifier" || !ERROR_CONSTRUCTORS.has(callee.name)) continue;
          const message = (ctor.arguments as AstNode[])?.[0];
          if (referencesSystemPrompt(message)) {
            report(ctor, "embedded in an error message");
          }
        }
      },
    };
  },
});
