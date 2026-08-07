/**
 * §83 — Node Version Upgrade Checker (`node-doctor node-upgrade`).
 *
 * Two questions a team asks before bumping the runtime, and neither is
 * answerable by reading the changelog:
 *
 *   1. WHAT BREAKS? Which APIs this code actually calls are gone in the target
 *      major. Not "deprecated" — gone, so the first request after the deploy
 *      throws `TypeError: x is not a function`.
 *   2. WHAT CAN I DELETE? Which dependencies the target runtime now ships
 *      natively, so the upgrade is also a subtraction.
 *
 * PRECISION MODEL. Both halves are claims about the reader's *future*, which
 * makes a wrong one expensive: they will either not upgrade because of a break
 * that is not real, or delete a package the built-in does not actually replace.
 *
 * WHAT BREAKS is delegated entirely to `no-deprecated-node-api`, whose table is
 * verified entry by entry against Node's own `doc/api/deprecations.md` and
 * carries each entry's status. Only `end-of-life` entries — the ones with a
 * release that deleted them — are reported as breaks. A runtime deprecation is
 * noise here: it warns, it does not break.
 *
 * WHAT YOU CAN DELETE is the dangerous half, and every entry carries three
 * gates plus a mandatory caveat:
 *
 *   - A VERSION RANGE, never a `>=`. Node backports stabilizations to the
 *     previous LTS, so `fs.glob` is stable on 22.17 and NOT on 23.2. A single
 *     lower bound would clear a version where the built-in is experimental.
 *   - CALL-SITE EVIDENCE. `uuid` is only replaceable if every import is v4;
 *     `rimraf` only if no call passes options or a glob; `dotenv` only if
 *     nothing calls `parse`. The dependency alone is never enough — the package
 *     almost always does more than the built-in.
 *   - A DIRECT DEPENDENCY. `glob` and `abort-controller` are transitively
 *     present in a huge share of tooling; a transitive package is nobody's to
 *     delete.
 *   - EVERY MENTION UNDERSTOOD. This is the gate that makes the others hold. An
 *     adversarial hunt found nine separate ways to slip a real usage past the
 *     collector — a re-export (`export { v1 } from "uuid"`), a dynamic
 *     `await import("uuid")`, a member-call require (`require("dotenv").parse`),
 *     an options object hoisted into a variable, a glob built from a template,
 *     a file that failed to parse — and every one of them turned into a
 *     confident "safe to delete". Enumerating usage forms is a losing game, so
 *     the gate is inverted: if any file so much as MENTIONS the package in a
 *     form this did not positively parse into a known shape, the package is not
 *     assessed and the report says which file it could not read.
 *
 * And the caveat ships with the finding, always. A correct entry with a missing
 * caveat still misleads: telling someone `fetch` replaces `node-fetch` without
 * saying `res.body.pipe()` breaks is a wrong answer with a true sentence in it.
 *
 * Deterministic: fixed tables, sorted output, no clock, no network.
 */

import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";

import { BUILTIN_IGNORES, type NodeDoctorConfig } from "./config.ts";
import { parseSource } from "./parse.ts";
import { attachParents, collectDescendants } from "./walk.ts";
import { getStaticStringValue, staticMemberPath } from "./ast.ts";
import { createLocator } from "./location.ts";
import type { AstNode, Finding } from "./types.ts";

const SOURCE_GLOB = "**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}";

/** Node majors worth targeting: current LTS and the two either side. */
export const UPGRADE_TARGETS = [20, 22, 24] as const;

/**
 * The newest major this build carries removal data for. Past it the report can
 * only say "nothing known to have been removed *so far*", which is a different
 * sentence from "nothing breaks" and must be said differently.
 */
export const NEWEST_KNOWN_TARGET = 24;

export interface UpgradeBreak {
  /** The `no-deprecated-node-api` finding that proved it. */
  api: string;
  normalizedFilePath: string;
  line: number;
  /** The Node major that deleted it. */
  removedIn: number;
  message: string;
}

export interface RedundantDependency {
  package: string;
  /** The built-in that replaces it. */
  builtin: string;
  /** Human-readable version requirement, e.g. "22.17+ (not 23.0–23.4)". */
  requires: string;
  /** What the built-in does NOT do. Always shown. */
  caveat: string;
  /** `file:line` of each call site that was checked. */
  sites: string[];
}

