/**
 * §155 — Internal Package API Semver Linting (`node-doctor semver`).
 *
 * §78 does semver for the HTTP surface; this does it for PACKAGE EXPORTS. For
 * every package (workspace members in a monorepo, or the single root package)
 * it extracts the public export surface from the package's entry file and, when
 * a baseline snapshot exists, diffs against it:
 *
 *   - a REMOVED export is a breaking change → requires a major bump
 *     (or a minor bump while the package is still 0.x, per semver);
 *   - an ADDED export is a feature → a minor bump is expected;
 *   - versions are read from each package.json, entirely offline.
 *
 * PRECISION MODEL. Every claim must be provable from source:
 *   - The surface is `complete` only when every export statement resolved — an
 *     `export * from` that cannot be followed (a bare specifier, a missing
 *     file) marks the surface PARTIAL, and a partial surface never yields a
 *     "removed export" claim (the name may live behind the wildcard). Additions
 *     are still reported (a name present now was provably not present before
 *     only if the BASELINE was complete — so additions also require a complete
 *     baseline surface).
 *   - A package whose entry cannot be resolved is listed as unanalyzed and
 *     claims nothing.
 *   - A package that disappeared from the workspace has no version left to
 *     lint — reported as information, never an error.
 *   - Renamed/narrowed TYPES and changed call signatures are out of scope
 *     (deliberate: name-level surface only; a name-level removal is the
 *     unambiguous breaking change).
 *
 * Deterministic: packages sorted by name, exports sorted, byte-identical JSON.
 */

import { readFile, access } from "node:fs/promises";
import { join, dirname, resolve as resolvePath, relative, sep } from "node:path";

import type { AstNode } from "./types.ts";
import { parseSource } from "./parse.ts";
import { discoverWorkspaces } from "./workspaces.ts";

// ---------------------------------------------------------------------------
// Public shape.
// ---------------------------------------------------------------------------

export interface PackageSurface {
  name: string;
  version: string | null;
  /** Repo-relative entry file the surface was read from, or null when unresolved. */
  entry: string | null;
  /** Sorted export names; "default" for a default export. */
  exports: string[];
  /** False when a re-export could not be followed — removals are then unprovable. */
  complete: boolean;
}

export interface SemverChange {
  package: string;
  kind: "removed-export" | "added-export" | "removed-package" | "added-package";
  name: string | null;
  breaking: boolean;
}

export interface SemverVerdict {
  package: string;
  baseVersion: string | null;
  currentVersion: string | null;
  removed: string[];
  added: string[];
  /** "ok" — bump matches; "breaking-without-major" — removals shipped under the
   *  same major; "minor-expected" — additions with an unchanged version;
   *  "unprovable" — a partial surface or missing version prevented any claim. */
  verdict: "ok" | "breaking-without-major" | "minor-expected" | "unprovable";
}

export interface ApiSemverReport {
  packages: PackageSurface[];
  /** Present only when a baseline was diffed. */
  diff?: {
    changes: SemverChange[];
    verdicts: SemverVerdict[];
  };
  summary: {
    packages: number;
    unanalyzed: number;
    breaking: number;
  };
}

// ---------------------------------------------------------------------------
// Entry resolution.
// ---------------------------------------------------------------------------

const exists = async (p: string): Promise<boolean> => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx"];

/** Resolve a relative specifier from a file — exact, +ext, /index+ext. */
const resolveRelative = async (fromFile: string, spec: string): Promise<string | null> => {
  const base = resolvePath(dirname(fromFile), spec);
  if (/\.[cm]?[jt]sx?$/.test(base) && (await exists(base))) return base;
  for (const ext of SOURCE_EXTENSIONS) {
    if (await exists(base + ext)) return base + ext;
  }
  for (const ext of SOURCE_EXTENSIONS) {
    if (await exists(join(base, "index" + ext))) return join(base, "index" + ext);
  }
  return null;
};

/**
 * The entry SOURCE file of a package. package.json `exports`("."), `module`,
 * `main` are tried first; a target that points at a build artifact that does not
 * exist in the repo (dist/) falls back to the conventional source entries
 * (src/index.*, index.*). Returns null when nothing resolves.
 */
