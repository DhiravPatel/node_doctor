import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode, DiagnosticContext } from "../../core/types.ts";
import { staticMemberPath, getCalleeName, getStaticStringValue } from "../../core/ast.ts";

/**
 * A Node API that is deprecated or already removed (§83).
 *
 * These are the calls that keep working right up until the runtime upgrade that
 * deletes them — `url.parse` mis-parses hostile URLs, `crypto.createCipher`
 * derives a key with no salt, `util.isString` is simply gone. Flagging them is
 * how a version bump stops being an outage.
 *
 * EVERY ENTRY CARRIES ITS STATUS, AND THE MESSAGE SAYS WHICH.
 *
 * "Deprecated" is four different facts in Node's own vocabulary, and conflating
 * them makes the message wrong in the reader's hands. A fact-table entry that
 * overstates is a false positive with a version number on it, and an audit
 * against `doc/api/deprecations.md` found this table doing exactly that:
 * `new Buffer()` was described as "deprecated and removed" when it has never
 * been removed and is alive on `main`; `crypto.createCipher` was dated "Node 10"
 * (its documentation-only date) when the removal was Node 22; `util.isFunction`
 * was dated Node 4 and removed in Node 23; and `url.parse` cited a deprecation
 * that Node later REVOKED. Every date and status below is now taken from
 * Node's own deprecation list.
 *
 *   end-of-life      — the API is GONE. Upgrading past `removedIn` throws.
 *   runtime          — calling it prints a DeprecationWarning today.
 *   application      — warns, but only for code outside `node_modules`.
 *   documentation-only — discouraged; no warning and no removal scheduled.
 *
 * Only an `end-of-life` entry may say "this breaks when you upgrade".
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

type DeprecationStatus = "end-of-life" | "runtime" | "application" | "documentation-only";

interface Deprecation {
  /** Node's own identifier — the reader's search key. */
  dep: string;
  status: DeprecationStatus;
  /** When the CURRENT status began. */
  since: string;
  /** Set only for `end-of-life`: the release that deleted it. */
  removedIn?: string;
  replacement: string;
}

/**
 * Member-path deprecations (`url.parse`, `util.isArray`, …), verified entry by
 * entry against `doc/api/deprecations.md`.
 */