export interface NodeUpgradeReport {
  /** Node major from `engines`, when declared. */
  declaredNodeMajor: number | null;
  /** The major this report is about. */
  target: number;
  /** Calls that are GONE at `target` — the upgrade breaks on these. */
  breaks: UpgradeBreak[];
  /** Dependencies `target` makes redundant, each with its caveat. */
  redundant: RedundantDependency[];
  /** What could not be checked, and why. Never silently omitted. */
  notes: string[];
  summary: {
    filesScanned: number;
    breaks: number;
    redundant: number;
  };
}

// ---------------------------------------------------------------------------
// The redundancy table. Every entry was verified against Node's own docs; the
// caveat and the evidence gate are as load-bearing as the version.
// ---------------------------------------------------------------------------

/** Is `major` inside one of these inclusive ranges? */
interface VersionWindow {
  /** Majors where the built-in is stable. A major is listed only if ALL of it qualifies. */
  stableFrom: number;
  /** Majors between `stableFrom` and this that do NOT qualify (a backport gap). */
  gap?: number[];
  /** How to say it. */
  label: string;
}

interface Redundancy {
  package: string;
  builtin: string;
  window: VersionWindow;
  caveat: string;
  /**
   * Does every call site in the project permit the swap? Returns null when it
   * does (the swap is safe) or a reason string when it does not.
   */
  blockedBy: (usage: PackageUsage) => string | null;
  /**
   * True when the verdict depends on reading call ARGUMENTS. For these an
   * argument this cannot evaluate — a variable, a template literal — is not
   * "no options", it is "unknown options", and blocks.
   */
  argumentsMatter?: boolean;
  /** Companion packages whose presence proves the built-in is not sufficient. */
  companions?: string[];
}

/** What the scan saw of one package's use across the whole tree. */
interface PackageUsage {
  /** Named imports/requires seen anywhere: `{ v4 }` → "v4". */
  namedImports: Set<string>;
  /** True when a default or namespace import was seen (we cannot see which members). */
  wholeModuleImport: boolean;
  /** Property names read off the imported binding: `uuid.v1` → "v1". */
  memberReads: Set<string>;
  /** True when any call passed an options object. */
  callsWithOptions: boolean;
  /**
   * True when a call passed an argument this cannot read — a hoisted options
   * variable, a template-literal path, a spread. Every gate that inspects
   * arguments is blind to these, so any of them blocks the whole assessment.
   */
  opaqueArguments: boolean;
  /** Static string arguments to calls, for glob detection. */
  stringArguments: string[];
  /** `file:line` of every call site. */
  sites: string[];
  /** Files that name the package in a form this did not parse into a site. */
  unreadableMentions: string[];
  /** The package name appears in a package.json script — the CLI is not replaced. */
  usedAsCli: boolean;
}

const GLOB_META = /[*?[\]{}!]/;

