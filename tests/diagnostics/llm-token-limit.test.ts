/**
 * §109 — `require-llm-token-limit`.
 *
 * A claim about an ABSENT key, so it is made only where every key is visible:
 * an object literal with no spread. Opt-in, because a cap is a policy choice
 * rather than a language fact.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { requireLlmTokenLimit } from "../../src/diagnostics/ai/require-llm-token-limit.ts";

const AI = new Set(["node", "esm", "typescript", "ai"]);

const findings = (source: string, capabilities = AI) =>
  lintSource({
    filePath: "/repo/src/llm.ts",
    sourceText: source,
    diagnostics: [requireLlmTokenLimit],
    capabilities,
  }).findings.filter((f) => f.diagnostic === "require-llm-token-limit");

const fires = (source: string) => {
  const found = findings(source);
  assert.ok(found.length > 0, `expected a FIRE on:\n${source}`);
  return found;
};

const silent = (source: string, capabilities?: Set<string>): void => {
  const found = findings(source, capabilities);
  assert.equal(found.length, 0, `expected SILENCE, got ${found.length}:\n${source}`);
};

const SDK = `import { generateText } from "ai";\n`;
const OPENAI = `import OpenAI from "openai";\nconst openai = new OpenAI();\n`;

describe("require-llm-token-limit — fires", () => {
  test("an OpenAI call with no cap", () => {
    const [f] = fires(`${OPENAI}await openai.chat.completions.create({ model: "gpt-4", messages });`);
    assert.match(f!.message, /no output-token limit/);
    assert.match(f!.message, /max_tokens/);
  });

  test("a Vercel AI SDK call with no cap", () => {
    fires(`${SDK}await generateText({ model, prompt });`);
  });
});

describe("require-llm-token-limit — silent", () => {
  test("the cap, under every name the SDKs give it", () => {
    silent(`${OPENAI}await openai.chat.completions.create({ model, messages, max_tokens: 1024 });`);
    silent(`${SDK}await generateText({ model, prompt, maxTokens: 512 });`);
    silent(`${SDK}await generateText({ model, prompt, maxOutputTokens: 512 });`);
    silent(`${OPENAI}await openai.chat.completions.create({ model, messages, max_completion_tokens: 256 });`);
    silent(`${OPENAI}await openai.chat.completions.create({ model, messages, "max_tokens": 100 });`);
  });

  test("a spread may carry the cap, and this cannot follow it", () => {
    silent(`${OPENAI}await openai.chat.completions.create({ ...defaults, model, messages });`);
  });

  test("options that are not a visible literal", () => {
    silent(`${OPENAI}await openai.chat.completions.create(params);`);
    silent(`${OPENAI}await openai.chat.completions.create(buildRequest(input));`);
  });

  test("a computed key could be the cap under any name", () => {
    silent(`${OPENAI}await openai.chat.completions.create({ model, messages, [k]: 1 });`);
  });

  test("a `.create` that is not a model call", () => {
    silent(`${OPENAI}await db.user.create({ data });`);
    silent(`${OPENAI}await stripe.customers.create({ email });`);
  });

  test("a file, or a project, with no AI SDK", () => {
    silent(`await generateText({ model, prompt });`);
    silent(`${SDK}await generateText({ model, prompt });`, new Set(["node", "esm", "typescript"]));
  });
});

describe("require-llm-token-limit — determinism", () => {
  test("identical source yields identical findings", () => {
    const source = `${SDK}await generateText({ model, prompt: a });\nawait generateText({ model, prompt: b });`;
    assert.equal(JSON.stringify(findings(source)), JSON.stringify(findings(source)));
    assert.equal(findings(source).length, 2);
  });
});
