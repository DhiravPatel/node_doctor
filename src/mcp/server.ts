/**
 * An MCP (Model Context Protocol) server exposing node.doctor as a native tool.
 *
 * This is the product thesis made literal: instead of only catching bad code
 * after the agent writes it, node.doctor becomes a tool the agent can *call* —
 * scan a directory, list diagnostics, explain a finding — over the same stdio JSON-RPC
 * transport Claude Desktop, Cursor, and other MCP clients speak. Register it once:
 *
 *   { "mcpServers": { "node-doctor": { "command": "npx",
 *       "args": ["node-doctor", "mcp"] } } }
 *
 * The dispatch (`handleMessage`) is pure and unit-tested; `startMcpServer` wires
 * it to stdin/stdout (newline-delimited JSON-RPC). Nothing but protocol messages
 * ever touches stdout — findings go to stderr.
 */

import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { scanProject, lintSource } from "../core/scan.ts";
import { toJson } from "../report/json.ts";
import { DIAGNOSTICS, DIAGNOSTICS_BY_ID } from "../core/registry.ts";
import { runDeslop } from "../deslop/index.ts";
import { discoverProject, shouldEnableDiagnostic } from "../core/project.ts";
import { computeDelta, deltaHasBlocking } from "../core/delta.ts";

const PROTOCOL_VERSION = "2024-11-05";

const version = (): string => {
  try {
    return (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string })
      .version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
};

const SERVER_INFO = { name: "node-doctor", version: version() };

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: "node_doctor_scan",
    description:
      "Run node.doctor static analysis on a Node.js backend directory. Returns a 0–100 health score and the full findings report (deterministic, offline). Use before declaring backend work complete.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Directory to scan (default: current working directory)." },
        blocking: {
          type: "string",
          enum: ["error", "warning", "none"],
          description: "Which findings count as blocking for the returned `blocking` flag.",
        },
      },
    },
  },
  {
    name: "node_doctor_diagnostics",
    description: "List every node.doctor diagnostic with its category, severity, and gating.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "node_doctor_explain",
    description: "Explain a single node.doctor diagnostic: what it catches and the exact fix mechanism.",
    inputSchema: {
      type: "object",
      properties: { diagnostic: { type: "string", description: "Diagnostic id, e.g. no-sql-template-interpolation." } },
      required: ["diagnostic"],
    },
  },
  {
    name: "node_doctor_deslop",
    description: "Find unused files, exports, and dependencies in a Node.js project (dead-code scan).",
    inputSchema: {
      type: "object",
      properties: { directory: { type: "string", description: "Directory to scan (default: cwd)." } },
    },
  },
  {
    name: "node_doctor_check_snippet",
    description:
      "Lint a code fragment BEFORE writing it to disk. Pass the code you are about to write and the path you intend to write it to; returns any node.doctor findings so you can correct the code first. Cheapest possible feedback loop — prefer this over writing then scanning.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "The source text you are about to write." },
        filePath: {
          type: "string",
          description: "Intended path (drives extension/context detection), e.g. src/routes/users.ts.",
        },
        directory: {
          type: "string",
          description: "Project directory used to detect frameworks/capabilities (default: cwd).",
        },
      },
      required: ["code"],
    },
  },
  {
    name: "node_doctor_scan_diff",
    description:
      "Baseline delta: report only the findings introduced between a baseline report and the current state. Matching is evidence-based, so moving code or shifting lines does not count as new.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Directory to scan as 'current' (default: cwd)." },
        baselinePath: { type: "string", description: "Path to a previously written --json-out baseline report." },
        blocking: { type: "string", enum: ["error", "warning", "none"], description: "Blocking policy for the delta." },
      },
      required: ["baselinePath"],
    },
  },
];

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], isError });

