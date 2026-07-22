import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode, DiagnosticContext } from "../../core/types.ts";
import { staticMemberPath, getCalleeName, getStaticStringValue } from "../../core/ast.ts";

/**
 * A Node API that is deprecated or already removed (§83).
 *
 * These are the calls that keep working right up until the runtime upgrade that
 * deletes them — `new Buffer()` is a security footgun *and* removed, `url.parse`
 * mis-parses hostile URLs, `domain` has been dead for a decade. Flagging them is
 * how a version bump stops being an outage.
 *
 * Each entry names the modern replacement, because "deprecated" without the
 * substitute is not actionable.
 *
 * PRECISION: matching on the member name alone is not good enough. `url`, `fs`,
 * `crypto`, `domain` and `util` are among the most common variable names in
 * JavaScript, so a name-only match reports Prisma's `db.domain.create()`,
 * mem-fs's `generator.fs.exists()`, the `url-parse` package, and every test
 * mock. The receiver must therefore resolve to an actual import of the matching
 * Node built-in *in this file*; when it cannot, we stay silent. That loses
 * `this.fs = require("fs"); this.fs.exists()`, which is the correct trade under
 * "a false positive is a release blocker".
 *
 * ❌ new Buffer(input)            ✅ Buffer.from(input) / Buffer.alloc(n)
 * ❌ url.parse(userUrl)           ✅ new URL(userUrl)
 * ❌ fs.exists(p, cb)             ✅ fs.access / fs.promises.access
 */

interface Deprecation {
  since: string;
  replacement: string;
}

/** Member-path deprecations (`url.parse`, `util.isArray`, …). */
const DEPRECATED_PATHS: Record<string, Deprecation> = {
  "url.parse": { since: "Node 11", replacement: "`new URL(input)` — the legacy parser mis-handles hostile URLs" },
  "url.resolve": { since: "Node 11", replacement: "`new URL(relative, base)`" },
  "util.isArray": { since: "Node 4", replacement: "`Array.isArray`" },
  "util.isNullOrUndefined": { since: "Node 4", replacement: "`value == null`" },
  "util.isFunction": { since: "Node 4", replacement: "`typeof value === 'function'`" },
  "util.print": { since: "Node 0.12", replacement: "`console.log`" },
  "util._extend": { since: "Node 6", replacement: "`Object.assign`" },
  "fs.exists": { since: "Node 1", replacement: "`fs.access` / `fs.promises.access` (or just attempt the operation)" },
  "crypto.createCipher": { since: "Node 10", replacement: "`crypto.createCipheriv` with an explicit IV" },
  "crypto.createDecipher": { since: "Node 10", replacement: "`crypto.createDecipheriv` with an explicit IV" },
  "os.tmpDir": { since: "Node 7", replacement: "`os.tmpdir`" },
  "process.binding": { since: "Node 10", replacement: "a public API — `process.binding` is internal and unstable" },
  "domain.create": { since: "Node 4", replacement: "`AsyncLocalStorage` for context, `try/catch` + error middleware for errors" },
};

/** The built-in each receiver name must actually be bound to. */
const MODULE_FOR: Record<string, string> = {
  url: "url",
  util: "util",
  fs: "fs",
  crypto: "crypto",
  os: "os",
  domain: "domain",
};

/** Strip the `node:` prefix so `node:fs` and `fs` compare equal. */
const bareModule = (spec: string): string => (spec.startsWith("node:") ? spec.slice(5) : spec);

/**
 * Local name → the Node built-in it is bound to, for this file only.
 *
 * Covers the forms that actually appear: `import fs from "node:fs"`,
 * `import * as fs from "fs"`, `import { promises as fs } from "fs"`, and
 * `const fs = require("fs")` (including `const { exists } = require(...)`'s
 * parent binding, which we deliberately do not track — a destructured
 * `exists` has no receiver to match).
 */
