/**
 * node-deslop — the dead-code scanner (§16).
 *
 * Finds three things across a project, using the same parse + import graph the
 * analyzer uses:
 *   - unused exports  (exported, never imported anywhere in-project),
 *   - unused files    (never imported, and not an entry point),
 *   - unused deps     (a dependency never imported).
 *
 * Dead-code detection is inherently heuristic, so everything here is tuned toward
 * *not* crying wolf: namespace imports and re-exports mark their whole target as
 * used, entry points (package main/bin, index files, shebang scripts) are never
 * reported as unused, and results are labeled candidates.
 */

import { readFile } from "node:fs/promises";
import { dirname, join, resolve, basename, relative, sep } from "node:path";
import { builtinModules } from "node:module";
import fg from "fast-glob";
import type { AstNode } from "../core/types.ts";
import { parseSource } from "../core/parse.ts";
import { walk } from "../core/walk.ts";
import { getCalleeName } from "../core/ast.ts";
import { BUILTIN_IGNORES } from "../core/config.ts";

const SOURCE_GLOB = "**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}";
const CANDIDATE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  "/index.ts",
  "/index.js",
  "/index.mjs",
  "/index.tsx",
];

export interface DeslopResult {
  unusedFiles: string[];
  unusedExports: Array<{ file: string; name: string }>;
  unusedDependencies: string[];
  /**
   * §154 — packages IMPORTED but not declared in package.json (any dep list).
   * These work locally only because a hoisted transitive dependency happens to
   * provide them; they break the moment the tree changes, the package manager
   * switches, or a `--production` / clean install runs. Node builtins, the package's
   * own name, and same-scope workspace siblings are excluded.
   */
  undeclaredDependencies: string[];
  scannedFiles: number;
}

interface FileFacts {
  path: string;
  normalized: string;
  exports: Set<string>;
  /** in-project relative imports: { targetFile, names, namespace } */
  localUses: Array<{ target: string | null; names: Set<string>; namespace: boolean }>;
  /** bare package specifiers imported (top-level name only). */
  bareImports: Set<string>;
  hasShebang: boolean;
}

const bareName = (spec: string): string =>
  spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;

// Node builtins are always available and never declared — never "undeclared". Built
// from the running Node's own list plus the `node:` prefix (always a builtin).
const BUILTIN_MODULES = new Set(builtinModules);
const isBuiltinModule = (name: string): boolean =>
  name.startsWith("node:") || BUILTIN_MODULES.has(name) || BUILTIN_MODULES.has(name.replace(/^node:/, ""));