const REDUNDANCIES: Redundancy[] = [
  {
    package: "abort-controller",
    builtin: "the global `AbortController` / `AbortSignal`",
    window: { stableFrom: 16, label: "16+" },
    caveat:
      "The package also ships a browser polyfill entry (`abort-controller/polyfill`) and a UMD build. For a Node-only project there is no behavioural gap; for anything that also builds for a browser, keep it.",
    // The safest entry in the table: for Node the global is a drop-in.
    blockedBy: () => null,
  },
  {
    package: "uuid",
    builtin: "`crypto.randomUUID()` from `node:crypto`",
    window: { stableFrom: 16, label: "16+" },
    caveat:
      "`randomUUID()` is RFC 4122 **v4 only**. The `uuid` package also exports v1/v3/v5/v6/v7, `parse`, `stringify`, `validate` and `version`, none of which Node has.",
    blockedBy: (u) => {
      if (u.wholeModuleImport) {
        return "a default or namespace import hides which generators are used";
      }
      const nonV4 = [...u.namedImports, ...u.memberReads].filter((n) => n !== "v4").sort();
      return nonV4.length > 0 ? `it also uses ${nonV4.map((n) => `\`${n}\``).join(", ")}` : null;
    },
  },
  {
    package: "rimraf",
    builtin: "`fs.rm(path, { recursive: true, force: true })`",
    window: { stableFrom: 16, label: "16+" },
    caveat:
      "rimraf v3 and earlier expand **globs**, which `fs.rm` does not; a `signal` option or a `filter` function also has no equivalent, and the CLI binary is not replaced.",
    blockedBy: (u) => {
      if (u.usedAsCli) return "it is invoked as a CLI in package.json scripts, which `fs.rm` does not replace";
      if (u.callsWithOptions) return "a call passes options (`signal`/`filter` have no equivalent)";
      const globby = u.stringArguments.find((a) => GLOB_META.test(a));
      return globby ? `a call passes the glob \`${globby}\`, which \`fs.rm\` does not expand` : null;
    },
    /** A path this cannot read may be a glob, which `fs.rm` will not expand. */
    argumentsMatter: true,
  },
  {
    package: "mkdirp",
    builtin: "`fs.mkdir(path, { recursive: true })`",
    window: { stableFrom: 16, label: "16+" },
    caveat:
      "mkdirp resolves to the first directory created and accepts an injected `fs` (used in tests); it also ships a CLI binary.",
    blockedBy: (u) => {
      if (u.usedAsCli) return "it is invoked as a CLI in package.json scripts";
      return u.callsWithOptions ? "a call passes options (an injected `fs`/`mode` has no equivalent)" : null;
    },
  },
  {
    package: "node-fetch",
    builtin: "the global `fetch`",
    window: { stableFrom: 18, label: "18+" },
    caveat:
      "Global `fetch` does not support node-fetch's non-standard `agent`, `follow`, `size`, `highWaterMark` or `insecureHTTPParser` options, and its `res.body` is a WHATWG ReadableStream — `res.body.pipe(...)` breaks. `HTTP_PROXY`/`HTTPS_PROXY` are not honoured by default.",
    blockedBy: (u) => (u.callsWithOptions ? "a call passes an options object that may use a node-fetch extension" : null),
    /** An options object this cannot read may carry `agent`/`size`/`follow`. */
    argumentsMatter: true,
  },
  {
    package: "dotenv",
    builtin: "`node --env-file=.env` (or `process.loadEnvFile()`)",
    // `--env-file` works from 20.6 but only became stable in 22.21/24.10, so
    // majors 21 and 23 are deliberately excluded.
    window: { stableFrom: 22, gap: [23], label: "22.21+ or 24.10+ (not 23.x)" },
    caveat:
      "Node has no `parse()`, no `populate()`, no `override`, no `-r dotenv/config` preload, and **no variable expansion**. A deployment that cannot add a CLI flag can use `NODE_OPTIONS` or `process.loadEnvFile()`.",
    blockedBy: (u) => {
      const extras = [...u.namedImports, ...u.memberReads].filter((n) => n !== "config").sort();
      if (extras.length > 0) return `it also uses ${extras.map((n) => `\`${n}\``).join(", ")}`;
      return u.callsWithOptions ? "`config()` is called with options (`path`/`override` have no equivalent)" : null;
    },
    argumentsMatter: true,
    /** dotenv-expand exists precisely to add the expansion Node does not do. */
    companions: ["dotenv-expand", "dotenvx", "@dotenvx/dotenvx"],
  },
  {
    package: "glob",
    builtin: "`fs.glob` / `fs.globSync`",
    // Stable on 22.17+ and 24+. Majors 22 and 23 are excluded wholesale because
  // the window is per-MAJOR: a 22.0 project would be wrongly cleared.
  window: { stableFrom: 24, label: "24+ (22.17+ also has it; 23.x does not)" },
    caveat:
      "Node's `fs.glob` supports only `cwd`, `exclude` and `withFileTypes` — no `ignore`, `dot`, `absolute`, `nodir` or `signal` — negation patterns are not supported, and the async form yields an AsyncIterator rather than an array.",
    blockedBy: (u) => {
      if (u.wholeModuleImport) return "a default or namespace import hides which of glob's APIs are used";
      const extras = [...u.namedImports, ...u.memberReads].filter((n) => n !== "glob" && n !== "globSync").sort();
      if (extras.length > 0) return `it also uses ${extras.map((n) => `\`${n}\``).join(", ")}`;
      if (u.callsWithOptions) return "a call passes options Node's `fs.glob` does not support";
      const negated = u.stringArguments.find((a) => a.startsWith("!"));
      return negated ? `a call passes the negation pattern \`${negated}\`, which Node's \`fs.glob\` does not support` : null;
    },
    argumentsMatter: true,
  },
];

/** Does this Node major ship the built-in, per the entry's window? */
const windowAllows = (window: VersionWindow, major: number): boolean =>
  major >= window.stableFrom && !(window.gap ?? []).includes(major);