const resolveEntry = async (pkgDir: string, pkg: Record<string, unknown>): Promise<string | null> => {
  const candidates: string[] = [];
  const exportsField = pkg.exports;
  if (typeof exportsField === "string") candidates.push(exportsField);
  else if (exportsField && typeof exportsField === "object") {
    const dot = (exportsField as Record<string, unknown>)["."];
    if (typeof dot === "string") candidates.push(dot);
    else if (dot && typeof dot === "object") {
      for (const v of Object.values(dot as Record<string, unknown>)) {
        if (typeof v === "string") candidates.push(v);
      }
    }
  }
  for (const key of ["module", "main"]) {
    const v = pkg[key];
    if (typeof v === "string") candidates.push(v);
  }
  candidates.push("src/index.ts", "src/index.tsx", "src/index.mts", "src/index.js", "src/index.mjs", "index.ts", "index.js", "index.mjs");

  for (const cand of candidates) {
    const abs = join(pkgDir, cand);
    if (/\.[cm]?[jt]sx?$/.test(cand) && (await exists(abs))) return abs;
    // A dist/ target with a source twin: dist/index.js → src/index.ts.
    const m = /^(?:\.\/)?dist\/(.+)\.[cm]?js$/.exec(cand);
    if (m) {
      for (const ext of SOURCE_EXTENSIONS) {
        const src = join(pkgDir, "src", m[1] + ext);
        if (await exists(src)) return src;
      }
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// Export-surface extraction.
// ---------------------------------------------------------------------------

/** The BOUND names of a binding pattern — `{ a: c }` binds `c` (not the key `a`),
 *  `[x = 1, ...rest]` binds `x` and `rest`. Structure-aware so a destructuring
 *  export never reports a property key that is not actually importable. */
const patternNames = (node: AstNode | undefined): string[] => {
  if (!node) return [];
  switch (node.type) {
    case "Identifier":
      return [node.name as string];
    case "ObjectPattern": {
      const names: string[] = [];
      for (const p of (node.properties as AstNode[] | undefined) ?? []) {
        if (p.type === "Property") names.push(...patternNames(p.value as AstNode));
        else if (p.type === "RestElement") names.push(...patternNames(p.argument as AstNode));
      }
      return names;
    }
    case "ArrayPattern": {
      const names: string[] = [];
      for (const el of (node.elements as AstNode[] | undefined) ?? []) {
        if (el) names.push(...patternNames(el));
      }
      return names;
    }
    case "AssignmentPattern":
      return patternNames(node.left as AstNode);
    case "RestElement":
      return patternNames(node.argument as AstNode);
    default:
      return [];
  }
};

/**
 * The export names of one module, following `export * from "./x"` re-exports
 * (bounded, cycle-safe). Sets `complete = false` when any re-export target
 * cannot be resolved or parsed — the caller then refuses removal claims.
 */
const extractExports = async (
  file: string,
  seen: Set<string>,
  depth: number,
): Promise<{ names: Set<string>; complete: boolean }> => {
  const names = new Set<string>();
  let complete = true;
  if (depth > 8 || seen.has(file)) return { names, complete };
  seen.add(file);

  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch {
    return { names, complete: false };
  }
  const parsed = parseSource(file, source);
  if (parsed.parseFailed) return { names, complete: false };

  for (const stmt of (parsed.program.body as AstNode[] | undefined) ?? []) {
    if (stmt.type === "ExportDefaultDeclaration") {
      names.add("default");
      continue;
    }
    if (stmt.type === "ExportAllDeclaration") {
      // `export * as ns from "./x"` exports ONE name; a bare `export *` splices.
      const exported = (stmt.exported as AstNode | undefined)?.name as string | undefined;
      if (exported) {
        names.add(exported);
        continue;
      }
      const spec = stmt.source?.value;
      const target = typeof spec === "string" && spec.startsWith(".") ? await resolveRelative(file, spec) : null;
      if (!target) {
        complete = false;
        continue;
      }
      const sub = await extractExports(target, seen, depth + 1);
      for (const n of sub.names) if (n !== "default") names.add(n);
      if (!sub.complete) complete = false;
      continue;
    }
    if (stmt.type === "ExportNamedDeclaration") {
      const decl = stmt.declaration as AstNode | undefined;
      if (decl) {
        if (decl.type === "VariableDeclaration") {
          for (const d of (decl.declarations as AstNode[] | undefined) ?? []) {
            for (const n of patternNames(d.id as AstNode)) names.add(n);
          }
        } else {
          const id = (decl.id as AstNode | undefined)?.name as string | undefined;
          if (id) names.add(id); // function/class/TS enum/interface/type alias
        }
        continue;
      }
      for (const spec of (stmt.specifiers as AstNode[] | undefined) ?? []) {
        const exported = spec.exported as AstNode | undefined;
        const name =
          exported?.type === "Identifier"
            ? (exported.name as string)
            : exported?.type === "Literal" && typeof exported.value === "string"
              ? exported.value
              : null;
        if (name) names.add(name);
      }
      continue;
    }
    // CommonJS: exports.x = … / module.exports = { … } / module.exports.x = …
    if (stmt.type === "ExpressionStatement") {
      const expr = stmt.expression as AstNode | undefined;
      if (expr?.type !== "AssignmentExpression") continue;
      const left = expr.left as AstNode | undefined;
      if (left?.type !== "MemberExpression" || left.computed) continue;
      const obj = left.object as AstNode | undefined;
      const prop = (left.property as AstNode | undefined)?.name as string | undefined;
      const objIsExports = obj?.type === "Identifier" && obj.name === "exports";
      const objIsModuleExports =
        obj?.type === "MemberExpression" &&
        !obj.computed &&
        (obj.object as AstNode | undefined)?.type === "Identifier" &&
        (obj.object as AstNode).name === "module" &&
        ((obj.property as AstNode | undefined)?.name as string | undefined) === "exports";
      if (objIsExports && prop) {
        names.add(prop);
      } else if (objIsModuleExports && prop) {
        names.add(prop);
      } else if (
        obj?.type === "Identifier" &&
        obj.name === "module" &&
        prop === "exports"
      ) {
        const value = expr.right as AstNode | undefined;
        if (value?.type === "ObjectExpression") {
          for (const p of (value.properties as AstNode[] | undefined) ?? []) {
            if (p.type === "Property" && !p.computed) {
              const key = (p.key as AstNode | undefined)?.name as string | undefined;
              if (key) names.add(key);
            } else if (p.type === "SpreadElement") {
              complete = false; // a spread hides names
            }
          }
        } else {
          names.add("default");
          complete = false; // an opaque module.exports value hides its shape
        }
      }
    }
  }
  return { names, complete };
};

// ---------------------------------------------------------------------------
// Report assembly + diff.
// ---------------------------------------------------------------------------

const parseVersion = (v: string | null): { major: number; minor: number; patch: number } | null => {
  if (!v) return null;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
};

export const buildApiSemverReport = async (
  rootDirectory: string,
  options?: { baseline?: ApiSemverReport },
): Promise<ApiSemverReport> => {
  const root = resolvePath(rootDirectory);
  const memberDirs = await discoverWorkspaces(root);
  const pkgDirs = memberDirs.length > 0 ? memberDirs : [root];

  const packages: PackageSurface[] = [];
  for (const dir of pkgDirs) {
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const name =
      typeof pkg.name === "string" && pkg.name.length > 0
        ? pkg.name
        : relative(root, dir).split(sep).join("/") || ".";
    const version = typeof pkg.version === "string" ? pkg.version : null;
    const entryAbs = await resolveEntry(dir, pkg);
    if (!entryAbs) {
      packages.push({ name, version, entry: null, exports: [], complete: false });
      continue;
    }
    const { names, complete } = await extractExports(entryAbs, new Set(), 0);
    packages.push({
      name,
      version,
      entry: relative(root, entryAbs).split(sep).join("/"),
      exports: [...names].sort(),
      complete,
    });
  }
  packages.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const report: ApiSemverReport = {
    packages,
    summary: {
      packages: packages.length,
      unanalyzed: packages.filter((p) => p.entry === null).length,
      breaking: 0,
    },
  };

  const baseline = options?.baseline;
  if (!baseline) return report;

  const changes: SemverChange[] = [];
  const verdicts: SemverVerdict[] = [];
  const baseByName = new Map(baseline.packages.map((p) => [p.name, p]));
  const currentByName = new Map(packages.map((p) => [p.name, p]));

  for (const base of baseline.packages) {
    if (!currentByName.has(base.name)) {
      changes.push({ package: base.name, kind: "removed-package", name: null, breaking: true });
    }
  }
  for (const current of packages) {
    const base = baseByName.get(current.name);
    if (!base) {
      changes.push({ package: current.name, kind: "added-package", name: null, breaking: false });
      continue;
    }
    // Removals are provable only when BOTH surfaces are complete; additions only
    // when the BASELINE was complete (else the "new" name may have been hidden).
    const bothComplete = base.complete && current.complete && base.entry !== null && current.entry !== null;
    const baseSet = new Set(base.exports);
    const currentSet = new Set(current.exports);
    const removed = bothComplete ? base.exports.filter((n) => !currentSet.has(n)) : [];
    const added = base.complete && base.entry !== null ? current.exports.filter((n) => !baseSet.has(n)) : [];

    for (const n of removed) changes.push({ package: current.name, kind: "removed-export", name: n, breaking: true });
    for (const n of added) changes.push({ package: current.name, kind: "added-export", name: n, breaking: false });

    const baseV = parseVersion(base.version);
    const curV = parseVersion(current.version);
    let verdict: SemverVerdict["verdict"] = "ok";
    if (removed.length > 0) {
      if (!baseV || !curV) {
        verdict = "unprovable";
      } else {
        // Semver: a major bump legitimizes removals; while still 0.x, a minor
        // bump does too (0.x minor releases may break).
        const bumpedMajor = curV.major > baseV.major;
        const zeroXMinor = baseV.major === 0 && curV.major === 0 && curV.minor > baseV.minor;
        verdict = bumpedMajor || zeroXMinor ? "ok" : "breaking-without-major";
      }
    } else if (added.length > 0 && base.version !== null && base.version === current.version) {
      verdict = "minor-expected";
    } else if (!bothComplete && (base.entry === null || current.entry === null || !base.complete || !current.complete)) {
      verdict = removed.length === 0 && added.length === 0 && !bothComplete ? "unprovable" : verdict;
    }
    verdicts.push({
      package: current.name,
      baseVersion: base.version,
      currentVersion: current.version,
      removed,
      added,
      verdict,
    });
  }

  changes.sort((a, b) =>
    a.package < b.package ? -1 : a.package > b.package ? 1 : (a.name ?? "") < (b.name ?? "") ? -1 : 1,
  );
  report.diff = { changes, verdicts };
  report.summary.breaking = verdicts.filter((v) => v.verdict === "breaking-without-major").length;
  return report;
};
