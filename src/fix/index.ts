/**
 * Autofix — a deliberately tiny set of *mechanically safe* codemods.
 *
 * node.doctor is a detector, not a fixer, for the security/concurrency findings:
 * an auto-fixer for those would need to be far more certain than a heuristic can
 * be. `--fix` therefore only applies transformations that cannot change behavior
 * — today, adding the `node:` protocol prefix to core-module imports.
 *
 * Fixers are text edits keyed by diagnostic id, applied right-to-left so offsets stay
 * valid. Adding a fixer is one entry in FIXERS.
 */

import type { AstNode } from "../core/types.ts";
import { parseSource } from "../core/parse.ts";
import { walk } from "../core/walk.ts";
import { getCalleeName } from "../core/ast.ts";

/** Node.js built-in modules that take a `node:` prefix. */
const CORE_MODULES = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants",
  "crypto", "dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http",
  "http2", "https", "inspector", "module", "net", "os", "path", "perf_hooks", "process",
  "punycode", "querystring", "readline", "repl", "stream", "string_decoder", "timers",
  "tls", "trace_events", "tty", "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib",
]);

interface Edit {
  start: number;
  end: number;
  text: string;
}

const nodeProtocolEdits = (program: AstNode, source: string): Edit[] => {
  const edits: Edit[] = [];

  const consider = (specNode: AstNode | null | undefined): void => {
    if (!specNode || specNode.type !== "Literal" || typeof specNode.value !== "string") return;
    if (!CORE_MODULES.has(specNode.value)) return;
    const raw = source.slice(specNode.start, specNode.end);
    const quote = raw[0] === '"' || raw[0] === "'" || raw[0] === "`" ? raw[0] : '"';
    edits.push({ start: specNode.start, end: specNode.end, text: `${quote}node:${specNode.value}${quote}` });
  };

  for (const stmt of (program.body as AstNode[]) ?? []) {
    if (stmt.type === "ImportDeclaration") consider(stmt.source);
    else if ((stmt.type === "ExportNamedDeclaration" || stmt.type === "ExportAllDeclaration") && stmt.source) {
      consider(stmt.source);
    }
  }
  walk(program, {
    enter: (node) => {
      if (node.type === "CallExpression" && getCalleeName(node) === "require") {
        consider((node.arguments as AstNode[])?.[0]);
      } else if (node.type === "ImportExpression") {
        consider(node.source);
      }
    },
  });
  return edits;
};

const FIXERS: Record<string, (program: AstNode, source: string) => Edit[]> = {
  "prefer-node-protocol-imports": nodeProtocolEdits,
};

/** Diagnostic ids that have a safe autofix. */
export const FIXABLE_DIAGNOSTICS = Object.keys(FIXERS);

/** Apply the safe fixes to one source string. Returns the new text + edit count. */
export const fixSource = (
  filePath: string,
  sourceText: string,
  ruleIds?: Set<string>,
): { fixed: string; applied: number } => {
  const { program, parseFailed } = parseSource(filePath, sourceText);
  if (parseFailed) return { fixed: sourceText, applied: 0 };

  const edits: Edit[] = [];
  for (const [id, fixer] of Object.entries(FIXERS)) {
    if (ruleIds && !ruleIds.has(id)) continue;
    edits.push(...fixer(program, sourceText));
  }
  if (edits.length === 0) return { fixed: sourceText, applied: 0 };

  edits.sort((a, b) => b.start - a.start); // right-to-left
  let out = sourceText;
  let applied = 0;
  let lastStart = Infinity;
  for (const e of edits) {
    if (e.end > lastStart) continue; // skip overlapping edits
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    lastStart = e.start;
    applied += 1;
  }
  return { fixed: out, applied };
};