// ---------------------------------------------------------------------------
// Usage collection.
// ---------------------------------------------------------------------------

const emptyUsage = (): PackageUsage => ({
  namedImports: new Set(),
  wholeModuleImport: false,
  memberReads: new Set(),
  callsWithOptions: false,
  opaqueArguments: false,
  stringArguments: [],
  sites: [],
  unreadableMentions: [],
  usedAsCli: false,
});

/** Strip a subpath: `uuid/v4` → `uuid`, `dotenv/config` → `dotenv`. */
const packageOf = (specifier: string): { name: string; subpath: string | null } => {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return { name: "", subpath: null };
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  const subpath = specifier.slice(name.length + 1);
  return { name, subpath: subpath === "" ? null : subpath };
};

interface Manifest {
  dependencies: Set<string>;
  scripts: string[];
  /** A monorepo root: the packages under it declare their own dependencies. */
  isWorkspaceRoot: boolean;
  /** Any signal that this package also targets a browser or React Native. */
  browserTargeted: boolean;
  engineMajor: number | null;
}

const readManifest = async (rootDirectory: string): Promise<Manifest | null> => {
  let raw: string;
  try {
    raw = await readFile(`${rootDirectory}/package.json`, "utf8");
  } catch {
    return null;
  }
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const dependencies = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const map = pkg[field];
    if (map !== null && typeof map === "object") {
      for (const name of Object.keys(map as Record<string, unknown>)) dependencies.add(name);
    }
  }
  const scriptMap = pkg.scripts;
  const scripts =
    scriptMap !== null && typeof scriptMap === "object"
      ? Object.values(scriptMap as Record<string, unknown>).filter((v): v is string => typeof v === "string")
      : [];

  const engines = pkg.engines as Record<string, unknown> | undefined;
  const nodeRange = typeof engines?.node === "string" ? engines.node : null;
  const engineMajor = nodeRange === null ? null : (/(\d+)/.exec(nodeRange)?.[1] ?? null) !== null
    ? Number(/(\d+)/.exec(nodeRange)![1])
    : null;

  return {
    dependencies,
    scripts,
    isWorkspaceRoot: Array.isArray(pkg.workspaces) || (pkg.workspaces !== null && typeof pkg.workspaces === "object"),
    // A browser build means `fetch`/`AbortController` may be there for the
    // bundle, not for Node — deleting them breaks the browser target.
    browserTargeted:
      "browser" in pkg ||
      dependencies.has("react-native") ||
      dependencies.has("webpack") ||
      dependencies.has("vite") ||
      dependencies.has("rollup") ||
      dependencies.has("esbuild") ||
      dependencies.has("parcel"),
    engineMajor,
  };
};

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------

export interface NodeUpgradeOptions {
  config?: NodeDoctorConfig;
  /** The Node major to plan for. Defaults to the newest known target. */
  target?: number;
  /** Findings from a completed scan — the source of the "what breaks" half. */
  findings?: readonly Finding[];
}

