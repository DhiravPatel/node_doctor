/**
 * Two false positives in shipped, default-on rules, both found by an adversarial
 * scoping pass that rejected every rule it was asked to evaluate. Kept here
 * because each was reported at the bar this project treats as a release blocker.
 *
 *   1. A loop's HEAD is not the loop. `for await (const c of await llm.create(…))`
 *      evaluates that call exactly once, and a `for` statement's `init` runs
 *      once — but a climb that only asks "is there a loop above me?" reported
 *      both as running per iteration.
 *   2. `looksCallerControlled` re-derived "is this a request root?" from the NAME,
 *      defeating the local-declaration exclusion `computeTaint` had deliberately
 *      applied — so a diff utility's `const context = …` read as caller data to
 *      thirteen security rules.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { aiCallInLoop } from "../../src/diagnostics/ai/ai-call-in-loop.ts";
import { noQueryInLoop } from "../../src/diagnostics/db/no-query-in-loop.ts";
import { noPromptInjection } from "../../src/diagnostics/ai/no-prompt-injection.ts";

const CAPS = new Set(["node", "esm", "typescript", "ai", "prisma"]);
const findings = (source: string, rules: unknown[]) =>
  lintSource({ filePath: "/repo/src/a.ts", sourceText: source, diagnostics: rules as never, capabilities: CAPS })
    .findings;

const silent = (source: string, rules: unknown[]): void => {
  const found = findings(source, rules);
  assert.equal(
    found.length,
    0,
    `expected SILENCE, got ${found.length}: ${found.map((f) => f.diagnostic).join(", ")}\n${source}`,
  );
};
const fires = (source: string, rules: unknown[]): void => {
  assert.ok(findings(source, rules).length > 0, `expected a FIRE on:\n${source}`);
};

const LOOP_RULES = [aiCallInLoop, noQueryInLoop];

describe("a loop's HEAD runs once, not per iteration", () => {
  test("the canonical OpenAI streaming idiom is one call", () => {
    silent(
      `import OpenAI from "openai";\nconst client = new OpenAI();\nfor await (const chunk of await client.chat.completions.create({ stream: true, model, messages })) { out(chunk); }`,
      LOOP_RULES,
    );
  });

  test("`streamText(…).textStream` in the head is one call", () => {
    silent(`import { streamText } from "ai";\nfor await (const delta of streamText({ model, prompt }).textStream) { out(delta); }`, LOOP_RULES);
  });

  test("a cursor query in the head is one query, not an N+1", () => {
    silent(`for await (const row of prisma.user.findMany({ where })) { handle(row); }`, LOOP_RULES);
  });

  test("a `for` statement's `init` is evaluated once", () => {
    silent(`for (let rows = await db.user.findMany({}), i = 0; i < rows.length; i++) { use(rows[i]); }`, LOOP_RULES);
  });

  test("but the BODY still fires, and so does a `for` TEST — it re-runs", () => {
    fires(`import { generateText } from "ai";\nfor (const doc of docs) { await generateText({ prompt: doc }); }`, LOOP_RULES);
    fires(`for (const id of ids) { await prisma.user.findMany({ where: { id } }); }`, LOOP_RULES);
    fires(`for (let i = 0; i < (await db.user.count({})); i++) { work(i); }`, LOOP_RULES);
  });
});

describe("a locally-declared request-root NAME is not caller data", () => {
  const SDK = `import { generateText } from "ai";\n`;

  test("`context` and `event` declared locally are ordinary variables", () => {
    // `computeTaint` already excluded these deliberately — its own comment cites
    // a diff utility's "lines of context". `looksCallerControlled` re-derived the
    // name check and defeated it for every rule that calls it.
    silent(`${SDK}const context = "Q3 revenue was up.";\nawait generateText({ model, prompt: \`Summarize:\\n\${context}\` });`, [
      noPromptInjection,
    ]);
    silent(`${SDK}const event = "deploy finished";\nawait generateText({ model, prompt: \`Describe: \${event}\` });`, [
      noPromptInjection,
    ]);
    silent(
      `${SDK}const lines = read();\nconst context = lines.slice(0, 3).join("\\n");\nawait generateText({ model, system: \`Diff context:\\n\${context}\` });`,
      [noPromptInjection],
    );
  });

  test("a genuine request root still taints, directly and through a binding", () => {
    fires(`${SDK}export async function h(req) { return generateText({ model, prompt: \`Summarize: \${req.body.text}\` }); }`, [
      noPromptInjection,
    ]);
    fires(
      `${SDK}export async function h(req) { const t = req.body.text; return generateText({ model, system: \`Rules: \${t}\` }); }`,
      [noPromptInjection],
    );
  });

  test("a PARAMETER named `context` is a known, deliberate boundary", () => {
    // Not fixed, and the reason is a real trade-off rather than an oversight:
    // AWS Lambda's handler is `(event, context)`, where `event` genuinely IS the
    // caller-controlled payload. Excluding these names as parameters would lose
    // that, so a parameter keeps its request-root meaning.
    fires(`${SDK}export async function f(context: string) { return generateText({ model, prompt: \`Summarize: \${context}\` }); }`, [
      noPromptInjection,
    ]);
  });
});
