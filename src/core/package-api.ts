/**
 * §206 — Hallucinated-API Detection (`node-doctor api-check`).
 *
 * THE BUG. `import { readJson } from "fs-extra"` — except `fs-extra` exports
 * `readJson` and `readJSON`, and the one the agent picked does not exist. Or
 * `stripe.charges.createCharge(…)`, or `dayjs.addDays(…)`. In JavaScript a call
 * to a name a package does not export is **not a compile error**: the import is
 * `undefined`, and the failure is `TypeError: x is not a function` on the first
 * request that reaches that line, in production.
 *
 * This is the single most common way an agent's code is wrong, and it is
 * invisible to every existing check: the type checker only sees it if the
 * package ships types AND the project is strict, the linter has no idea what a
 * package exports, and the test suite passes if that path is not covered.
 *
 * WHY IT IS SHIPPABLE. §175 already proves the machinery: comparing a name
 * against a module's export surface, with a strict abstention model for when
 * that surface cannot be enumerated. This points the same comparison at
 * production code and at packages in `node_modules` instead of at mocks and
 * project modules.
 *
 * PRECISION MODEL. The claim is "this package does not export that name", and
 * it is false the moment the surface is not fully readable — so the rule
 * abstains for the WHOLE PACKAGE, never for a single name:
 *
 *   - THE PACKAGE MUST BE INSTALLED. `node_modules/<pkg>` is the only place the
 *     truth lives. Absent, the report says the check did not run — it does not
 *     say the code is fine.
 *   - THE SURFACE MUST BE COMPLETE. An unresolvable `export *`, an opaque
 *     `module.exports = f(x)`, `Object.assign(exports, …)`, a parse failure:
 *     any of them and the package is skipped with a reason. This reuses §155's
 *     `complete` flag, which was itself hardened by twelve confirmed findings.
 *   - A `.d.ts`-ONLY SURFACE IS NOT READ. A package whose runtime entry cannot
 *     be resolved is skipped rather than judged from its types, because the
 *     types are a claim about the runtime, not the runtime itself.
 *   - ONLY STATIC, NAMED ACCESS COUNTS. A named import, or a member read off a
 *     default/namespace import. A computed member (`pkg[name]`), a re-exported
 *     binding, and a destructure of a call result are all unreadable and skipped.
 *   - NO DEEP IMPORTS. `pkg/sub` resolves through its own exports map and is a
 *     different surface; §185 is where that belongs.
 *
 * Deterministic: packages and names sorted, no clock, no network.
 */

import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { BUILTIN_IGNORES, type NodeDoctorConfig } from "./config.ts";
import { parseSource } from "./parse.ts";
import { attachParents, collectDescendants } from "./walk.ts";
import { resolveScopes } from "./scope.ts";
import { getStaticStringValue } from "./ast.ts";
import { createLocator } from "./location.ts";
import { readExportSurface } from "./api-semver.ts";
import type { AstNode } from "./types.ts";

const SOURCE_GLOB = "**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}";

/** Interop names that are never a real named export. */
const INTEROP = new Set(["default", "__esModule"]);

/** Member names that belong to every function/object, not to the package. */
const UNIVERSAL_MEMBERS = new Set([
  "call",
  "apply",
  "bind",
  "toString",
  "valueOf",
  "constructor",
  "hasOwnProperty",
  "prototype",
  "name",
  "length",
  "then",
  "catch",
  "finally",
]);

export interface UnknownMember {
  package: string;
  /** The name used that the package does not export. */
  name: string;
  normalizedFilePath: string;
  line: number;
  column: number;
  /** A close export that does exist, when there is one. */
  suggestion: string | null;
}

/** Why a package was not assessed. Never silently omitted. */
export interface SkippedPackage {
  package: string;
  reason: string;
}

export interface PackageApiReport {
  /** False when `node_modules` is absent — every list is then empty. */
  installed: boolean;
  unknownMembers: UnknownMember[];
  /** Packages that could not be checked, each with its reason. */
  skipped: SkippedPackage[];
  summary: {
    filesScanned: number;
    packagesChecked: number;
    packagesSkipped: number;
    unknown: number;
  };
}

// ---------------------------------------------------------------------------
// Usage collection.
// ---------------------------------------------------------------------------

interface Use {
  name: string;
  normalizedFilePath: string;
  line: number;
  column: number;
}

interface PackageUse {
  /** Names read as named imports or off a namespace/default binding. */
  uses: Use[];
  /** True when any access this cannot read was seen — abstain for the package. */
  opaque: boolean;
}

