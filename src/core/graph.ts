/**
 * The project pass (Phase B): module import graph + reachability from request
 * handlers, with per-function effect summaries flowing along call edges.
 *
 * This is what lets a diagnostic flag `readFileSync` that lives in `cache.warm()`,
 * three modules away from the handler that reaches it — the single biggest gap
 * between a demo and a production tool.
 *
 * Reachability is intentionally conservative: an edge is added only when the
 * callee resolves to a concrete function node (a same-file binding or a resolved
 * import). Unresolvable dynamic calls simply don't extend reach, keeping the
 * analysis sound-toward-silence.
 */

import { dirname, resolve as resolvePath } from "node:path";
import type { AstNode } from "./types.ts";
import type { ScopeResolver } from "./scope.ts";
import { walk, collectDescendants } from "./walk.ts";
import { getMethodName, isFunctionLike } from "./ast.ts";
import { summarizeEffects, type EffectSummary } from "./effects.ts";
import { SYNC_IO_METHODS } from "./signals.ts";

/** Facts collected for one module during Phase A. */
export interface ModuleFacts {
  filePath: string;
  normalizedFilePath: string;
  program: AstNode;
  scope: ScopeResolver;
  handlers: Set<AstNode>;
  /** local name → function node for top-level function/const-arrow bindings. */
  localFunctions: Map<string, AstNode>;
  /** exported name → function node. */
  exportedFunctions: Map<string, AstNode>;
  /** import local name → { source specifier, imported name ("default"/"*"/name) }. */
  imports: Map<string, { source: string; imported: string }>;
}

export interface ReachableEffect {
  filePath: string;
  normalizedFilePath: string;
  /** The call site (in a handler or helper) that carries the effect. */
  node: AstNode;
  /** Method name of the effectful call (e.g. "readFileSync"). */
  method: string;
  /** Human hop trail: handler → helper → … → effect. */
  via: string[];
}

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
];

/** Collect the top-level function/exported/import facts for one module. */
export const collectModuleFacts = (
  filePath: string,
  normalizedFilePath: string,
  program: AstNode,
  scope: ScopeResolver,
  handlers: Set<AstNode>,
): ModuleFacts => {
  const localFunctions = new Map<string, AstNode>();
  const exportedFunctions = new Map<string, AstNode>();
  const imports = new Map<string, { source: string; imported: string }>();

  const recordBinding = (name: string, value: AstNode | null | undefined): AstNode | null => {
    if (!value) return null;
    if (isFunctionLike(value)) {
      localFunctions.set(name, value);
      return value;
    }
    return null;
  };

  for (const stmt of (program.body as AstNode[]) ?? []) {
    let decl = stmt;
    let exported = false;
    if (stmt.type === "ExportNamedDeclaration" && stmt.declaration) {
      decl = stmt.declaration;
      exported = true;
    } else if (stmt.type === "ExportDefaultDeclaration") {
      const value = stmt.declaration;
      if (isFunctionLike(value)) exportedFunctions.set("default", value);
      continue;
    } else if (stmt.type === "ImportDeclaration") {
      // Type-only imports (`import type …`) are erased at runtime — they form no
      // runtime edge, so they never resolve to a callable and never close a
      // runtime import cycle. Exclude them from the graph.
      if (stmt.importKind === "type") continue;
      const source = stmt.source?.value;
      for (const spec of (stmt.specifiers as AstNode[]) ?? []) {
        if (spec.local?.type !== "Identifier") continue;
        if (spec.importKind === "type") continue; // inline `import { type X }`
        const imported =
          spec.type === "ImportDefaultSpecifier"
            ? "default"
            : spec.type === "ImportNamespaceSpecifier"
              ? "*"
              : (spec.imported?.name ?? spec.local.name);
        imports.set(spec.local.name, { source: String(source), imported });
      }
      continue;
    }

    if (decl.type === "FunctionDeclaration" && decl.id?.type === "Identifier") {
      localFunctions.set(decl.id.name, decl);
      if (exported) exportedFunctions.set(decl.id.name, decl);
    } else if (decl.type === "VariableDeclaration") {
      for (const d of decl.declarations as AstNode[]) {
        if (d.id?.type === "Identifier") {
          const fn = recordBinding(d.id.name, d.init);
          if (fn && exported) exportedFunctions.set(d.id.name, fn);
        }
      }
    }
  }

  return {
    filePath,
    normalizedFilePath,
    program,
    scope,
    handlers,
    localFunctions,
    exportedFunctions,
    imports,
  };
};