const callTool = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
  switch (name) {
    case "node_doctor_scan": {
      const dir = resolve(String(args.directory ?? "."));
      const blocking = (args.blocking as string) ?? "error";
      const report = await scanProject({ rootDirectory: dir });
      const isBlocking =
        blocking === "none"
          ? false
          : blocking === "warning"
            ? report.findings.length > 0
            : report.findings.some((d) => d.severity === "error");
      const summary =
        `node.doctor: ${report.score.score}/100 (${report.score.label}) · ` +
        `${report.findings.length} findings across ${report.project.analyzedFileCount} files · ` +
        `blocking=${isBlocking}\n\n`;
      return text(summary + toJson(report));
    }
    case "node_doctor_diagnostics": {
      const body = DIAGNOSTICS.map(
        (r) =>
          `node-doctor/${r.id}  [${r.category}/${r.severity}${r.defaultEnabled === false ? "/opt-in" : ""}]  ${r.title}`,
      ).join("\n");
      return text(`${DIAGNOSTICS.length} diagnostics:\n\n${body}`);
    }
    case "node_doctor_explain": {
      const id = String(args.diagnostic ?? "").replace(/^node-doctor\//, "");
      const diagnostic = DIAGNOSTICS_BY_ID.get(id);
      if (!diagnostic) return text(`Unknown diagnostic: ${args.diagnostic}. Call node_doctor_diagnostics for the catalog.`, true);
      const gating = [
        diagnostic.requires?.length ? `requires ${diagnostic.requires.join(", ")}` : "",
        diagnostic.disabledWhen?.length ? `off on ${diagnostic.disabledWhen.join(", ")}` : "",
        diagnostic.defaultEnabled === false ? "opt-in" : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return text(
        `# node-doctor/${diagnostic.id}\n${diagnostic.title}\n` +
          `Category: ${diagnostic.category} · Severity: ${diagnostic.severity}${gating ? ` · ${gating}` : ""}\n\n` +
          `Fix: ${diagnostic.recommendation}`,
      );
    }
    case "node_doctor_check_snippet": {
      const code = String(args.code ?? "");
      if (code.trim().length === 0) return text("check_snippet: `code` is required.", true);
      const filePath = String(args.filePath ?? "snippet.ts");
      const dir = resolve(String(args.directory ?? "."));
      // Detect the project's real capabilities so framework-gated diagnostics apply.
      let capabilities: Set<string>;
      try {
        capabilities = (await discoverProject(dir)).capabilities;
      } catch {
        capabilities = new Set(["node"]);
      }
      const active = DIAGNOSTICS.filter(
        (d) => (d.scope ?? "file") === "file" && shouldEnableDiagnostic(d, capabilities),
      );
      const { findings, parseFailed, errors } = lintSource({
        filePath,
        sourceText: code,
        diagnostics: active,
        capabilities,
      });
      if (parseFailed) {
        return text(`check_snippet: the snippet did not parse — ${errors[0] ?? "syntax error"}. Fix the syntax first.`, true);
      }
      if (findings.length === 0) {
        return text(`✓ No node.doctor findings in this snippet (${active.length} file-scope diagnostics active). Safe to write.`);
      }
      const body = findings
        .map(
          (f) =>
            `${f.severity === "error" ? "✖" : "⚠"} [${f.confidence} confidence] node-doctor/${f.diagnostic} at line ${f.line}:${f.column}\n` +
            `   ${f.message}\n   Fix: ${f.recommendation}`,
        )
        .join("\n\n");
      return text(
        `${findings.length} finding(s) in the snippet — correct these BEFORE writing the file:\n\n${body}`,
        true,
      );
    }
    case "node_doctor_scan_diff": {
      const dir = resolve(String(args.directory ?? "."));
      const baselinePath = resolve(String(args.baselinePath ?? ""));
      let baseline: Parameters<typeof computeDelta>[0];
      try {
        baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Parameters<typeof computeDelta>[0];
      } catch (err) {
        return text(`scan_diff: cannot read baseline ${baselinePath} — ${err instanceof Error ? err.message : String(err)}`, true);
      }
      const current = await scanProject({ rootDirectory: dir });
      const { introduced, resolved } = computeDelta(baseline, current);
      const blocking = (args.blocking as string) ?? "error";
      const isBlocking = deltaHasBlocking(introduced, blocking as "error" | "warning" | "none");
      if (introduced.length === 0) {
        return text(`✓ No findings introduced. ${resolved.length} resolved. Score ${current.score.score}/100.`);
      }
      const body = introduced
        .map(
          (f) =>
            `${f.severity === "error" ? "✖" : "⚠"} [${f.confidence}] node-doctor/${f.diagnostic} ${f.normalizedFilePath}:${f.line}:${f.column}\n   ${f.message}\n   Fix: ${f.recommendation}`,
        )
        .join("\n\n");
      return text(
        `${introduced.length} finding(s) introduced (${resolved.length} resolved) · blocking=${isBlocking}\n\n${body}`,
        isBlocking,
      );
    }
    case "node_doctor_deslop": {
      const dir = resolve(String(args.directory ?? "."));
      const r = await runDeslop(dir);
      return text(JSON.stringify(r, null, 2));
    }
    default:
      return text(`Unknown tool: ${name}`, true);
  }
};

/** Pure JSON-RPC dispatch. Returns null for notifications (no reply). */
export const handleMessage = async (msg: JsonRpcMessage): Promise<object | null> => {
  const { method, id } = msg;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: (msg.params?.protocolVersion as string) ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    };
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  if (method === "tools/call") {
    try {
      const result = await callTool(
        String(msg.params?.name ?? ""),
        (msg.params?.arguments as Record<string, unknown>) ?? {},
      );
      return { jsonrpc: "2.0", id, result };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        result: text(`Error: ${err instanceof Error ? err.message : String(err)}`, true),
      };
    }
  }
  if (method?.startsWith("notifications/")) return null; // notifications get no reply

  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
};

/** Start the stdio MCP server. Resolves when stdin closes. */
export const startMcpServer = (): Promise<void> =>
  new Promise((resolvePromise) => {
    process.stderr.write("node-doctor MCP server ready (stdio).\n");
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(trimmed) as JsonRpcMessage;
      } catch {
        return; // ignore non-JSON lines
      }
      void handleMessage(msg).then((response) => {
        if (response) process.stdout.write(JSON.stringify(response) + "\n");
      });
    });
    rl.on("close", () => resolvePromise());
  });