/**
 * Bare specifiers Node resolves to a BUILT-IN, whatever `node_modules` holds.
 * A browserify shim (`events`, `buffer`, `util`, `path`) is installed by half
 * the ecosystem as a transitive dependency, and judging `import { parseArgs }
 * from "util"` against that shim asserts a name is missing from a module Node
 * never loads.
 */
const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants", "crypto",
  "dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http", "http2", "https",
  "inspector", "module", "net", "os", "path", "perf_hooks", "process", "punycode", "querystring",
  "readline", "repl", "stream", "string_decoder", "timers", "tls", "trace_events", "tty", "url",
  "util", "v8", "vm", "wasi", "worker_threads", "zlib",
]);

/** `@scope/name` or `name`; anything with a subpath is a different surface. */
const bareSpecifier = (specifier: string): string | null => {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) return null;
  if (NODE_BUILTINS.has(specifier)) return null;
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) return parts.length === 2 ? specifier : null;
  return parts.length === 1 ? specifier : null;
};

/** Levenshtein, bounded — for did-you-mean. */
const editDistance = (a: string, b: string): number => {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]!;
  }
  return prev[b.length]!;
};

const suggest = (name: string, exports: ReadonlySet<string>): string | null => {
  let best: string | null = null;
  let bestD = 3;
  for (const candidate of exports) {
    const d = editDistance(name.toLowerCase(), candidate.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = candidate;
    }
  }
  return bestD <= 2 ? best : null;
};

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------

