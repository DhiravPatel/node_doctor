/**
 * Shared recognizers for the AI-security taint rules (§105 prompt injection,
 * §107 model output in a sink).
 *
 * These are pure predicates over the LLM SDK call shapes. Nothing here reports;
 * every helper biases toward "unknown → not an LLM call" so a name collision on
 * a non-AI project (a `.create` or `.invoke` that has nothing to do with a model)
 * stays silent. The rules themselves add a second gate — `importsMatching` — so a
 * file that never imports an AI SDK is never inspected at all.
 */

import type { AstNode, TaintLookup } from "../../core/types.ts";
import { collectDescendants } from "../../core/walk.ts";
import {
  getCalleeName,
  getMethodName,
  getReceiverName,
  looksCallerControlled,
  unwrapChain,
} from "../../core/ast.ts";

/**
 * Provenance gate: the file must pull in a recognized LLM SDK before any rule
 * fires. `openai.responses.create` on a project with no AI dependency is almost
 * certainly a different `responses` object, and firing there is a false positive.
 * The pattern mirrors the `DEP_TOKENS` map that assigns the `ai` capability.
 */
export const AI_SDK_IMPORT_RE =
  /(?:^openai(?:$|\/)|^@anthropic-ai\/|^@google\/gen|^@google\/generative|^cohere-ai|^@mistralai\/|^groq-sdk|^replicate$|^ollama(?:$|\/)|^ai$|^ai\/|^@ai-sdk\/|^langchain(?:$|\/)|^@langchain\/|^llamaindex|^@modelcontextprotocol\/)/;

/** Vercel AI SDK entry points — called bare, always take a single options object. */
const VERCEL_PROMPT_FNS = new Set([
  "generateText",
  "streamText",
  "generateObject",
  "streamObject",
]);

/** The trailing `.create` receiver segments that mean an LLM call, per SDK. */
const CREATE_RECEIVER_SEGMENTS = new Set(["completions", "messages", "responses"]);

/** The last dotted segment of a static path (`openai.chat.completions` → "completions"). */
const lastSegment = (path: string | null): string | null => {
  if (path === null) return null;
  const idx = path.lastIndexOf(".");
  return idx === -1 ? path : path.slice(idx + 1);
};

/**
 * Is this CallExpression a recognized LLM invocation whose prompt lives in an
 * options object? Covers OpenAI (`*.completions.create`, `*.responses.create`),
 * Anthropic (`*.messages.create`), and the Vercel AI SDK generate/stream fns.
 */
export const isOptionsPromptCall = (node: AstNode | null | undefined): boolean => {
  if (!node || node.type !== "CallExpression") return false;
  const callee = getCalleeName(node);
  // Vercel: bare `generateText({...})` (possibly namespaced `ai.generateText`).
  const leaf = getMethodName(node);
  if (leaf && VERCEL_PROMPT_FNS.has(leaf)) return true;
  // `*.completions.create` / `*.messages.create` / `*.responses.create`.
  if (leaf === "create") {
    const receiverLeaf = lastSegment(getReceiverName(node));
    if (receiverLeaf && CREATE_RECEIVER_SEGMENTS.has(receiverLeaf)) return true;
  }
  // Guard against a stray positive when only `callee` resolved but nothing matched.
  void callee;
  return false;
};

/**
 * Is this a recognized LLM call whose prompt is passed as a positional argument
 * rather than an options object? Google `model.generateContent(...)`. These take
 * a string or a content array directly; §105 only flags a *built* string here.
 */
export const isPositionalPromptCall = (node: AstNode | null | undefined): boolean => {
  if (!node || node.type !== "CallExpression") return false;
  const leaf = getMethodName(node);
  return leaf === "generateContent" || leaf === "generateContentStream";
};

/**
 * The set of calls whose *result* is model-controlled output (§107 source). This
 * is deliberately narrower than the §105 prompt-call set: a generic `.invoke`
 * would mark far too many bindings model-tainted on any AI project, so it is
 * excluded — a false negative we accept to keep the source precise.
 */
export const isModelResultCall = (node: AstNode | null | undefined): boolean =>
  isOptionsPromptCall(node) || isPositionalPromptCall(node);

/** A template/`+` string whose dynamic parts include caller-controlled data. */
const isBuiltString = (node: AstNode | null | undefined): boolean =>
  !!node &&
  ((node.type === "TemplateLiteral" && ((node.expressions as AstNode[]) ?? []).length > 0) ||
    (node.type === "BinaryExpression" && node.operator === "+"));

/** The static (literal) text of a template or `+` concatenation, joined. */
const staticText = (node: AstNode | null | undefined): string => {
  if (!node) return "";
  if (node.type === "TemplateLiteral") {
    return (node.quasis as AstNode[]).map((q) => q.value?.cooked ?? q.value?.raw ?? "").join("");
  }
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "BinaryExpression" && node.operator === "+") {
    return `${staticText(node.left)}${staticText(node.right)}`;
  }
  return "";
};

