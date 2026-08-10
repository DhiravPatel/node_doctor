import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode, Visitors } from "../../core/types.ts";
import { staticMemberPath } from "../../core/ast.ts";
import { hasAiImport } from "./signals.ts";
import { collectModelBindings, isModelDerivedExpression, unwrapAwait } from "./shared.ts";

/**
 * §107 — `JSON.parse` of model output, with nothing to catch it.
 *
 * A model returns TEXT. Asking for JSON, even with a schema and a JSON mode,
 * changes the odds and not the type — so `JSON.parse` on that text is parsing
 * untrusted input, and it throws:
 *
 *   ❌ const r = await openai.chat.completions.create({ model, messages });
 *      const data = JSON.parse(r.choices[0].message.content);   // SyntaxError
 *   ✅ try { data = JSON.parse(text); } catch { return fallback(); }
 *   ✅ const { object } = await generateObject({ model, schema, prompt });
 *
 * Every one of these throws, and every one is a shape models actually emit —
 * measured, not assumed:
 *
 *   - **truncated at the token cap**: `{"name":"Ada","bio":"a very long bi` —
 *     the commonest, and the one that arrives in production rather than in
 *     testing, because it needs an unusually long answer to trigger. This is
 *     `require-llm-token-limit`'s failure mode landing one layer down.
 *   - **fenced**: ```` ```json\\n{…}\\n``` ```` — models add fences back the moment
 *     a prompt is reworded.
 *   - **a preamble**: `Sure! Here is the JSON:` before the object.
 *   - a trailing comma, or single quotes.
 *
 * Unhandled, the `SyntaxError` rejects the request handler's promise: a 500 for
 * that user, and on an unhandled rejection the process. The failure rate is
 * whatever fraction of responses come back malformed, which is neither zero nor
 * observable from the code.
 *
 * PRECISION MODEL. The claim is "this parse is unguarded", so both halves must
 * hold:
 *
 *   - The argument must be PROVEN model output — derived from a call
 *     `isModelResultCall` recognizes, or from a binding traced back to one. A
 *     bare identifier is never assumed to be model text.
 *   - There must be NO guard. Any enclosing `try` with a `catch` silences it,
 *     wherever the parse sits inside it, and so does a `catch` in the
 *     surrounding function's promise chain. Whether that handler is *good* is
 *     not a claim this makes; that it exists is.
 *   - A wrapper that already returns a result rather than throwing — a
 *     `safeParse`, a `tryParse` — is not `JSON.parse` and is not matched.
 */

/** Guard shapes that mean a throw here is already handled. */
const isGuarded = (node: AstNode): boolean => {
  // Any enclosing `try { … } catch { … }`, at any depth.
  let current: AstNode | null | undefined = node.parent;
  for (let depth = 0; current && depth < 128; depth++) {
    if (current.type === "TryStatement" && (current.handler as AstNode | undefined)) return true;
    // Stop at the function boundary: a `try` outside the function does not
    // catch a throw from inside a DIFFERENT invocation of it.
    if (
      current.type === "FunctionDeclaration" ||
      current.type === "FunctionExpression" ||
      current.type === "ArrowFunctionExpression"
    ) {
      break;
    }
    current = current.parent;
  }
  return false;
};

export const noUnguardedLlmJsonParse = defineDiagnostic({
  id: "no-unguarded-llm-json-parse",
  title: "JSON.parse of model output with no error handling",
  severity: "error",
  category: "Reliability",
  requires: ["ai"],
  confidence: "high",
  tags: ["ai", "reliability", "correctness"],
  recommendation:
    "Wrap it in `try`/`catch` and decide what a malformed response should do, or use a schema-validating helper (`generateObject` on the Vercel AI SDK, a Zod `safeParse` on the parsed value). A model returns text: a JSON mode changes the odds, not the type, and a response truncated at the token cap is never valid JSON.",
  create: (ctx): Visitors => {
    // `requires` gates selection in a real scan; self-check so the rule is also
    // inert when driven directly (LSP / tests) without the `ai` capability.
    if (!ctx.hasCapability("ai") || !hasAiImport(ctx.program)) return {};

    /** The root identifier of a member chain, for alias tracking. */
    const rootObjectName = (node: AstNode | null): string | null => {
      let current: AstNode | null | undefined = node;
      for (let depth = 0; current && depth < 64; depth++) {
        if (current.type === "Identifier") return current.name as string;
        if (current.type === "MemberExpression") current = current.object as AstNode;
        else if (current.type === "CallExpression") current = current.callee as AstNode;
        else if (current.type === "AwaitExpression") current = current.argument as AstNode;
        else return null;
      }
      return null;
    };

    const modelBindings = collectModelBindings(ctx.program, rootObjectName);

    /** Is this expression proven model output? */
    const isModelText = (node: AstNode | null | undefined): boolean => {
      if (!node) return false;
      const expr = unwrapAwait(node);
      if (isModelDerivedExpression(expr)) return true;
      const root = rootObjectName(expr);
      return root !== null && modelBindings.has(root);
    };

    return {
      CallExpression: (node) => {
        // `JSON.parse(…)` specifically. A `safeParse` wrapper already returns
        // a result instead of throwing, and is a different function.
        const callee = node.callee as AstNode | undefined;
        if (callee?.type !== "MemberExpression" || staticMemberPath(callee) !== "JSON.parse") return;
        // A local `JSON` is somebody else's object.
        const object = callee.object as AstNode | undefined;
        if (object?.type === "Identifier" && ctx.scope.getBinding("JSON", object) !== null) return;

        const argument = ((node.arguments as AstNode[] | undefined) ?? [])[0];
        if (!isModelText(argument)) return;
        if (isGuarded(node)) return;

        ctx.report(
          node,
          "This parses model output as JSON with nothing to catch a `SyntaxError`. A model returns text — a JSON mode changes the odds, not the type — and a response truncated at the token cap, wrapped in a ```` ```json ```` fence, or prefaced with a sentence is not valid JSON. Unhandled, the throw rejects this handler: a 500 for that request, at whatever rate the model happens to malform its answer. Wrap it in `try`/`catch`, or use a schema-validating helper such as `generateObject`.",
        );
      },
    };
  },
});
