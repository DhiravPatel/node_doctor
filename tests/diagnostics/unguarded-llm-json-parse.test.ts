/**
 * §107 — `no-unguarded-llm-json-parse`.
 *
 * A model returns TEXT. A JSON mode changes the odds, not the type — so
 * `JSON.parse` on that text is parsing untrusted input, and every shape a model
 * actually emits when it goes wrong throws.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noUnguardedLlmJsonParse } from "../../src/diagnostics/ai/no-unguarded-llm-json-parse.ts";

const AI = new Set(["node", "esm", "typescript", "ai"]);

const findings = (source: string, capabilities = AI) =>
  lintSource({
    filePath: "/repo/src/llm.ts",
    sourceText: source,
    diagnostics: [noUnguardedLlmJsonParse],
    capabilities,
  }).findings.filter((f) => f.diagnostic === "no-unguarded-llm-json-parse");

const fires = (source: string) => {
  const found = findings(source);
  assert.ok(found.length > 0, `expected a FIRE on:\n${source}`);
  return found;
};

const silent = (source: string, capabilities?: Set<string>): void => {
  const found = findings(source, capabilities);
  assert.equal(found.length, 0, `expected SILENCE, got ${found.length}:\n${source}`);
};

const OPENAI = `import OpenAI from "openai";\nconst openai = new OpenAI();\n`;
const SDK = `import { generateText } from "ai";\n`;

describe("no-unguarded-llm-json-parse — the shapes that throw", () => {
  test("every one of these is real model output and none of them parses", () => {
    // Pinned as an executable fact, because the rule's whole case rests on it.
    const shapes = [
      '{"name":"Ada","bio":"a very long bi', // truncated at the token cap
      '```json\n{"ok":true}\n```', // fenced
      'Sure! Here is the JSON:\n{"ok":true}', // preamble
      '{"a":1,}', // trailing comma
      "{'a':1}", // single quotes
    ];
    for (const text of shapes) assert.throws(() => JSON.parse(text), SyntaxError, `expected ${text} to throw`);
    assert.doesNotThrow(() => JSON.parse('{"ok":true}'));
  });
});

describe("no-unguarded-llm-json-parse — fires", () => {
  test("the OpenAI content path", () => {
    const [f] = fires(
      `${OPENAI}const r = await openai.chat.completions.create({ model, messages });\nconst data = JSON.parse(r.choices[0].message.content);`,
    );
    assert.match(f!.message, /SyntaxError/);
    assert.match(f!.message, /truncated at the token cap/);
    assert.match(f!.message, /generateObject/);
  });

  test("an inline chain, with no binding at all", () => {
    fires(
      `${OPENAI}const data = JSON.parse((await openai.chat.completions.create({ model, messages })).choices[0].message.content);`,
    );
  });

  test("the Vercel SDK's destructured `text`, and an alias of it", () => {
    fires(`${SDK}const { text } = await generateText({ model, prompt });\nconst data = JSON.parse(text);`);
    fires(`${SDK}const res = await generateText({ model, prompt });\nconst raw = res.text;\nconst data = JSON.parse(raw);`);
  });

  test("a `try` with only a `finally` catches nothing", () => {
    fires(`${SDK}const { text } = await generateText({ model, prompt });\ntry { const d = JSON.parse(text); } finally { done(); }`);
  });

  test("a `try` OUTSIDE the function does not catch a throw from inside it", () => {
    // The callback runs later, on a different stack.
    fires(
      `${SDK}try { register(async () => { const { text } = await generateText({ model, prompt }); return JSON.parse(text); }); } catch {}`,
    );
  });
});

describe("no-unguarded-llm-json-parse — silent", () => {
  test("any enclosing `try`/`catch`, at any depth", () => {
    // Whether the handler is GOOD is not a claim this makes; that it exists is.
    silent(`${SDK}const { text } = await generateText({ model, prompt });\ntry { const d = JSON.parse(text); } catch { fallback(); }`);
    silent(
      `${SDK}const { text } = await generateText({ model, prompt });\ntry { if (x) { for (const y of z) { const d = JSON.parse(text); } } } catch (e) { log(e); }`,
    );
  });

  test("a schema-validating helper is the fix and is never matched", () => {
    silent(`import { generateObject } from "ai";\nconst { object } = await generateObject({ model, schema, prompt });`);
    silent(`${SDK}const { text } = await generateText({ model, prompt });\nconst d = safeParse(text);`);
    silent(`${SDK}const { text } = await generateText({ model, prompt });\nconst d = schema.safeParse(text);`);
  });

  test("input that is not proven model output", () => {
    silent(`${SDK}const data = JSON.parse(req.body.raw);`);
    silent(`${SDK}const data = JSON.parse(payload);`);
    silent(`${SDK}const data = JSON.parse(await readFile(p, "utf8"));`);
  });

  test("a local `JSON` is somebody else's object", () => {
    silent(`${SDK}export function f(JSON) { const text = ""; return JSON.parse(text); }`);
  });

  test("a file, or a project, with no AI SDK", () => {
    silent(`const r = await openai.chat.completions.create({ model, messages });\nJSON.parse(r.choices[0].message.content);`);
    silent(
      `${SDK}const { text } = await generateText({ model, prompt });\nJSON.parse(text);`,
      new Set(["node", "esm", "typescript"]),
    );
  });
});

describe("no-unguarded-llm-json-parse — determinism", () => {
  test("identical source yields identical findings", () => {
    const source = `${SDK}const { text } = await generateText({ model, prompt });\nconst a = JSON.parse(text);\nconst b = JSON.parse(text);`;
    assert.equal(JSON.stringify(findings(source)), JSON.stringify(findings(source)));
    assert.equal(findings(source).length, 2);
  });
});