const collectFacts = (path: string, normalized: string, source: string): FileFacts => {
  const { program } = parseSource(path, source);
  const exports = new Set<string>();
  const localUses: FileFacts["localUses"] = [];
  const bareImports = new Set<string>();

  const recordImport = (spec: string, names: string[], namespace: boolean): void => {
    if (spec.startsWith(".")) {
      localUses.push({ target: spec, names: new Set(names), namespace });
    } else {
      bareImports.add(bareName(spec));
    }
  };

  for (const stmt of (program.body as AstNode[]) ?? []) {
    switch (stmt.type) {
      case "ImportDeclaration": {
        const spec = stmt.source?.value as string;
        const names: string[] = [];
        let ns = false;
        for (const s of (stmt.specifiers as AstNode[]) ?? []) {
          if (s.type === "ImportDefaultSpecifier") names.push("default");
          else if (s.type === "ImportNamespaceSpecifier") ns = true;
          else names.push(s.imported?.name ?? s.local?.name);
        }
        recordImport(spec, names, ns);
        break;
      }
      case "ExportNamedDeclaration": {
        if (stmt.source) {
          // re-export: export { a } from "./x" — uses ./x's a (and re-exports it)
          const names = (stmt.specifiers as AstNode[]).map((s) => s.local?.name).filter(Boolean);
          recordImport(stmt.source.value as string, names, false);
          for (const s of stmt.specifiers as AstNode[]) if (s.exported?.name) exports.add(s.exported.name);
        } else if (stmt.declaration) {
          const decl = stmt.declaration;
          if (decl.id?.name) exports.add(decl.id.name);
          for (const d of (decl.declarations as AstNode[]) ?? []) {
            if (d.id?.type === "Identifier") exports.add(d.id.name);
          }
        } else {
          for (const s of (stmt.specifiers as AstNode[]) ?? []) if (s.exported?.name) exports.add(s.exported.name);
        }
        break;
      }
      case "ExportDefaultDeclaration":
        exports.add("default");
        break;
      case "ExportAllDeclaration":
        // export * from "./x" — mark the whole target used
        recordImport((stmt.source?.value as string) ?? "", [], true);
        break;
      default:
        break;
    }
  }

  // CJS require() and dynamic import() anywhere in the file.
  walk(program, {
    enter: (node) => {
      let specNode: AstNode | undefined;
      if (node.type === "CallExpression" && getCalleeName(node) === "require") {
        specNode = (node.arguments as AstNode[])?.[0];
      } else if (node.type === "ImportExpression") {
        specNode = node.source;
      }
      if (specNode?.type === "Literal" && typeof specNode.value === "string") {
        recordImport(specNode.value, [], true);
      }
    },
  });

  return {
    path,
    normalized,
    exports,
    localUses,
    bareImports,
    hasShebang: source.startsWith("#!"),
  };
};

const resolveLocal = (spec: string, fromFile: string, byPath: Map<string, FileFacts>): string | null => {
  const base = resolve(dirname(fromFile), spec);
  if (byPath.has(base)) return base;
  for (const ext of CANDIDATE_EXTENSIONS) {
    const cand = base.endsWith(ext) ? base : base + ext;
    if (byPath.has(cand)) return cand;
  }
  const noExt = base.replace(/\.(js|mjs|cjs|jsx)$/i, "");
  for (const ext of CANDIDATE_EXTENSIONS) if (byPath.has(noExt + ext)) return noExt + ext;
  return null;
};

const isEntryPoint = (facts: FileFacts, entryPaths: Set<string>): boolean => {
  if (entryPaths.has(facts.path)) return true;
  if (facts.hasShebang) return true;
  const b = basename(facts.path).toLowerCase();
  return b.startsWith("index.") || b.startsWith("main.") || b.startsWith("server.") || facts.path.includes(`${sep}bin${sep}`);
};

