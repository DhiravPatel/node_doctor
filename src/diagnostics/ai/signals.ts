/**
 * Shared, pure predicates for the AI-security diagnostics (§106, §108, §109).
 *
 * All three rules key off the same two facts: "is this call an LLM invocation?"
 * and "does this file actually talk to an AI SDK?". Centralizing the call-shape
 * table here keeps the rules agreeing on one canonical definition, and keeps the
 * definition conservative — a shape we cannot recognize as an LLM call is treated
 * as *not* one, so the rules stay silent rather than guess.
 *
 * Nothing here reports; every export is a side-effect-free predicate that biases
 * toward "unknown → false".
 */

import type { AstNode } from "../../core/types.ts";
import { getMethodName, getReceiverName, isFunctionLike } from "../../core/ast.ts";
import { findDescendant } from "../../core/walk.ts";
import { moduleSpecifiers } from "../api/context.ts";

/**
 * A module specifier is an AI SDK when it is one of the known first-party client
 * packages. Used as file-level provenance: the capability gate proves the project
 * *depends* on an AI SDK, this proves *this file* imports one — so a name
 * collision (`generateText`, a `.create()` on a `messages` receiver) in an
 * unrelated file of an AI project stays silent.
 */
export const AI_IMPORT_RE =
  /^(openai|ollama|replicate|cohere-ai|groq-sdk|llamaindex|ai)$|^@anthropic-ai\//;

/** Same idea for MCP servers. §106 fires only when the file imports the SDK. */
export const MCP_IMPORT_RE = /modelcontextprotocol/;

// Extend AI_IMPORT_RE for scoped Google / Mistral / LangChain packages without a
// combinatorial single regex (readability over cleverness).
const AI_IMPORT_EXTRA = [
  /^@google\/(generative-ai|genai)$/,
  /^@mistralai\//,
  /^@langchain\//,
  /^langchain(\/|$)/,
];

/** Does the specifier name a first-party AI SDK client package? */
export const isAiImportSpecifier = (spec: string): boolean =>
  AI_IMPORT_RE.test(spec) || AI_IMPORT_EXTRA.some((re) => re.test(spec));

/** File-level provenance: does this file import a recognized AI SDK client? */
export const hasAiImport = (program: AstNode): boolean => {
  for (const spec of moduleSpecifiers(program)) {
    if (isAiImportSpecifier(spec)) return true;
  }
  return false;
};

/** File-level provenance: does this file import the MCP SDK? */
export const hasMcpImport = (program: AstNode): boolean => {
  for (const spec of moduleSpecifiers(program)) {
    if (MCP_IMPORT_RE.test(spec)) return true;
  }
  return false;
};

// Bare-function generation calls from the Vercel AI SDK. These names are
// unambiguous once we know the file imports `ai`.
const AI_BARE_FUNCTIONS = new Set([
  "generateText",
  "streamText",
  "generateObject",
  "streamObject",
]);

// `x.<receiver>.create(...)` is an LLM call only when the receiver segment is one
// of the provider surfaces — `openai.chat.completions.create`,
// `anthropic.messages.create`, `client.responses.create`. A bare `.create()` on
// anything else (an ORM model, a DOM node) is deliberately NOT matched.
const CREATE_RECEIVER_SEGMENTS = new Set(["completions", "messages", "responses"]);

// Google Gemini. `model.generateContent(...)` / `ai.models.generateContentStream(...)`.
const AI_DIRECT_METHODS = new Set(["generateContent", "generateContentStream"]);

/**
 * Is this CallExpression a recognized LLM generation call?
 *
 * Deliberately conservative. LangChain's `.invoke()` is NOT included: the name is
 * far too generic (Reflect, RxJS, many builders expose `.invoke`) to fire at
 * high confidence, and a false positive is a release blocker. That is an accepted
 * false negative, not an oversight.
 *
 * ❌ generateText({ prompt })            → matched
 * ❌ openai.chat.completions.create(...) → matched
 * ✅ orm.user.create({ data })           → NOT matched (receiver "user")
 */
export const isLlmCall = (node: AstNode | null | undefined): boolean => {
  if (!node || node.type !== "CallExpression") return false;
  const method = getMethodName(node);
  if (!method) return false;

  // Bare Vercel AI SDK function, called as an identifier (no receiver).
  const callee = node.callee as AstNode;
  if (callee?.type === "Identifier" && AI_BARE_FUNCTIONS.has(callee.name)) return true;

  if (AI_DIRECT_METHODS.has(method)) return true;

  if (method === "create") {
    const receiver = getReceiverName(node);
    if (!receiver) return false;
    const lastSegment = receiver.split(".").pop() ?? "";
    return CREATE_RECEIVER_SEGMENTS.has(lastSegment);
  }
  return false;
};

/** Is `n` a non-computed property key / shorthand key (a name, not a reference)? */
export const isPropertyKey = (n: AstNode): boolean => {
  const p = n.parent;
  if (p?.type === "MemberExpression" && !p.computed && p.property === n) return true;
  if (p?.type === "Property" && !p.computed && p.key === n) return true;
  return false;
};

/**
 * Does the subtree at `node` reference any identifier in `names` as a *value*
 * (not as a property key)? Used to tie a model/tool-controlled binding to a sink
 * argument without pulling in the whole-file taint engine.
 */
export const referencesNames = (
  node: AstNode | null | undefined,
  names: Set<string>,
): boolean => {
  if (!node || names.size === 0) return false;
  const isMatch = (n: AstNode): boolean =>
    n.type === "Identifier" && names.has(n.name) && !isPropertyKey(n);
  if (isMatch(node)) return true;
  return findDescendant(node, isMatch, isFunctionLike) !== null;
};