const DEPRECATED_PATHS: Record<string, Deprecation> = {
  // --- End-of-life: gone. Upgrading past `removedIn` is a TypeError. ---------
  "crypto.createCipher": {
    dep: "DEP0106",
    status: "end-of-life",
    // `since` is when the CURRENT status began — the removal, not the earlier
    // documentation-only date.
    since: "Node 22",
    removedIn: "Node 22",
    replacement:
      "`crypto.createCipheriv` with an explicit IV, and a key derived with `crypto.scrypt`/`pbkdf2` over a random salt",
  },
  "crypto.createDecipher": {
    dep: "DEP0106",
    status: "end-of-life",
    since: "Node 22",
    removedIn: "Node 22",
    replacement: "`crypto.createDecipheriv` with an explicit IV",
  },
  "util.isArray": {
    // Survived the Node 23 purge that took its siblings — still present today.
    dep: "DEP0044",
    status: "runtime",
    since: "Node 22",
    replacement: "`Array.isArray(value)`",
  },
  "util._extend": { dep: "DEP0060", status: "runtime", since: "Node 22", replacement: "`Object.assign(target, source)`" },
  "util.isBoolean": { dep: "DEP0045", status: "end-of-life", since: "Node 4", removedIn: "Node 23", replacement: "`typeof value === \"boolean\"`" },
  "util.isBuffer": { dep: "DEP0046", status: "end-of-life", since: "Node 4", removedIn: "Node 23", replacement: "`Buffer.isBuffer(value)`" },
  "util.isDate": { dep: "DEP0047", status: "end-of-life", since: "Node 4", removedIn: "Node 23", replacement: "`value instanceof Date`" },
  "util.isError": { dep: "DEP0048", status: "end-of-life", since: "Node 4", removedIn: "Node 23", replacement: "`value instanceof Error`" },
  "util.isFunction": { dep: "DEP0049", status: "end-of-life", since: "Node 4", removedIn: "Node 23", replacement: "`typeof value === \"function\"`" },
  "util.isNull": { dep: "DEP0050", status: "end-of-life", since: "Node 4", removedIn: "Node 23", replacement: "`value === null`" },
  "util.isNullOrUndefined": { dep: "DEP0051", status: "end-of-life", since: "Node 4", removedIn: "Node 23", replacement: "`value == null`" },
  "util.isNumber": { dep: "DEP0052", status: "end-of-life", since: "Node 4", removedIn: "Node 23", replacement: "`typeof value === \"number\"`" },
  "util.isObject": { dep: "DEP0053", status: "end-of-life", since: "Node 4", removedIn: "Node 23", replacement: "`value !== null && typeof value === \"object\"`" },
  "util.isPrimitive": { dep: "DEP0054", status: "end-of-life", since: "Node 4", removedIn: "Node 23", replacement: "`Object(value) !== value`" },
  "util.isRegExp": { dep: "DEP0055", status: "end-of-life", since: "Node 4", removedIn: "Node 23", replacement: "`value instanceof RegExp`" },
  "util.isString": { dep: "DEP0056", status: "end-of-life", since: "Node 4", removedIn: "Node 23", replacement: "`typeof value === \"string\"`" },
  "util.isSymbol": { dep: "DEP0057", status: "end-of-life", since: "Node 4", removedIn: "Node 23", replacement: "`typeof value === \"symbol\"`" },
  "util.isUndefined": { dep: "DEP0058", status: "end-of-life", since: "Node 4", removedIn: "Node 23", replacement: "`value === undefined`" },
  "util.log": { dep: "DEP0059", status: "end-of-life", since: "Node 6", removedIn: "Node 23", replacement: "a real logger, or `console.log(new Date().toLocaleString(), message)`" },
  "util.print": { dep: "DEP0026", status: "end-of-life", since: "Node 0.12", removedIn: "Node 12", replacement: "`console.log`" },
  "util.puts": { dep: "DEP0027", status: "end-of-life", since: "Node 0.12", removedIn: "Node 12", replacement: "`console.log`" },
  "util.error": { dep: "DEP0029", status: "end-of-life", since: "Node 0.12", removedIn: "Node 12", replacement: "`console.error`" },
  "os.tmpDir": { dep: "DEP0022", status: "end-of-life", since: "Node 7", removedIn: "Node 14", replacement: "`os.tmpdir()`" },
  "os.getNetworkInterfaces": { dep: "DEP0023", status: "end-of-life", since: "Node 0.6", removedIn: "Node 12", replacement: "`os.networkInterfaces()`" },
  "tls.createSecurePair": { dep: "DEP0064", status: "end-of-life", since: "Node 6", removedIn: "Node 24", replacement: "`new tls.TLSSocket(socket, options)`" },
  "tls.parseCertString": { dep: "DEP0076", status: "end-of-life", since: "Node 8", removedIn: "Node 18", replacement: "your own parser — it never handled multi-value RDNs correctly" },
  "module.createRequireFromPath": { dep: "DEP0130", status: "end-of-life", since: "Node 12", removedIn: "Node 16", replacement: "`module.createRequire(filename)`" },
  "process.assert": { dep: "DEP0100", status: "end-of-life", since: "Node 10", removedIn: "Node 23", replacement: "`import assert from \"node:assert\"` and `assert.ok(value, message)`" },
  "timers.enroll": { dep: "DEP0095", status: "end-of-life", since: "Node 10", removedIn: "Node 24", replacement: "`setTimeout`" },
  "timers.unenroll": { dep: "DEP0096", status: "end-of-life", since: "Node 10", removedIn: "Node 24", replacement: "`clearTimeout`" },
  "net._setSimultaneousAccepts": { dep: "DEP0121", status: "end-of-life", since: "Node 12", removedIn: "Node 24", replacement: "nothing — delete the call" },
  "fs.SyncWriteStream": { dep: "DEP0061", status: "end-of-life", since: "Node 8", removedIn: "Node 11", replacement: "`fs.createWriteStream`" },

  // --- Runtime: warns today, still works. -----------------------------------
  // Application scope: warns for your code, silent inside `node_modules`.
  "url.parse": {
    dep: "DEP0169",
    status: "application",
    since: "Node 24",
    replacement: "`new URL(input)` — the legacy parser mis-handles hostile URLs",
  },
  "url.resolve": { dep: "DEP0169", status: "application", since: "Node 24", replacement: "`new URL(relative, base)`" },

  // --- Documentation-only: discouraged, but nothing is scheduled. -----------
  "fs.exists": {
    dep: "DEP0034",
    status: "documentation-only",
    since: "Node 1",
    replacement:
      "`fs.access` / `fs.promises.access` — or just attempt the operation and handle `ENOENT`, since the file can vanish between the check and the use",
  },
  "process.binding": {
    dep: "DEP0111",
    status: "documentation-only",
    since: "Node 10",
    replacement: "a public API — `process.binding` is internal, unstable, and unavailable under `--permission`",
  },
  "domain.create": {
    dep: "DEP0032",
    status: "documentation-only",
    since: "Node 1.4",
    replacement:
      "`AsyncLocalStorage` for context propagation, and `try`/`catch` plus error middleware for errors — `node:domain` is Stability 0 and unmaintained",
  },
};