const builtinNamespaces = (program: AstNode): Map<string, string> => {
  const bound = new Map<string, string>();

  for (const stmt of (program.body as AstNode[]) ?? []) {
    if (stmt.type === "ImportDeclaration") {
      if (stmt.importKind === "type") continue;
      const source = stmt.source?.value;
      if (typeof source !== "string") continue;
      const mod = bareModule(source);
      for (const spec of (stmt.specifiers as AstNode[]) ?? []) {
        if (spec.local?.type !== "Identifier") continue;
        if (spec.type === "ImportDefaultSpecifier" || spec.type === "ImportNamespaceSpecifier") {
          bound.set(spec.local.name as string, mod);
        }
      }
      continue;
    }

    // `const fs = require("node:fs")` — including an exported one.
    const decl = stmt.type === "ExportNamedDeclaration" ? (stmt.declaration as AstNode | null) : stmt;
    if (!decl || decl.type !== "VariableDeclaration") continue;
    for (const d of (decl.declarations as AstNode[]) ?? []) {
      if (d.id?.type !== "Identifier") continue;
      const init = d.init as AstNode | undefined;
      if (!init || init.type !== "CallExpression") continue;
      const callee = init.callee as AstNode | undefined;
      if (callee?.type !== "Identifier" || callee.name !== "require") continue;
      const arg = ((init.arguments as AstNode[]) ?? [])[0];
      const spec = arg ? getStaticStringValue(arg) : null;
      if (typeof spec === "string") bound.set(d.id.name as string, bareModule(spec));
    }
  }

  return bound;
};

/** Is `name` bound to the Node built-in that owns this deprecated member? */
const isBuiltinReceiver = (name: string, ctx: DiagnosticContext, namespaces: Map<string, string>): boolean => {
  // `process` is a global with no import; every other receiver must be bound.
  if (name === "process") return ctx.scope.getBinding("process", ctx.program) === null;
  const expected = MODULE_FOR[name];
  return expected !== undefined && namespaces.get(name) === expected;
};

export const noDeprecatedNodeApi = defineDiagnostic({
  id: "no-deprecated-node-api",
  title: "Deprecated or removed Node API",
  severity: "warn",
  category: "Maintainability",
  confidence: "high",
  tags: ["modernization", "deprecation"],
  recommendation:
    "Replace the deprecated API with its modern equivalent. These calls keep working until the runtime upgrade that removes them, at which point they become an outage rather than a warning.",
  create: (ctx) => {
    let namespaces: Map<string, string> | null = null;
    const bound = (): Map<string, string> => (namespaces ??= builtinNamespaces(ctx.program));

    return {
      NewExpression: (node) => {
        // `new Buffer(...)` — removed, and the unsafe-allocation footgun. Only the
        // global counts: a local class, parameter, or import named `Buffer` is
        // somebody else's type, and `Buffer.from` would be wrong advice for it.
        if (getCalleeName(node) !== "Buffer") return;
        if (ctx.scope.getBinding("Buffer", node) !== null) return;
        if (bound().has("Buffer")) return;
        ctx.report(
          node,
          "`new Buffer()` is deprecated and removed — use `Buffer.from(value)` for data or `Buffer.alloc(size)` for a zero-filled buffer (`new Buffer(number)` returned uninitialized memory).",
        );
      },
      CallExpression: (node) => {
        const path = staticMemberPath(node.callee as AstNode);
        if (!path) return;
        // Exactly two segments: `a.b.url.parse` is a userland `url`, never the
        // built-in, so a tail match there is a false positive by construction.
        const segments = path.split(".");
        if (segments.length !== 2) return;
        const hit = DEPRECATED_PATHS[path];
        if (!hit) return;
        if (!isBuiltinReceiver(segments[0]!, ctx, bound())) return;
        ctx.report(node, `\`${path}\` has been deprecated since ${hit.since} — use ${hit.replacement}.`);
      },
    };
  },
});