/** `end-of-life` messages name their release: "was REMOVED in Node 22". */
const REMOVED_IN_RE = /was REMOVED in Node (\d+)/;
const API_RE = /^`([^`]+)`/;

export const buildNodeUpgradeReport = async (
  rootDirectory: string,
  options: NodeUpgradeOptions = {},
): Promise<NodeUpgradeReport> => {
  const target = options.target ?? UPGRADE_TARGETS[UPGRADE_TARGETS.length - 1];
  const notes: string[] = [];

  const manifest = await readManifest(rootDirectory);
  if (manifest === null) notes.push("No readable package.json — dependency redundancy was not checked.");
  else if (manifest.isWorkspaceRoot) {
    notes.push(
      "This is a workspace root: only its own dependencies were assessed, not those declared by the packages under it.",
    );
  }
  if (target > NEWEST_KNOWN_TARGET) {
    notes.push(
      `Node ${target} is past the newest release this build has data for (Node ${NEWEST_KNOWN_TARGET}) — "nothing breaks" below means "nothing known to have been removed up to ${NEWEST_KNOWN_TARGET}", not a statement about ${target}.`,
    );
  }

  // --- what breaks ---------------------------------------------------------
  const breaks: UpgradeBreak[] = [];
  for (const finding of options.findings ?? []) {
    if (finding.diagnostic !== "no-deprecated-node-api") continue;
    const removed = REMOVED_IN_RE.exec(finding.message);
    // A runtime or documentation-only deprecation warns; it does not break.
    if (!removed) continue;
    const removedIn = Number(removed[1]);
    if (removedIn > target) continue;
    breaks.push({
      api: API_RE.exec(finding.message)?.[1] ?? finding.message.slice(0, 40),
      normalizedFilePath: finding.normalizedFilePath,
      line: finding.line,
      removedIn,
      message: finding.message,
    });
  }
  if (options.findings === undefined) {
    notes.push("No scan findings were supplied, so removed-API breaks were not checked.");
  }

  // --- what you can delete -------------------------------------------------
  const redundant: RedundantDependency[] = [];
  let filesScanned = 0;

  if (manifest !== null) {
    const candidates = REDUNDANCIES.filter(
      (r) => manifest.dependencies.has(r.package) && windowAllows(r.window, target),
    );
    const browserBlocked = candidates.filter(
      (r) => manifest.browserTargeted && (r.package === "node-fetch" || r.package === "abort-controller"),
    );
    for (const r of browserBlocked) {
      notes.push(
        `\`${r.package}\` was not assessed: this package also targets a browser or React Native, where the Node built-in does not exist.`,
      );
    }
    const assessing = candidates.filter((r) => !browserBlocked.includes(r));

    if (assessing.length > 0) {
      /**
       * Record what a call's arguments say — and, crucially, what they do NOT.
       * An argument this cannot evaluate is not "no options"; it is "unknown
       * options", and for an entry whose verdict reads arguments that is the
       * difference between a safe swap and a broken one.
       */
      const recordArguments = (u: PackageUsage, args: AstNode[]): void => {
        for (const arg of args) {
          if (arg.type === "ObjectExpression") {
            u.callsWithOptions = true;
            continue;
          }
          const literal = getStaticStringValue(arg);
          if (literal !== null) {
            u.stringArguments.push(literal);
            continue;
          }
          if (arg.type === "TemplateLiteral") {
            // The static parts are readable even when the holes are not: a
            // `\`${dir}/**/*.log\`` carries its glob in a quasi.
            for (const quasi of (arg.quasis as AstNode[] | undefined) ?? []) {
              const cooked = (quasi.value as { cooked?: unknown } | undefined)?.cooked;
              if (typeof cooked === "string" && cooked !== "") u.stringArguments.push(cooked);
            }
            u.opaqueArguments = true;
            continue;
          }
          if (arg.type === "ArrayExpression") {
            // `glob(["a/**", "!b/**"])` — read the readable elements, and treat
            // an unreadable one as opaque.
            for (const element of (arg.elements as Array<AstNode | null> | undefined) ?? []) {
              const value = element === null ? null : getStaticStringValue(element);
              if (value === null) u.opaqueArguments = true;
              else u.stringArguments.push(value);
            }
            continue;
          }
          // A function (a callback), a spread, a variable, a template with a
          // hole: all unreadable.
          if (arg.type !== "ArrowFunctionExpression" && arg.type !== "FunctionExpression") {
            u.opaqueArguments = true;
          } else {
            u.callsWithOptions = true; // a filter/callback is an option too
          }
        }
      };

      const usage = new Map<string, PackageUsage>();
      for (const r of assessing) {
        const u = emptyUsage();
        u.usedAsCli = manifest.scripts.some((s) => new RegExp(`(^|[\\s"'&|;])${r.package}([\\s"'&|;]|$)`).test(s));
        usage.set(r.package, u);
      }

      const fg = (await import("fast-glob")).default;
      const files = (
        await fg([SOURCE_GLOB], {
          cwd: rootDirectory,
          ignore: [...BUILTIN_IGNORES, ...(options.config?.ignore ?? [])],
          absolute: true,
          followSymbolicLinks: false,
          suppressErrors: true,
        })
      ).sort();

      for (const filePath of files) {
        let sourceText: string;
        try {
          sourceText = await readFile(filePath, "utf8");
        } catch {
          continue;
        }
        const mentioned = assessing.filter((r) => sourceText.includes(r.package));
        if (mentioned.length === 0) continue;

        const parsed = parseSource(filePath, sourceText);
        const normalizedForMention = relative(rootDirectory, filePath).split(sep).join("/");
        if (parsed.parseFailed) {
          // A file this could not read may use the package in any way at all.
          for (const r of mentioned) usage.get(r.package)!.unreadableMentions.push(normalizedForMention);
          continue;
        }
        attachParents(parsed.program);
        filesScanned += 1;
        const locate = createLocator(sourceText);
        const normalizedFilePath = relative(rootDirectory, filePath).split(sep).join("/");

        /** local binding name → package it came from. */
        const bindings = new Map<string, string>();

        const noteImport = (specifier: string, node: AstNode, specs: AstNode[] | null): void => {
          const { name, subpath } = packageOf(specifier);
          const u = usage.get(name);
          if (!u) return;
          u.sites.push(`${normalizedFilePath}:${locate(node.start as number).line}`);
          // `uuid/v4` names the member in the specifier itself.
          if (subpath !== null) u.namedImports.add(subpath.replace(/\.[cm]?js$/, ""));
          if (specs === null) return;
          for (const spec of specs) {
            const local = (spec.local as AstNode | undefined)?.name;
            if (typeof local === "string") bindings.set(local, name);
            if (spec.type === "ImportSpecifier") {
              const imported = spec.imported as AstNode | undefined;
              const importedName =
                imported?.type === "Identifier" ? (imported.name as string) : getStaticStringValue(imported);
              if (importedName !== null) u.namedImports.add(importedName);
            } else {
              u.wholeModuleImport = true;
            }
          }
        };

        for (const stmt of (parsed.program.body as AstNode[] | undefined) ?? []) {
          const source = stmt.source?.value;
          if (typeof source !== "string") continue;
          if (stmt.type === "ImportDeclaration") {
            noteImport(source, stmt, (stmt.specifiers as AstNode[] | undefined) ?? []);
            continue;
          }
          // `export { v1, v5 as five } from "uuid"` re-exports the package's own
          // members into this project's public API — the same fact as importing
          // them, written differently. `ExportSpecifier.local` is the name in
          // the SOURCE module, which is the imported name.
          if (stmt.type === "ExportNamedDeclaration") {
            const specs = ((stmt.specifiers as AstNode[] | undefined) ?? []).map(
              (spec) =>
                ({ type: "ImportSpecifier", imported: spec.local, local: spec.local }) as unknown as AstNode,
            );
            noteImport(source, stmt, specs);
            continue;
          }
          // `export * from "uuid"` / `export * as uuid from "uuid"` re-export the
          // WHOLE surface — exactly what `wholeModuleImport` is for.
          if (stmt.type === "ExportAllDeclaration") {
            noteImport(source, stmt, [{ type: "ImportNamespaceSpecifier" } as unknown as AstNode]);
          }
        }

        for (const call of collectDescendants(
          parsed.program,
          // `import("pkg")` is an ImportExpression in ESTree, NOT a
          // CallExpression — matching only calls made every dynamic import
          // invisible, which read as "this package is unused here".
          (n) => n.type === "CallExpression" || n.type === "ImportExpression",
          undefined,
          true,
        )) {
          const callee = call.callee as AstNode | undefined;
          const args = (call.arguments as AstNode[] | undefined) ?? [];

          // `await import("uuid")` — the members loaded are invisible.
          if (call.type === "ImportExpression" || callee?.type === "Import") {
            const spec = getStaticStringValue((call.source as AstNode | undefined) ?? args[0]);
            if (spec === null) {
              // `import(name)` — the specifier is computed, so this file may be
              // loading any of the packages it mentions.
              for (const r of mentioned) usage.get(r.package)!.unreadableMentions.push(normalizedFilePath);
              continue;
            }
            const u = usage.get(packageOf(spec).name);
            if (u) {
              u.wholeModuleImport = true;
              u.sites.push(`${normalizedFilePath}:${locate(call.start as number).line}`);
            }
            continue;
          }

          // `require("dotenv").config(…)` / `require("uuid").v1()` — a member
          // call straight off the require, with no binding to follow.
          if (callee?.type === "MemberExpression") {
            const object = callee.object as AstNode | undefined;
            if (
              object?.type === "CallExpression" &&
              (object.callee as AstNode | undefined)?.type === "Identifier" &&
              (object.callee as AstNode).name === "require"
            ) {
              const spec = getStaticStringValue(((object.arguments as AstNode[] | undefined) ?? [])[0]);
              const u = spec === null ? undefined : usage.get(packageOf(spec).name);
              if (u) {
                const property = callee.property as AstNode | undefined;
                const member =
                  property?.type === "Identifier" && !callee.computed
                    ? (property.name as string)
                    : getStaticStringValue(property);
                // A computed member is a name this cannot read at all.
                if (member === null) u.unreadableMentions.push(normalizedFilePath);
                else u.memberReads.add(member);
                u.sites.push(`${normalizedFilePath}:${locate(call.start as number).line}`);
                recordArguments(u, args);
                continue;
              }
            }
          }

          // `require("uuid")` / `const { v4 } = require("uuid")`
          if (callee?.type === "Identifier" && callee.name === "require") {
            const spec = getStaticStringValue(args[0]);
            if (spec === null) {
              for (const r of mentioned) usage.get(r.package)!.unreadableMentions.push(normalizedFilePath);
              continue;
            }
            const declarator = call.parent?.type === "VariableDeclarator" ? (call.parent as AstNode) : null;
            const id = declarator?.id as AstNode | undefined;
            if (id?.type === "ObjectPattern") {
              const specs: AstNode[] = [];
              for (const prop of (id.properties as AstNode[] | undefined) ?? []) {
                if (prop.type !== "Property") continue;
                const key = prop.key as AstNode | undefined;
                const value = prop.value as AstNode | undefined;
                if (key?.type === "Identifier" && value?.type === "Identifier") {
                  specs.push({ type: "ImportSpecifier", imported: key, local: value } as unknown as AstNode);
                }
              }
              noteImport(spec, call, specs);
            } else if (id?.type === "Identifier") {
              noteImport(spec, call, [{ type: "ImportDefaultSpecifier", local: id } as unknown as AstNode]);
            } else {
              noteImport(spec, call, null);
            }
            continue;
          }

          // Calls THROUGH a tracked binding: `rimraf(dir)`, `uuid.v1()`.
          const path = staticMemberPath(callee as AstNode);
          if (path === null) continue;
          const root = path.split(".")[0]!;
          const pkg = bindings.get(root);
          if (pkg === undefined) continue;
          const u = usage.get(pkg);
          if (!u) continue;

          const member = path.split(".")[1];
          if (member !== undefined) u.memberReads.add(member);
          u.sites.push(`${normalizedFilePath}:${locate(call.start as number).line}`);
          recordArguments(u, args);
        }
      }

      for (const r of assessing) {
        const u = usage.get(r.package)!;
        // A dependency nothing imports is either transitive tooling or dead —
        // either way it is not this report's business to name.
        if (u.sites.length === 0) {
          notes.push(`\`${r.package}\` is declared but never imported in source — not assessed.`);
          continue;
        }
        if (u.unreadableMentions.length > 0) {
          const files = [...new Set(u.unreadableMentions)].sort().slice(0, 3).join(", ");
          notes.push(
            `\`${r.package}\` was not assessed: ${files} mentions it in a form this could not read, so its usage cannot be proven safe to remove.`,
          );
          continue;
        }
        if (r.argumentsMatter === true && u.opaqueArguments) {
          notes.push(
            `\`${r.package}\` was not assessed: a call passes an argument this cannot evaluate (a variable, a template, a spread), and the verdict depends on reading it.`,
          );
          continue;
        }
        const companion = (r.companions ?? []).find((c) => manifest.dependencies.has(c));
        if (companion !== undefined) {
          notes.push(
            `\`${r.package}\` cannot be replaced: the project also depends on \`${companion}\`, which exists to add what the built-in does not do.`,
          );
          continue;
        }
        const blocked = r.blockedBy(u);
        if (blocked !== null) {
          notes.push(`\`${r.package}\` cannot be replaced: ${blocked}.`);
          continue;
        }
        redundant.push({
          package: r.package,
          builtin: r.builtin,
          requires: `Node ${r.window.label}`,
          caveat: r.caveat,
          sites: [...new Set(u.sites)].sort().slice(0, 6),
        });
      }
    }
  }

  breaks.sort(
    (a, b) =>
      (a.normalizedFilePath < b.normalizedFilePath ? -1 : a.normalizedFilePath > b.normalizedFilePath ? 1 : 0) ||
      a.line - b.line ||
      (a.api < b.api ? -1 : 1),
  );
  redundant.sort((a, b) => (a.package < b.package ? -1 : 1));
  notes.sort();

  return {
    declaredNodeMajor: manifest?.engineMajor ?? null,
    target,
    breaks,
    redundant,
    notes,
    summary: { filesScanned, breaks: breaks.length, redundant: redundant.length },
  };
};