/** The one sentence that states what this deprecation actually means. */
const consequenceOf = (path: string, d: Deprecation): string => {
  const dep = d.dep === "" ? "" : ` (${d.dep})`;
  switch (d.status) {
    case "end-of-life":
      return `\`${path}\` was REMOVED in ${d.removedIn}${dep} — on that runtime this throws, it does not warn`;
    case "runtime":
      return `\`${path}\` is runtime-deprecated since ${d.since}${dep} and prints a warning on every call`;
    case "application":
      return `\`${path}\` is deprecated since ${d.since}${dep} and warns for code outside \`node_modules\``;
    default:
      return `\`${path}\` is documented as deprecated${dep} — no warning and no removal is scheduled, but it is unmaintained`;
  }
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

/**
 * The Node built-in a receiver name is bound to in this file, or null.
 *
 * Resolved through the binding, never assumed from the name: the table is keyed
 * by `<builtin>.<member>`, so `import nodeUtil from "node:util"` must look up
 * `util.isString` even though the local is called `nodeUtil`. Requiring the
 * local to be spelled like the module silently missed every renamed import.
 */
const builtinFor = (
  name: string,
  node: AstNode,
  ctx: DiagnosticContext,
  namespaces: Map<string, string>,
): string | null => {
  const bound = namespaces.get(name);

  // A LOCAL binding shadows the module-level one. Resolving only through the
  // top-level import map fired on `function f(util) { util.isString(x) }` and on
  // `const fs = makeFs()` inside a function — a parameter named like a builtin
  // is somebody else's object, and `Array.isArray` would be wrong advice for it.
  const binding = ctx.scope.getBinding(name, node);
  if (binding !== null && binding.kind !== "import") {
    // The one exception: a `const fs = require("node:fs")` IS the builtin, and
    // that is exactly what `namespaces` recorded at module level.
    const declaredAtModuleScope = binding.scopeKind === "module";
    if (!declaredAtModuleScope || bound === undefined) return null;
  }

  if (name === "process") {
    // `process` is a global — but `import process from "node:process"` binds it
    // to the same object, and refusing that form silently disabled every
    // `process.*` entry for anyone who imports it explicitly.
    if (bound === "process") return "process";
    return binding === null ? "process" : null;
  }
  return bound ?? null;
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
        // NOT "removed" — `Buffer()` has never been removed, and saying so
        // would be a false claim with a version number attached. It is
        // application-scope deprecated (DEP0005) and warns in your own code.
        ctx.report(
          node,
          "`new Buffer()` is deprecated (DEP0005) and warns on every call outside `node_modules` — use `Buffer.from(value)` for data or `Buffer.alloc(size)` for a zero-filled buffer. `new Buffer(number)` returned uninitialized memory, which is the reason it went.",
        );
      },
      CallExpression: (node) => {
        const path = staticMemberPath(node.callee as AstNode);
        if (!path) return;
        // Exactly two segments: `a.b.url.parse` is a userland `url`, never the
        // built-in, so a tail match there is a false positive by construction.
        const segments = path.split(".");
        if (segments.length !== 2) return;
        const builtin = builtinFor(segments[0]!, node, ctx, bound());
        if (builtin === null) return;
        const key = `${builtin}.${segments[1]!}`;
        const hit = DEPRECATED_PATHS[key];
        if (!hit) return;
        ctx.report(node, `${consequenceOf(key, hit)}. Use ${hit.replacement}.`);
      },
    };
  },
});
