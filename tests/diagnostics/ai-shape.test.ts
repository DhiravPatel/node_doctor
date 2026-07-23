/**
 * The three shape-based AI-security diagnostics (§106, §108, §109).
 *
 * These drive `lintSource` with the diagnostic module directly (independent of
 * the generated registry). The bulk of every block is the SILENT half: for an
 * unproven AI-security domain a false positive is a release blocker, so the
 * cases that must NOT fire (returning the model's answer, a validated tool
 * argument, a fixed ≤3 fan-out, a file that never imports an AI SDK) carry the
 * weight. Each rule is also asserted inert without its capability.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import type { Diagnostic, Finding } from "../../src/core/types.ts";
import { aiCallInLoop } from "../../src/diagnostics/ai/ai-call-in-loop.ts";
import { noSystemPromptLeak } from "../../src/diagnostics/ai/no-system-prompt-leak.ts";
import { mcpToolUnrestrictedCapability } from "../../src/diagnostics/ai/mcp-tool-unrestricted-capability.ts";

const AI = new Set(["node", "esm", "typescript", "ai"]);
const MCP = new Set(["node", "esm", "typescript", "ai", "mcp"]);

const findingsFor = (diagnostic: Diagnostic, source: string, capabilities: Set<string>): Finding[] =>
  lintSource({ filePath: "test.ts", sourceText: source, diagnostics: [diagnostic], capabilities })
    .findings.filter((f) => f.diagnostic === diagnostic.id);

const fires = (diagnostic: Diagnostic, source: string, caps: Set<string> = AI): Finding[] => {
  const found = findingsFor(diagnostic, source, caps);
  assert.ok(found.length > 0, `expected ${diagnostic.id} to FIRE on:\n${source}`);
  return found;
};

const silent = (diagnostic: Diagnostic, source: string, caps: Set<string> = AI): void => {
  const found = findingsFor(diagnostic, source, caps);
  assert.equal(
    found.length,
    0,
    `expected ${diagnostic.id} to STAY SILENT, got ${found.length}:\n` +
      found.map((f) => `  - ${f.message} @ ${f.line}:${f.column}`).join("\n") +
      `\n--- source ---\n${source}`,
  );
};

const AI_IMPORT = `import { generateText, generateObject } from "ai";\n`;
const OPENAI_IMPORT = `import OpenAI from "openai";\n`;
const ANTHROPIC_IMPORT = `import Anthropic from "@anthropic-ai/sdk";\n`;
const MCP_IMPORT =
  `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";\n` +
  `import { exec } from "node:child_process";\n` +
  `import fs from "node:fs/promises";\n`;

// ---------------------------------------------------------------------------
// §109 ai-call-in-loop
// ---------------------------------------------------------------------------

describe("ai-call-in-loop", () => {
  test("fires on generateText in a for..of loop", () => {
    fires(
      aiCallInLoop,
      AI_IMPORT + `async function f(docs){ for (const d of docs){ await generateText({ prompt: d.body }); } }`,
    );
  });

  test("fires on a call in a while loop", () => {
    fires(aiCallInLoop, AI_IMPORT + `async function f(c){ while (c){ await generateText({ prompt: "x" }); } }`);
  });

  test("fires on an LLM call inside a .map callback", () => {
    fires(
      aiCallInLoop,
      AI_IMPORT + `async function f(us){ await Promise.all(us.map((u)=> generateObject({ prompt: u.bio }))); }`,
    );
  });

  test("fires on an LLM call inside a .forEach callback", () => {
    fires(aiCallInLoop, AI_IMPORT + `function f(us){ us.forEach((u)=> generateText({ prompt: u.bio })); }`);
  });

  test("fires on openai.chat.completions.create in a loop", () => {
    fires(
      aiCallInLoop,
      OPENAI_IMPORT + `async function f(rows, o){ for (const r of rows){ await o.chat.completions.create({ messages: [] }); } }`,
    );
  });

  test("fires on a loop over a large (>3) array literal", () => {
    fires(
      aiCallInLoop,
      AI_IMPORT + `async function f(){ for (const l of ["a","b","c","d"]){ await generateText({ prompt: l }); } }`,
    );
  });

  test("silent when the call is not in any loop", () => {
    silent(aiCallInLoop, AI_IMPORT + `async function f(){ await generateText({ prompt: "x" }); }`);
  });

  test("silent on a fixed fan-out over a small (<=3) array literal", () => {
    silent(
      aiCallInLoop,
      AI_IMPORT + `async function f(){ for (const l of ["en","fr","de"]){ await generateText({ prompt: l }); } }`,
    );
  });

  test("silent on a .map over a small array literal", () => {
    silent(
      aiCallInLoop,
      AI_IMPORT + `async function f(){ await Promise.all(["en","fr"].map((l)=> generateText({ prompt: l }))); }`,
    );
  });

  test("silent on a for..of over a const small array binding", () => {
    silent(
      aiCallInLoop,
      AI_IMPORT + `const LANGS = ["en","fr"];\nasync function f(){ for (const l of LANGS){ await generateText({ prompt: l }); } }`,
    );
  });

  test("silent on a non-LLM call in a loop", () => {
    silent(
      aiCallInLoop,
      AI_IMPORT + `async function f(rows, db){ for (const r of rows){ await db.user.create({ data: r }); } }`,
    );
  });

  test("silent when the file imports no AI SDK", () => {
    silent(aiCallInLoop, `async function f(rows){ for (const r of rows){ await generateText({ prompt: r }); } }`);
  });

  test("silent without the ai capability", () => {
    silent(
      aiCallInLoop,
      AI_IMPORT + `async function f(docs){ for (const d of docs){ await generateText({ prompt: d.body }); } }`,
      new Set(["node", "esm"]),
    );
  });
});

// ---------------------------------------------------------------------------
// §108 no-system-prompt-leak
// ---------------------------------------------------------------------------

describe("no-system-prompt-leak", () => {
  test("fires when the system-prompt binding is returned in an HTTP response", () => {
    fires(
      noSystemPromptLeak,
      AI_IMPORT +
        `async function h(req,res){ const system = "rules " + process.env.K; await generateText({ system, prompt: req.body.q }); res.json({ system }); }`,
    );
  });

  test("fires when the system-prompt binding is logged", () => {
    fires(
      noSystemPromptLeak,
      AI_IMPORT + `async function h(){ const sp = "guardrails"; await generateText({ system: sp, prompt: "x" }); console.log(sp); }`,
    );
  });

  test("fires when the system prompt is embedded in an error message", () => {
    fires(
      noSystemPromptLeak,
      AI_IMPORT + `async function h(){ const system = "rules"; await generateText({ system, prompt: "x" }); throw new Error("bad " + system); }`,
    );
  });

  test("fires for anthropic.messages.create system option", () => {
    fires(
      noSystemPromptLeak,
      ANTHROPIC_IMPORT +
        `async function h(res, a){ const system = "rules"; await a.messages.create({ system, messages: [] }); res.send(system); }`,
    );
  });

  test("silent when the endpoint returns the model's answer", () => {
    silent(
      noSystemPromptLeak,
      AI_IMPORT +
        `async function h(req,res){ const system = "rules"; const { text } = await generateText({ system, prompt: req.body.q }); res.json({ text }); }`,
    );
  });

  test("silent on an inline string-literal system prompt (no binding to leak)", () => {
    silent(
      noSystemPromptLeak,
      AI_IMPORT + `async function h(req,res){ await generateText({ system: "rules", prompt: req.body.q }); res.json({ ok: true }); }`,
    );
  });

  test("silent when a different binding is returned", () => {
    silent(
      noSystemPromptLeak,
      AI_IMPORT +
        `async function h(res){ const system = "rules"; await generateText({ system, prompt: "x" }); const answer = "hi"; res.json({ answer }); }`,
    );
  });

  test("silent when the file imports no AI SDK", () => {
    silent(noSystemPromptLeak, `async function h(res){ const system = "rules"; res.json({ system }); }`);
  });

  test("silent without the ai capability", () => {
    silent(
      noSystemPromptLeak,
      AI_IMPORT + `async function h(res){ const system = "rules"; await generateText({ system, prompt: "x" }); res.json({ system }); }`,
      new Set(["node", "esm"]),
    );
  });
});

// ---------------------------------------------------------------------------
// §106 mcp-tool-unrestricted-capability
// ---------------------------------------------------------------------------

describe("mcp-tool-unrestricted-capability", () => {
  test("fires when a tool argument reaches child_process exec", () => {
    fires(
      mcpToolUnrestrictedCapability,
      MCP_IMPORT + `const server = new McpServer();\nserver.tool("run", schema, async ({ cmd }) => { return exec(cmd); });`,
      MCP,
    );
  });

  test("fires when a tool argument reaches an fs write", () => {
    fires(
      mcpToolUnrestrictedCapability,
      MCP_IMPORT +
        `const server = new McpServer();\nserver.registerTool("save", schema, async ({ path, data }) => { await fs.writeFile(path, data); });`,
      MCP,
    );
  });

  test("fires when a tool argument reaches eval", () => {
    fires(
      mcpToolUnrestrictedCapability,
      MCP_IMPORT + `const server = new McpServer();\nserver.tool("calc", schema, async ({ expr }) => { return eval(expr); });`,
      MCP,
    );
  });

  test("fires for setRequestHandler whose request drives exec", () => {
    fires(
      mcpToolUnrestrictedCapability,
      MCP_IMPORT +
        `const server = new McpServer();\nserver.setRequestHandler(CallToolRequestSchema, async (request) => { return exec(request.params.arguments.cmd); });`,
      MCP,
    );
  });

  test("fires when a tool argument reaches a raw SQL sink", () => {
    fires(
      mcpToolUnrestrictedCapability,
      MCP_IMPORT +
        `const server = new McpServer();\nserver.tool("q", schema, async ({ table }) => { return db.$queryRawUnsafe("SELECT * FROM " + table); });`,
      MCP,
    );
  });

  test("silent when the tool only reads/returns data", () => {
    silent(
      mcpToolUnrestrictedCapability,
      MCP_IMPORT + `const server = new McpServer();\nserver.tool("weather", schema, async ({ city }) => { return { city }; });`,
      MCP,
    );
  });

  test("silent when the argument is constrained by a z.enum schema", () => {
    silent(
      mcpToolUnrestrictedCapability,
      MCP_IMPORT + `const server = new McpServer();\nserver.tool("run", { cmd: z.enum(["ls","pwd"]) }, async ({ cmd }) => { return exec(cmd); });`,
      MCP,
    );
  });

  test("silent when a switch allowlists the argument", () => {
    silent(
      mcpToolUnrestrictedCapability,
      MCP_IMPORT +
        `const server = new McpServer();\nserver.tool("run", schema, async ({ cmd }) => { switch(cmd){ case "ls": return exec("ls"); } });`,
      MCP,
    );
  });

  test("silent when an .includes allowlist guards the argument", () => {
    silent(
      mcpToolUnrestrictedCapability,
      MCP_IMPORT +
        `const server = new McpServer();\nconst OK = ["ls","pwd"];\nserver.tool("run", schema, async ({ cmd }) => { if(!OK.includes(cmd)) throw new Error("no"); return exec(cmd); });`,
      MCP,
    );
  });

  test("silent when the sink argument is a static literal", () => {
    silent(
      mcpToolUnrestrictedCapability,
      MCP_IMPORT + `const server = new McpServer();\nserver.tool("run", schema, async ({ cmd }) => { return exec("ls -la"); });`,
      MCP,
    );
  });

  test("silent on RegExp.exec (not child_process)", () => {
    silent(
      mcpToolUnrestrictedCapability,
      MCP_IMPORT + `const server = new McpServer();\nserver.tool("m", schema, async ({ p }) => { const re = /x/; return re.exec(p); });`,
      MCP,
    );
  });

  test("silent on an ORM .query (not a raw SQL string)", () => {
    silent(
      mcpToolUnrestrictedCapability,
      MCP_IMPORT + `const server = new McpServer();\nserver.tool("find", schema, async ({ id }, extra) => { return db.user.query({ id }); });`,
      MCP,
    );
  });

  test("silent when the file does not import the MCP SDK", () => {
    silent(
      mcpToolUnrestrictedCapability,
      `import { exec } from "node:child_process";\nconst server = makeServer();\nserver.tool("run", schema, async ({ cmd }) => { return exec(cmd); });`,
      MCP,
    );
  });

  test("silent without the mcp capability", () => {
    silent(
      mcpToolUnrestrictedCapability,
      MCP_IMPORT + `const server = new McpServer();\nserver.tool("run", schema, async ({ cmd }) => { return exec(cmd); });`,
      AI,
    );
  });
});
