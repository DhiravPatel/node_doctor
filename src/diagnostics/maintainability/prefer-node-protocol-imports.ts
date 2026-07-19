import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getCalleeName } from "../../core/ast.ts";

/**
 * A Node core module imported without the `node:` protocol prefix. The bare
 * specifier (`"fs"`) is ambiguous with an npm package of the same name and lets
 * a malicious `fs` package on disk win resolution; the `node:` form is
 * unambiguous, faster to resolve, and self-documenting. OPT-IN: pure hygiene,
 * off by default.
 *
 * ❌ import fs from "fs";
 * ❌ const path = require("path");
 * ✅ import fs from "node:fs";
 * ✅ import express from "express";        // third-party — untouched
 * ✅ import { asyncHandler } from "./mw.js"; // relative — untouched
 */

/** Well-known Node core module base names (subpaths like `fs/promises` map by base). */
const CORE_MODULES = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

/** Is `spec` a bare (non-prefixed) reference to a Node core module? */
const isBareCoreModule = (spec: string | null | undefined): boolean => {
  if (typeof spec !== "string" || spec.length === 0) return false;
  if (spec.startsWith("node:")) return false; // already prefixed
  if (spec.startsWith(".") || spec.startsWith("/")) return false; // relative/absolute
  const base = spec.split("/")[0]!;
  return CORE_MODULES.has(base);
};

export const preferNodeProtocolImports = defineDiagnostic({
  id: "prefer-node-protocol-imports",
  title: "Core module imported without the node: protocol",
  severity: "warn",
  category: "Maintainability",
  tags: ["hygiene"],
  defaultEnabled: false,
  recommendation:
    "Prefix the specifier with `node:` (e.g. `import fs from 'node:fs'`). The protocol form is unambiguous with npm packages and resolves faster.",
  create: (ctx) => ({
    ImportDeclaration: (node) => {
      const source = node.source as AstNode | undefined;
      if (!source || source.type !== "Literal") return;
      if (!isBareCoreModule(source.value as string)) return;
      ctx.report(source, `Core module "${source.value}" is imported without the \`node:\` protocol prefix.`);
    },
    CallExpression: (node) => {
      if (getCalleeName(node) !== "require") return;
      const arg0 = (node.arguments as AstNode[])[0];
      if (!arg0 || arg0.type !== "Literal") return;
      if (!isBareCoreModule(arg0.value as string)) return;
      ctx.report(arg0, `Core module "${arg0.value}" is required without the \`node:\` protocol prefix.`);
    },
  }),
});