export interface ProjectGraph {
  modules: Map<string, ModuleFacts>;
  /** Resolve a call node to a concrete function node, across files. */
  resolveCallee(call: AstNode, fromFile: string): AstNode | null;
  /** Is `fn` reachable from any request handler? */
  isReachableFromHandler(fn: AstNode): boolean;
  /** Effects summary for a function (cached). */
  effectsOf(fn: AstNode): EffectSummary;
  /** Every blocking sync-IO site reachable from a handler through helpers. */
  reachableSyncIoSites(): ReachableEffect[];
  /** Resolve an in-project import specifier to a module file path (or null). */
  resolveImport(spec: string, fromFile: string): string | null;
  /** In-project import edges: file path → set of imported file paths. */
  importEdges(): Map<string, Set<string>>;
  /** Is the import edge from→to on a cycle? */
  isCycleEdge(fromFile: string, toFile: string): boolean;
  /** Does the project contain any import cycle? */
  hasCycles(): boolean;
}

/** Resolve a relative import specifier to an absolute file key in `modules`. */
const resolveModule = (
  spec: string,
  fromFile: string,
  modules: Map<string, ModuleFacts>,
): ModuleFacts | null => {
  if (!spec.startsWith(".")) return null; // bare/package import — not in-project
  const base = resolvePath(dirname(fromFile), spec);
  if (modules.has(base)) return modules.get(base)!;
  for (const ext of CANDIDATE_EXTENSIONS) {
    const candidate = base.endsWith(ext) ? base : base + ext;
    if (modules.has(candidate)) return modules.get(candidate)!;
  }
  // A ".js" specifier often maps to a ".ts" source (NodeNext rewriting).
  const withoutExt = base.replace(/\.(js|mjs|cjs|jsx)$/i, "");
  for (const ext of CANDIDATE_EXTENSIONS) {
    if (modules.has(withoutExt + ext)) return modules.get(withoutExt + ext)!;
  }
  return null;
};

