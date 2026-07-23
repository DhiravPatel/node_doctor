/**
 * The two taint-based AI-security diagnostics (§105 prompt injection, §107 model
 * output in a sink). Both are driven through `lintSource` against the diagnostic
 * modules directly. The MUST-be-silent cases — above all the isolated
 * `{ role: "user", content: taint }` shape — are the point of the rules, so they
 * carry as much weight here as the firing cases.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import type { Diagnostic, Finding } from "../../src/core/types.ts";
import { noPromptInjection } from "../../src/diagnostics/ai/no-prompt-injection.ts";
import { noLlmOutputInSink } from "../../src/diagnostics/ai/no-llm-output-in-sink.ts";

const CAPABILITIES = new Set(["node", "esm", "typescript", "ai"]);

const findingsFor = (diagnostic: Diagnostic, source: string): Finding[] =>
  lintSource({
    filePath: "test.ts",
    sourceText: source,
    diagnostics: [diagnostic],
    capabilities: CAPABILITIES,
  }).findings.filter((f) => f.diagnostic === diagnostic.id);

const fires = (diagnostic: Diagnostic, source: string): Finding[] => {
  const found = findingsFor(diagnostic, source);
  assert.ok(found.length > 0, `expected ${diagnostic.id} to FIRE on:\n${source}`);
  return found;
};

const silent = (diagnostic: Diagnostic, source: string): void => {
  const found = findingsFor(diagnostic, source);
  assert.equal(
    found.length,
    0,
    `expected ${diagnostic.id} to STAY SILENT, got ${found.length}:\n` +
      found.map((f) => `  - ${f.message} @ ${f.line}:${f.column}`).join("\n") +
      `\n--- source ---\n${source}`,
  );
};

// An OpenAI import so the file-level provenance gate is satisfied.
const OPENAI = 'import OpenAI from "openai";\nconst openai = new OpenAI();\n';
const ANTHROPIC = 'import Anthropic from "@anthropic-ai/sdk";\nconst anthropic = new Anthropic();\n';
const VERCEL = 'import { generateText } from "ai";\n';

// ---------------------------------------------------------------------------
// §105 no-prompt-injection
// ---------------------------------------------------------------------------

describe("no-prompt-injection (§105)", () => {
  test("fires on request data interpolated into the system prompt", () => {
    fires(
      noPromptInjection,
      OPENAI +
        'app.post("/x", (req, res) => { openai.chat.completions.create({ system: `You are ${req.body.persona}`, messages: [] }); });',
    );
  });

  test("fires on a raw tainted value placed directly as the system prompt", () => {
    fires(
      noPromptInjection,
      OPENAI +
        'app.post("/x", (req, res) => { openai.chat.completions.create({ system: req.body.persona, messages: [] }); });',
    );
  });

  test("fires on request data interpolated into a Vercel `prompt`", () => {
    fires(
      noPromptInjection,
      VERCEL +
        'app.post("/x", (req, res) => { generateText({ prompt: `Summarize: ${req.body.text}` }); });',
    );
  });

  // A BARE tainted value as the Vercel `prompt` is the isolated, safe single-turn
  // shape — the SDK sends `prompt` as a distinct user-role message, identical to
  // `messages: [{ role: "user", content: taint }]`. Only user text *mixed into* a
  // prompt string is injection. (A verified false positive during review.)
  test("silent on a raw tainted value as the Vercel `prompt`", () => {
    silent(
      noPromptInjection,
      VERCEL + 'app.post("/x", (req, res) => { generateText({ prompt: req.body.text }); });',
    );
  });

  test("fires when taint is interpolated INTO a Vercel `prompt` string", () => {
    fires(
      noPromptInjection,
      VERCEL + 'app.post("/x", (req, res) => { generateText({ prompt: "Summarize: " + req.body.text }); });',
    );
  });

  test("fires on taint interpolated into a system-role message (Anthropic)", () => {
    fires(
      noPromptInjection,
      ANTHROPIC +
        'app.post("/x", (req, res) => { anthropic.messages.create({ messages: [{ role: "system", content: `Rules: ${req.body.r}` }] }); });',
    );
  });

  test("fires on a raw tainted value in a system-role message", () => {
    fires(
      noPromptInjection,
      OPENAI +
        'app.post("/x", (req, res) => { openai.chat.completions.create({ messages: [{ role: "system", content: req.body.r }] }); });',
    );
  });

  test("fires on taint interpolated into a user message's text", () => {
    fires(
      noPromptInjection,
      OPENAI +
        'app.post("/x", (req, res) => { openai.chat.completions.create({ messages: [{ role: "user", content: `The user asked: ${req.body.q}` }] }); });',
    );
  });

  test("fires on OpenAI responses.create with a built prompt-ish system", () => {
    fires(
      noPromptInjection,
      OPENAI +
        'app.post("/x", (req, res) => { openai.responses.create({ system: "You are " + req.body.persona, input: "hi" }); });',
    );
  });

  // --- MUST stay silent ---

  test("SILENT: isolated raw taint as user-role message content (the correct pattern)", () => {
    silent(
      noPromptInjection,
      OPENAI +
        'app.post("/x", (req, res) => { openai.chat.completions.create({ messages: [{ role: "user", content: req.body.q }] }); });',
    );
  });

  test("SILENT: isolated user content alongside a static system message", () => {
    silent(
      noPromptInjection,
      OPENAI +
        'app.post("/x", (req, res) => { openai.chat.completions.create({ messages: [{ role: "system", content: "You are helpful." }, { role: "user", content: req.body.q }] }); });',
    );
  });

  test("SILENT: static system prompt with isolated user message", () => {
    silent(
      noPromptInjection,
      VERCEL +
        'app.post("/x", (req, res) => { generateText({ system: SYSTEM_PROMPT, messages: [{ role: "user", content: req.body.q }] }); });',
    );
  });

  test("SILENT: hardcoded prompt with no tainted input", () => {
    silent(
      noPromptInjection,
      OPENAI +
        'openai.chat.completions.create({ system: "You are a helpful assistant.", messages: [{ role: "user", content: "hello" }] });',
    );
  });

  test("SILENT: system prompt interpolates a non-tainted constant", () => {
    silent(
      noPromptInjection,
      VERCEL + 'const persona = "pirate";\ngenerateText({ system: `You are a ${persona}` });',
    );
  });

  test("SILENT: no AI-SDK import, even with the exact call shape", () => {
    silent(
      noPromptInjection,
      'app.post("/x", (req, res) => { thing.chat.completions.create({ system: `x ${req.body.q}` }); });',
    );
  });

  test("SILENT: lone interpolation of the raw value (no surrounding instructions)", () => {
    silent(
      noPromptInjection,
      OPENAI +
        'app.post("/x", (req, res) => { openai.chat.completions.create({ messages: [{ role: "user", content: `${req.body.q}` }] }); });',
    );
  });

  test("SILENT: messages bound to an opaque variable we cannot inspect", () => {
    silent(
      noPromptInjection,
      OPENAI +
        'app.post("/x", (req, res) => { const history = buildHistory(req); openai.chat.completions.create({ messages: history }); });',
    );
  });
});

// ---------------------------------------------------------------------------
// §107 no-llm-output-in-sink
// ---------------------------------------------------------------------------

describe("no-llm-output-in-sink (§107)", () => {
  test("fires on eval of destructured Vercel text output", () => {
    fires(
      noLlmOutputInSink,
      VERCEL + 'const { text } = await generateText({ prompt: "code?" });\neval(text);',
    );
  });

  test("fires on child_process exec of OpenAI message content", () => {
    fires(
      noLlmOutputInSink,
      OPENAI +
        'import { exec } from "node:child_process";\n' +
        'const c = (await openai.chat.completions.create({ messages: [] })).choices[0].message.content;\n' +
        "exec(c);",
    );
  });

  test("fires on new Function of model output", () => {
    fires(
      noLlmOutputInSink,
      VERCEL + 'const { text } = await generateText({ prompt: "x" });\nconst f = new Function(text);',
    );
  });

  test("fires on raw SQL built from model output", () => {
    fires(
      noLlmOutputInSink,
      VERCEL +
        'const { text } = await generateText({ prompt: "x" });\ndb.query(`SELECT * FROM t WHERE name = ${text}`);',
    );
  });

  test("fires on $queryRawUnsafe with model output", () => {
    fires(
      noLlmOutputInSink,
      VERCEL + 'const { text } = await generateText({ prompt: "x" });\nprisma.$queryRawUnsafe(text);',
    );
  });

  test("fires on HTML response body built from model output", () => {
    fires(
      noLlmOutputInSink,
      OPENAI +
        'const answer = (await openai.chat.completions.create({ messages: [] })).choices[0].message.content;\n' +
        'res.send(`<div>${answer}</div>`);',
    );
  });

  test("fires on fetch of a URL built from model output", () => {
    fires(
      noLlmOutputInSink,
      VERCEL + 'const { text } = await generateText({ prompt: "x" });\nawait fetch(text);',
    );
  });

  test("fires on an alias of a model binding reaching eval", () => {
    fires(
      noLlmOutputInSink,
      VERCEL + 'const { text } = await generateText({ prompt: "x" });\nconst t2 = text;\neval(t2);',
    );
  });

  // --- MUST stay silent ---

  test("SILENT: model output returned to the caller as JSON data", () => {
    silent(
      noLlmOutputInSink,
      VERCEL + 'const { text } = await generateText({ prompt: "x" });\nres.json({ answer: text });',
    );
  });

  test("SILENT: model output logged", () => {
    silent(
      noLlmOutputInSink,
      VERCEL + 'const { text } = await generateText({ prompt: "x" });\nconsole.log(text);',
    );
  });

  test("SILENT: model output stored via an ORM create", () => {
    silent(
      noLlmOutputInSink,
      VERCEL +
        'const { text } = await generateText({ prompt: "x" });\nawait db.answers.create({ data: { body: text } });',
    );
  });

  test("SILENT: no AI-SDK import — plain eval of a local", () => {
    silent(noLlmOutputInSink, 'const text = getText();\neval(text);');
  });

  test("SILENT: regex.exec is not a child_process sink", () => {
    silent(
      noLlmOutputInSink,
      VERCEL + 'const { text } = await generateText({ prompt: "x" });\nconst m = /a/.exec(text);',
    );
  });

  test("SILENT: non-model local passed to eval on an AI file", () => {
    silent(
      noLlmOutputInSink,
      VERCEL + 'const { text } = await generateText({ prompt: "x" });\nconst other = getOther();\neval(other);',
    );
  });

  test("SILENT: res.send of model output with no HTML markup", () => {
    silent(
      noLlmOutputInSink,
      VERCEL + 'const { text } = await generateText({ prompt: "x" });\nres.send(text);',
    );
  });

  test("SILENT: value parsed/derived from model output is no longer tracked", () => {
    silent(
      noLlmOutputInSink,
      VERCEL +
        'const { text } = await generateText({ prompt: "x" });\nconst parsed = JSON.parse(text);\neval(parsed);',
    );
  });

  test("SILENT: an ambiguous .query call with no SQL keyword and model output", () => {
    silent(
      noLlmOutputInSink,
      VERCEL + 'const { text } = await generateText({ prompt: "x" });\ncache.query(text);',
    );
  });
});
