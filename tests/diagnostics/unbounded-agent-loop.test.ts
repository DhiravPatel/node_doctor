/**
 * §109 — `no-unbounded-agent-loop`.
 *
 * The sibling of `ai-call-in-loop`: there the loop's size is controlled by the
 * input, here by nothing at all. The claim is the syntactic one — this loop
 * counts nothing — not a judgement about whether an existing counter is right.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noUnboundedAgentLoop } from "../../src/diagnostics/ai/no-unbounded-agent-loop.ts";

const AI = new Set(["node", "esm", "typescript", "ai"]);

const findings = (source: string, capabilities = AI) =>
  lintSource({
    filePath: "/repo/src/agent.ts",
    sourceText: source,
    diagnostics: [noUnboundedAgentLoop],
    capabilities,
  }).findings.filter((f) => f.diagnostic === "no-unbounded-agent-loop");

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

describe("no-unbounded-agent-loop — fires", () => {
  test("the standard agent loop, whose only exit is the model", () => {
    const [f] = fires(
      `${SDK}while (true) {\n  const r = await generateText({ messages, tools });\n  if (r.finishReason === "stop") break;\n  messages.push(...(await runTools(r.toolCalls)));\n}`,
    );
    assert.match(f!.message, /never counts an iteration/);
    assert.match(f!.message, /step budget/);
  });

  test("every syntactically infinite form", () => {
    fires(`${SDK}for (;;) { const r = await generateText({ prompt }); if (done(r)) break; }`);
    fires(`${SDK}for (; true; ) { const r = await generateText({ prompt }); if (done(r)) break; }`);
    fires(`${SDK}do { await generateText({ prompt }); } while (true);`);
  });

  test("the OpenAI client shape", () => {
    fires(`${OPENAI}while (true) { const r = await openai.chat.completions.create({ model, messages }); if (r.done) break; }`);
  });

  test("one finding per loop, however many calls it makes", () => {
    assert.equal(
      findings(`${SDK}while (true) { await generateText({ prompt: a }); await generateText({ prompt: b }); if (x) break; }`).length,
      1,
    );
  });
});

describe("no-unbounded-agent-loop — silent", () => {
  test("any counter at all means the author has a budget", () => {
    // Whether the counter is compared correctly is a different claim, and one
    // this rule deliberately does not make.
    silent(`${SDK}let steps = 0;\nwhile (true) { steps++; if (steps > 10) break; await generateText({ prompt }); }`);
    silent(`${SDK}let n = 0;\nwhile (true) { n += 1; if (n > 5) break; await generateText({ prompt }); }`);
    silent(`${SDK}while (true) { budget -= 1; await generateText({ prompt }); if (budget <= 0) break; }`);
  });

  test("a loop that already has a bound", () => {
    silent(`${SDK}for (let i = 0; i < MAX_STEPS; i++) { await generateText({ prompt }); }`);
    silent(`${SDK}while (!done) { await generateText({ prompt }); }`);
    silent(`${SDK}for (const doc of docs) { await generateText({ prompt: doc }); }`);
  });

  test("an infinite loop with no model call in it", () => {
    silent(`${SDK}while (true) { await poll(); }`);
  });

  test("a call nested in an inner function is not in this loop", () => {
    silent(`${SDK}while (true) { queue.push(() => generateText({ prompt })); if (x) break; }`);
  });

  test("a file that does not import an AI SDK", () => {
    silent(`while (true) { const r = await generateText({ prompt }); if (r.x) break; }`);
  });

  test("a project with no AI dependency at all", () => {
    silent(`${SDK}while (true) { const r = await generateText({ prompt }); if (r.x) break; }`, new Set(["node", "esm", "typescript"]));
  });
});

describe("no-unbounded-agent-loop — determinism", () => {
  test("identical source yields identical findings", () => {
    const source = `${SDK}while (true) { await generateText({ prompt: a }); if (x) break; }\nfor (;;) { await generateText({ prompt: b }); if (y) break; }`;
    assert.equal(JSON.stringify(findings(source)), JSON.stringify(findings(source)));
    assert.equal(findings(source).length, 2);
  });
});