/** Build the project graph and compute reachability from handlers. */
export const buildProjectGraph = (moduleFactsList: ModuleFacts[]): ProjectGraph => {
  const modules = new Map<string, ModuleFacts>();
  for (const facts of moduleFactsList) modules.set(facts.filePath, facts);

  // Map every function node → the module it lives in.
  const fnModule = new Map<AstNode, ModuleFacts>();
  for (const facts of moduleFactsList) {
    walk(facts.program, {
      enter: (node) => {
        if (isFunctionLike(node)) fnModule.set(node, facts);
      },
    });
  }

  const effectCache = new Map<AstNode, EffectSummary>();
  const effectsOf = (fn: AstNode): EffectSummary => {
    let cached = effectCache.get(fn);
    if (!cached) {
      cached = summarizeEffects(fn);
      effectCache.set(fn, cached);
    }
    return cached;
  };

  const resolveCallee = (call: AstNode, fromFile: string): AstNode | null => {
    const facts = modules.get(fromFile);
    if (!facts) return null;
    const callee = call.callee;
    if (!callee) return null;

    // Simple local call: foo(...)
    if (callee.type === "Identifier") {
      const name = callee.name;
      const local = facts.localFunctions.get(name);
      if (local) return local;
      const imp = facts.imports.get(name);
      if (imp) {
        const target = resolveModule(imp.source, fromFile, modules);
        if (target) {
          const fn =
            target.exportedFunctions.get(imp.imported) ??
            (imp.imported === "default" ? target.exportedFunctions.get("default") : undefined);
          if (fn) return fn;
        }
      }
      return null;
    }

    // Namespace member call: ns.fn(...) where ns is `import * as ns`.
    if (callee.type === "MemberExpression" && callee.object?.type === "Identifier") {
      const imp = facts.imports.get(callee.object.name);
      const method = getMethodName(call);
      if (imp && imp.imported === "*" && method) {
        const target = resolveModule(imp.source, fromFile, modules);
        if (target) {
          const fn = target.exportedFunctions.get(method);
          if (fn) return fn;
        }
      }
    }
    return null;
  };

  // Reachability: BFS from every handler over resolved call edges.
  const reachable = new Set<AstNode>();
  const queue: AstNode[] = [];
  for (const facts of moduleFactsList) {
    for (const handler of facts.handlers) {
      if (!reachable.has(handler)) {
        reachable.add(handler);
        queue.push(handler);
      }
    }
  }
  while (queue.length > 0) {
    const fn = queue.shift()!;
    const facts = fnModule.get(fn);
    if (!facts) continue;
    walk(fn.body ?? fn, {
      enter: (node) => {
        if (node.type === "CallExpression") {
          const callee = resolveCallee(node, facts.filePath);
          if (callee && !reachable.has(callee)) {
            reachable.add(callee);
            queue.push(callee);
          }
        }
      },
    });
  }

  const resolveImport = (spec: string, fromFile: string): string | null =>
    resolveModule(spec, fromFile, modules)?.filePath ?? null;

  let importEdgesCache: Map<string, Set<string>> | null = null;
  const importEdges = (): Map<string, Set<string>> => {
    if (importEdgesCache) return importEdgesCache;
    const edges = new Map<string, Set<string>>();
    for (const facts of modules.values()) {
      const targets = new Set<string>();
      for (const { source } of facts.imports.values()) {
        const t = resolveModule(source, facts.filePath, modules);
        if (t && t.filePath !== facts.filePath) targets.add(t.filePath);
      }
      edges.set(facts.filePath, targets);
    }
    importEdgesCache = edges;
    return edges;
  };

  let cycleEdgesCache: Map<string, Set<string>> | null = null;
  const cycleEdges = (): Map<string, Set<string>> => {
    if (cycleEdgesCache) return cycleEdgesCache;
    const edges = importEdges();
    const reachableFrom = (start: string): Set<string> => {
      const seen = new Set<string>();
      const stack = [...(edges.get(start) ?? [])];
      while (stack.length > 0) {
        const n = stack.pop()!;
        if (seen.has(n)) continue;
        seen.add(n);
        for (const m of edges.get(n) ?? []) stack.push(m);
      }
      return seen;
    };
    const reach = new Map<string, Set<string>>();
    for (const from of edges.keys()) reach.set(from, reachableFrom(from));
    // Edge from->to is on a cycle iff `to` can reach back to `from`.
    const out = new Map<string, Set<string>>();
    for (const [from, targets] of edges) {
      for (const to of targets) {
        if (reach.get(to)?.has(from)) {
          const set = out.get(from) ?? new Set<string>();
          set.add(to);
          out.set(from, set);
        }
      }
    }
    cycleEdgesCache = out;
    return out;
  };
  const isCycleEdge = (fromFile: string, toFile: string): boolean =>
    cycleEdges().get(fromFile)?.has(toFile) ?? false;
  const hasCycles = (): boolean => cycleEdges().size > 0;

  const graph: ProjectGraph = {
    modules,
    resolveCallee,
    isReachableFromHandler: (fn) => reachable.has(fn),
    effectsOf,
    resolveImport,
    importEdges,
    isCycleEdge,
    hasCycles,
    reachableSyncIoSites: () => {
      const sites: ReachableEffect[] = [];
      const seen = new Set<AstNode>();
      for (const fn of reachable) {
        const facts = fnModule.get(fn);
        if (!facts) continue;
        // Only report effects that live in a *helper* — a function reachable from
        // a handler but not itself a handler. The intra-file diagnostic already covers
        // sync IO written directly inside a handler.
        if (facts.handlers.has(fn)) continue;
        // Sync-IO calls directly in this helper's own body (not nested functions,
        // whose bodies only run if separately invoked).
        const calls = collectDescendants(
          fn.body ?? fn,
          (n) => n.type === "CallExpression",
          isFunctionLike,
        );
        for (const call of calls) {
          if (seen.has(call)) continue;
          const method = getMethodName(call);
          if (method && SYNC_IO_METHODS.has(method)) {
            seen.add(call);
            sites.push({
              filePath: facts.filePath,
              normalizedFilePath: facts.normalizedFilePath,
              node: call,
              method,
              via: [facts.normalizedFilePath],
            });
          }
        }
      }
      return sites;
    },
  };

  return graph;
};