/** Does a `+` concatenation include at least one string-literal operand? */
const concatHasLiteralText = (node: AstNode): boolean => {
  if (node.type === "Literal" && typeof node.value === "string" && node.value.length > 0) return true;
  if (node.type === "TemplateLiteral") return staticText(node).trim().length > 0;
  if (node.type === "BinaryExpression" && node.operator === "+") {
    return concatHasLiteralText(node.left as AstNode) || concatHasLiteralText(node.right as AstNode);
  }
  return false;
};

/**
 * Does `node` mix caller-controlled data *into surrounding prompt text* — the
 * shape that loses the instruction/data boundary?
 *
 * This is the whole precision story for §105. A raw tainted value handed to a
 * distinct `user`-role message (`content: req.body.q`) is the CORRECT isolation
 * pattern and must stay silent, so a lone interpolation with no literal text
 * around it (`` `${req.body.q}` ``) does NOT count as mixing. We require real
 * literal text alongside the taint: `` `Question: ${req.body.q}` `` or
 * `"Question: " + req.body.q`.
 *
 * ❌ `You are a bot. ${req.body.persona}`   // taint welded into instructions
 * ✅ req.body.q                              // raw value, isolated by the caller
 */
export const mixesTaintIntoText = (
  node: AstNode | null | undefined,
  tainted: TaintLookup,
): boolean => {
  if (!isBuiltString(node) || !node) return false;
  if (!looksCallerControlled(node, tainted)) return false;
  if (node.type === "TemplateLiteral") return staticText(node).trim().length > 0;
  return concatHasLiteralText(node);
};

/** Unwrap `await`/optional-chaining to the underlying expression. */
export const unwrapAwait = (node: AstNode | null | undefined): AstNode | null => {
  let cur = unwrapChain(node ?? null);
  while (cur && cur.type === "AwaitExpression") cur = unwrapChain(cur.argument as AstNode);
  return cur;
};

/**
 * Fields on a model result that carry the generated TEXT, across the SDKs.
 * `const { text } = await generateText(…)` binds one of these.
 */
export const MODEL_RESULT_FIELDS = new Set(["text", "content", "output_text"]);

/**
 * Does the root of this expression chain resolve to a recognized LLM call?
 *
 * Walks down through `await`, member access and call chains, so
 * `(await openai.chat.completions.create(…)).choices[0].message.content` is
 * recognized as model-derived. Extracted from §107 so §107 and its siblings
 * share one definition of "this value came from a model" rather than drifting
 * apart — a duplicated taint model is worse than a shared one that is wrong,
 * because only the shared one gets fixed once.
 */
export const isModelDerivedExpression = (node: AstNode | null | undefined): boolean => {
  let cur = unwrapChain(node ?? null);
  let hops = 0;
  while (cur && hops++ < 64) {
    if (isModelResultCall(cur)) return true;
    switch (cur.type) {
      case "AwaitExpression":
        cur = unwrapChain(cur.argument as AstNode);
        break;
      case "MemberExpression":
        cur = unwrapChain(cur.object as AstNode);
        break;
      case "CallExpression":
        cur = unwrapChain(cur.callee as AstNode);
        break;
      default:
        return false;
    }
  }
  return false;
};

/**
 * Every local name bound, directly or by alias, to model output in this file.
 * One pass over the program in document order, so an alias of an alias resolves.
 */
export const collectModelBindings = (program: AstNode, rootObjectName: (n: AstNode | null) => string | null): Set<string> => {
  const bindings = new Set<string>();
  for (const decl of collectDescendants(program, (n: AstNode) => n.type === "VariableDeclarator", undefined, true)) {
    const init = decl.init as AstNode | undefined;
    if (!init) continue;
    const expr = unwrapAwait(init);
    const root = rootObjectName(expr);
    const isModel = isModelDerivedExpression(expr) || (root !== null && bindings.has(root));
    if (!isModel) continue;
    const id = decl.id as AstNode | undefined;
    if (id?.type === "Identifier") {
      bindings.add(id.name as string);
      continue;
    }
    if (id?.type !== "ObjectPattern") continue;
    // `const { text } = await generateText(…)` — only the text-bearing fields.
    for (const prop of (id.properties as AstNode[] | undefined) ?? []) {
      if (prop.type !== "Property" || prop.computed) continue;
      const key = prop.key as AstNode | undefined;
      const value = prop.value as AstNode | undefined;
      const keyName = key?.type === "Identifier" ? (key.name as string) : undefined;
      if (keyName && MODEL_RESULT_FIELDS.has(keyName) && value?.type === "Identifier") {
        bindings.add(value.name as string);
      }
    }
  }
  return bindings;
};