export const buildPackageApiReport = async (
  rootDirectory: string,
  options: { config?: NodeDoctorConfig } = {},
): Promise<PackageApiReport> => {
  const fg = (await import("fast-glob")).default;
  const empty = (): PackageApiReport => ({
    installed: false,
    unknownMembers: [],
    skipped: [],
    summary: { filesScanned: 0, packagesChecked: 0, packagesSkipped: 0, unknown: 0 },
  });

  const nodeModules = join(rootDirectory, "node_modules");
  try {
    await readFile(join(nodeModules, ".package-lock.json"), "utf8");
  } catch {
    // The lock sidecar is optional; fall through to a directory probe below.
  }

  const files = (
    await fg([SOURCE_GLOB], {
      cwd: rootDirectory,
      ignore: [...BUILTIN_IGNORES, ...(options.config?.ignore ?? [])],
      absolute: true,
      followSymbolicLinks: false,
      suppressErrors: true,
    })
  ).sort();

  const usage = new Map<string, PackageUse>();
  let filesScanned = 0;

  for (const filePath of files) {
    let sourceText: string;
    try {
      sourceText = await readFile(filePath, "utf8");
    } catch {
      continue;
    }
    if (!sourceText.includes("import") && !sourceText.includes("require")) continue;
    const parsed = parseSource(filePath, sourceText);
    if (parsed.parseFailed) continue;
    attachParents(parsed.program);
    filesScanned += 1;
    const scope = resolveScopes(parsed.program);
    const locate = createLocator(sourceText);
    /**
     * In a TypeScript file a named import used ONLY in type position is erased
     * from the emitted JavaScript, so it says nothing about the runtime
     * surface — and the surface here is read from the `.js` entry, which by
     * design can never contain a type export. Checking one against the other is
     * a guaranteed false claim, and
     * `import axios, { AxiosRequestConfig } from "axios"` is the commonest
     * TypeScript idiom there is. Names with no value-position reference are
     * skipped entirely (not marked opaque: an erased name is evidence of
     * nothing either way).
     */
    const isTypeScript = /\.[cm]?tsx?$/.test(filePath);
    const valueReferenced = new Set<string>();
    if (isTypeScript) {
      for (const id of collectDescendants(
        parsed.program,
        (n) => n.type === "Identifier",
        undefined,
        true,
      )) {
        let cur: AstNode | null | undefined = id.parent;
        let inTypePosition = false;
        let guard = 0;
        while (cur && guard++ < 64) {
          const type = cur.type;
          // These TS nodes live in VALUE space; everything else starting with
          // `TS` is type space and its identifiers are erased.
          if (
            type === "TSAsExpression" ||
            type === "TSNonNullExpression" ||
            type === "TSSatisfiesExpression" ||
            type === "TSInstantiationExpression"
          ) {
            break;
          }
          if (type.startsWith("TS")) {
            inTypePosition = true;
            break;
          }
          if (type === "ImportDeclaration") {
            inTypePosition = true; // the import statement itself is not a use
            break;
          }
          cur = cur.parent;
        }
        if (!inTypePosition) valueReferenced.add(id.name as string);
      }
    }
    const normalizedFilePath = relative(rootDirectory, filePath).split(sep).join("/");

    /** local binding → package, for namespace/default imports. */
    const namespaceBindings = new Map<string, string>();

    const record = (pkg: string): PackageUse => {
      const existing = usage.get(pkg);
      if (existing) return existing;
      const fresh: PackageUse = { uses: [], opaque: false };
      usage.set(pkg, fresh);
      return fresh;
    };

    for (const stmt of (parsed.program.body as AstNode[] | undefined) ?? []) {
      if (stmt.type !== "ImportDeclaration") continue;
      // A type-only import asserts nothing about the runtime surface.
      if (stmt.importKind === "type") continue;
      const source = stmt.source?.value;
      if (typeof source !== "string") continue;
      const pkg = bareSpecifier(source);
      if (pkg === null) continue;
      const u = record(pkg);

      for (const spec of (stmt.specifiers as AstNode[] | undefined) ?? []) {
        const local = (spec.local as AstNode | undefined)?.name;
        if (spec.type === "ImportSpecifier") {
          if (spec.importKind === "type") continue;
          const imported = spec.imported as AstNode | undefined;
          const name =
            imported?.type === "Identifier" ? (imported.name as string) : getStaticStringValue(imported);
          if (name === null) {
            u.opaque = true;
            continue;
          }
          if (INTEROP.has(name)) continue;
          // Erased by TypeScript: not a runtime binding at all.
          if (isTypeScript && typeof local === "string" && !valueReferenced.has(local)) continue;
          const position = locate(spec.start as number);
          u.uses.push({ name, normalizedFilePath, line: position.line, column: position.column });
          continue;
        }
        // A default import is the package's `default` export, whose own shape
        // is not enumerable here — members read off it are checked below only
        // for a NAMESPACE import, where the members ARE the named exports.
        if (spec.type === "ImportNamespaceSpecifier" && typeof local === "string") {
          namespaceBindings.set(local, pkg);
        }
      }
    }

    // `ns.member` where `ns` is `import * as ns from "pkg"` — the members of a
    // namespace object ARE the named exports, so this is the same question.
    if (namespaceBindings.size > 0) {
      for (const member of collectDescendants(
        parsed.program,
        (n) => n.type === "MemberExpression",
        undefined,
        true,
      )) {
        const object = member.object as AstNode | undefined;
        if (object?.type !== "Identifier") continue;
        const pkg = namespaceBindings.get(object.name as string);
        if (pkg === undefined) continue;
        // A local binding of the same name SHADOWS the namespace import, and
        // `lib.foo()` on the shadow is somebody else's object entirely.
        const binding = scope.resolveIdentifier(object);
        if (binding !== null && binding.kind !== "import") continue;
        const u = record(pkg);
        if (member.computed) {
          u.opaque = true;
          continue;
        }
        const property = member.property as AstNode | undefined;
        if (property?.type !== "Identifier") {
          u.opaque = true;
          continue;
        }
        const name = property.name as string;
        if (INTEROP.has(name) || UNIVERSAL_MEMBERS.has(name)) continue;
        const position = locate(property.start as number);
        u.uses.push({ name, normalizedFilePath, line: position.line, column: position.column });
      }
    }
  }

  if (usage.size === 0) {
    return { ...empty(), installed: true, summary: { filesScanned, packagesChecked: 0, packagesSkipped: 0, unknown: 0 } };
  }

  // --- compare against each installed package's surface ---------------------
  const unknownMembers: UnknownMember[] = [];
  const skipped: SkippedPackage[] = [];
  let packagesChecked = 0;
  let anyInstalled = false;

  for (const pkg of [...usage.keys()].sort()) {
    const use = usage.get(pkg)!;
    const pkgDir = join(nodeModules, pkg);

    let manifest: Record<string, unknown>;
    try {
      const raw: unknown = JSON.parse(await readFile(join(pkgDir, "package.json"), "utf8"));
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not an object");
      manifest = raw as Record<string, unknown>;
    } catch {
      skipped.push({ package: pkg, reason: "not installed — `node_modules` has no readable manifest for it" });
      continue;
    }
    anyInstalled = true;

    if (use.opaque) {
      skipped.push({
        package: pkg,
        reason: "used through a computed or dynamic access this cannot read, so no name can be proven absent",
      });
      continue;
    }

    const entries = await resolveRuntimeEntries(pkgDir, manifest);
    if (entries.length === 0) {
      skipped.push({
        package: pkg,
        reason: "its runtime entry could not be resolved (types-only, or an exports map this does not follow)",
      });
      continue;
    }

    // A DUAL package ships an ESM entry and a CJS entry, and the two can carry
    // different surfaces. Reading whichever one resolved first would judge the
    // import against the wrong half, so a disagreement abstains.
    const surfaces = await Promise.all(entries.map((e) => readExportSurface(e)));
    // Completeness first: comparing two surfaces for disagreement is meaningless
    // when either of them was not fully read.
    if (surfaces.some((x) => !x.complete)) {
      skipped.push({
        package: pkg,
        reason: "its export surface is not fully enumerable (an unfollowable re-export or a runtime-built `module.exports`)",
      });
      continue;
    }
    const signatures = new Set(surfaces.map((x) => [...x.names].sort().join("\u0000")));
    if (signatures.size > 1) {
      skipped.push({
        package: pkg,
        reason: "it is a dual ESM/CJS package whose two entries export different names, so neither is authoritative",
      });
      continue;
    }
    const surface = surfaces[0]!;
    if (!surface.complete) {
      skipped.push({
        package: pkg,
        reason: "its export surface is not fully enumerable (an unfollowable re-export or a runtime-built `module.exports`)",
      });
      continue;
    }
    // A surface with nothing but `default` tells us nothing about named access.
    const named = new Set([...surface.names].filter((n) => n !== "default"));
    if (named.size === 0) {
      skipped.push({ package: pkg, reason: "it exports no named bindings this could compare against" });
      continue;
    }

    packagesChecked += 1;
    for (const u of use.uses) {
      if (named.has(u.name)) continue;
      unknownMembers.push({
        package: pkg,
        name: u.name,
        normalizedFilePath: u.normalizedFilePath,
        line: u.line,
        column: u.column,
        suggestion: suggest(u.name, named),
      });
    }
  }

  unknownMembers.sort(
    (a, b) =>
      (a.normalizedFilePath < b.normalizedFilePath ? -1 : a.normalizedFilePath > b.normalizedFilePath ? 1 : 0) ||
      a.line - b.line ||
      (a.name < b.name ? -1 : 1),
  );
  skipped.sort((a, b) => (a.package < b.package ? -1 : 1));

  return {
    installed: anyInstalled,
    unknownMembers,
    skipped,
    summary: {
      filesScanned,
      packagesChecked,
      packagesSkipped: skipped.length,
      unknown: unknownMembers.length,
    },
  };
};