export const runDeslop = async (
  rootDirectory: string,
  options: { ignore?: string[] } = {},
): Promise<DeslopResult> => {
  const root = resolve(rootDirectory);
  const files = (
    await fg([SOURCE_GLOB], {
      cwd: root,
      ignore: [...BUILTIN_IGNORES, "**/*.test.*", "**/*.spec.*", ...(options.ignore ?? [])],
      absolute: true,
      dot: false,
      suppressErrors: true,
    })
  ).sort();

  // Entry points from package.json.
  const entryPaths = new Set<string>();
  let deps = new Set<string>();
  // Every DECLARED dependency (any list) — used to find both unused (declared,
  // never imported) and undeclared (imported, never declared) packages.
  const declared = new Set<string>();
  let selfName: string | null = null;
  let selfScope: string | null = null;
  let hasManifest = false;
  try {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      name?: string;
      main?: string;
      module?: string;
      bin?: string | Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    hasManifest = true;
    for (const e of [pkg.main, pkg.module]) if (e) entryPaths.add(resolve(root, e));
    if (typeof pkg.bin === "string") entryPaths.add(resolve(root, pkg.bin));
    else if (pkg.bin) for (const v of Object.values(pkg.bin)) entryPaths.add(resolve(root, v));
    deps = new Set(Object.keys(pkg.dependencies ?? {}));
    for (const map of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies, pkg.optionalDependencies]) {
      for (const name of Object.keys(map ?? {})) declared.add(name);
    }
    selfName = pkg.name ?? null;
    selfScope = selfName && selfName.startsWith("@") ? selfName.split("/")[0]! : null;
  } catch {
    /* no manifest */
  }

  const factsList: FileFacts[] = [];
  const byPath = new Map<string, FileFacts>();
  for (const path of files) {
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const normalized = relative(root, path).split(sep).join("/");
    const f = collectFacts(path, normalized, source);
    factsList.push(f);
    byPath.set(path, f);
  }

  // Build usage: which (file, exportName) are consumed, which files are imported,
  // which bare deps are referenced.
  const usedExports = new Map<string, Set<string>>();
  const importedFiles = new Set<string>();
  const usedDeps = new Set<string>();

  for (const f of factsList) {
    for (const dep of f.bareImports) usedDeps.add(dep);
    for (const use of f.localUses) {
      if (use.target === null) continue;
      const target = resolveLocal(use.target, f.path, byPath);
      if (!target) continue;
      importedFiles.add(target);
      if (use.namespace) {
        const all = byPath.get(target)!.exports;
        usedExports.set(target, new Set([...(usedExports.get(target) ?? []), ...all]));
      } else {
        const set = usedExports.get(target) ?? new Set<string>();
        for (const n of use.names) set.add(n);
        usedExports.set(target, set);
      }
    }
  }

  const unusedFilePaths = new Set(
    factsList.filter((f) => !importedFiles.has(f.path) && !isEntryPoint(f, entryPaths)).map((f) => f.path),
  );

  const unusedExports: DeslopResult["unusedExports"] = [];
  for (const f of factsList) {
    // Skip entry points (their exports ARE the public surface) and files already
    // reported wholesale as unused (reporting each export would be redundant).
    if (isEntryPoint(f, entryPaths) || unusedFilePaths.has(f.path)) continue;
    const used = usedExports.get(f.path) ?? new Set<string>();
    for (const name of f.exports) {
      if (!used.has(name)) unusedExports.push({ file: f.normalized, name });
    }
  }

  const unusedFiles = [...unusedFilePaths].map((p) => byPath.get(p)!.normalized);

  const unusedDependencies = [...deps].filter((d) => !usedDeps.has(d)).sort();

  // Respect package.json BOUNDARIES for the undeclared check: an import is governed
  // by the NEAREST-ancestor package.json, so a sample app under tests/fixtures/<app>/
  // (with its own manifest) is checked against ITS manifest, never the root's. Only
  // imports from root-governed files count toward the root manifest's undeclared set.
  const pkgDirs = (
    await fg(["**/package.json"], { cwd: root, ignore: [...BUILTIN_IGNORES], absolute: true, suppressErrors: true })
  )
    .map((p) => dirname(p))
    .sort((a, b) => b.length - a.length);
  const governedByRoot = (filePath: string): boolean => {
    const d = dirname(filePath);
    for (const pd of pkgDirs) {
      if (d === pd || d.startsWith(pd + sep)) return pd === root;
    }
    return true;
  };
  const rootUsedDeps = new Set<string>();
  for (const f of factsList) {
    if (governedByRoot(f.path)) for (const dep of f.bareImports) rootUsedDeps.add(dep);
  }

  // §154 — imported but not declared. Only meaningful with a manifest to check
  // against. Exclude Node builtins, the package's own name, and same-scope workspace
  // siblings (`@myorg/api` importing `@myorg/shared` — a workspace member, not a
  // missing registry dep).
  const undeclaredDependencies = hasManifest
    ? [...rootUsedDeps]
        .filter(
          (d) =>
            !declared.has(d) &&
            !isBuiltinModule(d) &&
            d !== selfName &&
            !(selfScope !== null && d.startsWith(selfScope + "/")),
        )
        .sort()
    : [];

  unusedExports.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.name < b.name ? -1 : 1));
  unusedFiles.sort();

  return {
    unusedFiles,
    unusedExports,
    unusedDependencies,
    undeclaredDependencies,
    scannedFiles: factsList.length,
  };
};