/**
 * The RUNTIME entry of an installed package.
 *
 * `.d.ts` targets are refused deliberately: a declaration file is a claim about
 * the runtime, not the runtime itself, and a package whose types drifted from
 * its implementation would make this rule assert the drift as fact.
 */
const resolveRuntimeEntries = async (
  pkgDir: string,
  manifest: Record<string, unknown>,
): Promise<string[]> => {
  const candidates: string[] = [];
  const addFromExports = (value: unknown, depth = 0): void => {
    if (depth > 6) return;
    if (typeof value === "string") {
      candidates.push(value);
      return;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    const map = value as Record<string, unknown>;
    // Runtime conditions only, in Node's own precedence order.
    for (const key of ["node", "import", "require", "module", "default"]) {
      if (key in map) addFromExports(map[key], depth + 1);
    }
  };
  const exportsField = manifest.exports;
  if (exportsField !== undefined) {
    if (typeof exportsField === "string") candidates.push(exportsField);
    else if (exportsField !== null && typeof exportsField === "object") {
      const dot = (exportsField as Record<string, unknown>)["."];
      addFromExports(dot !== undefined ? dot : exportsField);
    }
  }
  for (const field of ["module", "main"]) {
    const value = manifest[field];
    if (typeof value === "string") candidates.push(value);
  }
  // A package that DECLARES an entry is authoritative about it. Falling through
  // to `index.js` when the declared target does not resolve would read a file
  // consumers never load — the same trap §155 documents.
  const declared = candidates.length > 0;
  if (!declared) candidates.push("index.js", "index.mjs", "index.cjs");

  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (/\.d\.[cm]?ts$/.test(candidate)) continue; // types are not the runtime
    const abs = join(pkgDir, candidate.replace(/^\.\//, ""));
    if (seen.has(abs)) continue;
    try {
      await readFile(abs, "utf8");
      seen.add(abs);
      resolved.push(abs);
    } catch {
      // try the next candidate
    }
  }
  // A declared-but-unresolvable entry is an abstention, never a guess.
  if (declared && resolved.length === 0) return [];
  // At most two: the first resolved condition and, when it differs, the other
  // module system's entry. More than that is fallback noise, not a surface.
  return resolved.slice(0, 2);
};
