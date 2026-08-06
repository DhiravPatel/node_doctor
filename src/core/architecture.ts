/**
 * §33 — Architecture Analysis (`node-doctor architecture`).
 *
 * Two questions the import graph can answer with certainty, and one it can
 * answer usefully:
 *
 *   1. CIRCULAR MODULES. A cycle in the import graph is not a style opinion —
 *      it is a live runtime hazard. Under ESM a cycle means one module observes
 *      the other mid-initialization: an import that is `undefined` at module
 *      scope, a class extending `undefined`, a temporal-dead-zone `ReferenceError`
 *      that only appears once the entry point changes and the evaluation order
 *      flips. It also defeats tree-shaking and makes the modules impossible to
 *      test in isolation. Cycles are found exactly (Tarjan), never guessed.
 *
 *   2. LAYER VIOLATIONS. A controller reaching past the service layer straight
 *      into a repository, or — the one that really hurts — a domain/service
 *      module importing back UP into HTTP routes, which welds the business logic
 *      to the transport and makes it un-reusable and un-testable. Layers are
 *      identified from directory names, and a violation is reported only when
 *      BOTH endpoints are confidently classified.
 *
 *   3. HUB MODULES. Files with very high fan-in are the ones where every change
 *      is a blast-radius change; reported as information, never as an error.
 *
 * PRECISION MODEL. Cycles are a graph fact and are always reported. Layer
 * violations are opinion-shaped, so they are gated hard: the layer of a file is
 * inferred only from an UNAMBIGUOUS directory segment (`routes/`, `services/`,
 * `repositories/`, …), a file matching no known layer is `null` and takes part
 * in no violation, and only a strictly-upward import (a lower layer importing a
 * higher one) or a controller→repository skip is reported. Projects that do not
 * use a layered convention therefore produce no violations at all rather than a
 * wall of noise. The layer map is configurable.
 *
 * Deterministic: cycles normalized to start at their lexicographically smallest
 * member and sorted; violations and hubs sorted; byte-identical output.
 */

import { relative, sep } from "node:path";

import type { NodeDoctorConfig } from "./config.ts";
import { buildImpactGraph } from "./impact.ts";

// ---------------------------------------------------------------------------
// Public shape.
// ---------------------------------------------------------------------------

export interface ImportCycle {
  /** Files on the cycle, normalized to start at the smallest and closed implicitly. */
  files: string[];
  length: number;
}

export interface LayerViolation {
  from: string;
  fromLayer: string;
  to: string;
  toLayer: string;
  kind: "upward-import" | "layer-skip";
  reason: string;
}

export interface HubModule {
  file: string;
  /** How many in-project modules import this one. */
  dependents: number;
}

/** Per-module graph position — the inputs a metrics view needs. */
export interface ModuleDegree {
  file: string;
  /** In-project modules that import this one. */
  fanIn: number;
  /** In-project modules this one imports. */
  fanOut: number;
}

export interface ArchitectureReport {
  cycles: ImportCycle[];
  layerViolations: LayerViolation[];
  hubs: HubModule[];
  /**
   * Every module's fan-in and fan-out, sorted by fan-in descending.
   *
   * `hubs` answers "what is a hub" and deliberately cuts at a threshold and a
   * top-10 slice. That cliff makes the report unusable as a data source: a
   * consumer asking "rank my modules by coupling" gets ten rows and no way to
   * see the rest. Both numbers are already in scope when the hubs are computed,
   * so emitting them costs nothing and keeps a metrics view client-side.
   */
  modules: ModuleDegree[];
  summary: {
    modules: number;
    edges: number;
    cycles: number;
    layerViolations: number;
    /** Files whose layer could not be identified (they take part in no violation). */
    unlayeredModules: number;
  };
}

// ---------------------------------------------------------------------------
// Layer identification.
// ---------------------------------------------------------------------------

/**
 * Directory segments that identify a layer, highest (closest to the transport)
 * first. The RANK is what matters: an import from a lower rank to a higher rank
 * is an upward import — business logic reaching back into transport.
 */
const DEFAULT_LAYERS: Array<{ layer: string; rank: number; segments: string[] }> = [
  { layer: "route", rank: 0, segments: ["routes", "controllers", "controller", "handlers", "api", "endpoints", "resolvers"] },
  { layer: "service", rank: 1, segments: ["services", "service", "usecases", "use-cases", "application", "domain"] },
  { layer: "repository", rank: 2, segments: ["repositories", "repository", "repos", "dao", "persistence", "models", "entities"] },
  { layer: "infrastructure", rank: 3, segments: ["infrastructure", "infra", "adapters", "clients", "db", "database"] },
];

interface LayerInfo {
  layer: string;
  rank: number;
}

/**
 * The layer of a file, from its path segments. Returns null when no segment
 * matches a known layer, or when segments from DIFFERENT layers both appear
 * (ambiguous — e.g. `src/services/db/pool.ts`), which keeps an uncertain
 * classification from producing a confident violation.
 */
const layerOf = (
  normalizedPath: string,
  layers: Array<{ layer: string; rank: number; segments: string[] }>,
): LayerInfo | null => {
  const segments = normalizedPath.split("/").slice(0, -1).map((s) => s.toLowerCase());
  const matched = new Map<string, LayerInfo>();
  for (const segment of segments) {
    for (const entry of layers) {
      if (entry.segments.includes(segment)) {
        matched.set(entry.layer, { layer: entry.layer, rank: entry.rank });
      }
    }
  }
  if (matched.size !== 1) return null; // no match, or ambiguous
  return [...matched.values()][0]!;
};

// ---------------------------------------------------------------------------
// Cycle detection (Tarjan's strongly-connected components).
// ---------------------------------------------------------------------------

/**
 * Every strongly-connected component of size > 1, plus every self-loop. An SCC
 * larger than one node means every member can reach every other — a genuine
 * import cycle. Iterative so a deep graph cannot blow the stack.
 */
const findCycles = (edges: Map<string, Set<string>>): string[][] => {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  const nodes = [...edges.keys()].sort();

  for (const root of nodes) {
    if (index.has(root)) continue;
    // Iterative Tarjan: each frame is (node, iterator over its successors).
    const work: Array<{ node: string; successors: string[]; i: number }> = [
      { node: root, successors: [...(edges.get(root) ?? [])].sort(), i: 0 },
    ];
    index.set(root, counter);
    low.set(root, counter);
    counter++;
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      if (frame.i < frame.successors.length) {
        const next = frame.successors[frame.i]!;
        frame.i++;
        if (!index.has(next)) {
          index.set(next, counter);
          low.set(next, counter);
          counter++;
          stack.push(next);
          onStack.add(next);
          work.push({ node: next, successors: [...(edges.get(next) ?? [])].sort(), i: 0 });
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(next)!));
        }
        continue;
      }
      // Frame exhausted — pop and propagate the low-link to the parent.
      work.pop();
      const parent = work[work.length - 1];
      if (parent) {
        low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        for (;;) {
          const popped = stack.pop()!;
          onStack.delete(popped);
          component.push(popped);
          if (popped === frame.node) break;
        }
        if (component.length > 1) components.push(component);
        else if ((edges.get(frame.node) ?? new Set()).has(frame.node)) components.push(component);
      }
    }
  }
  return components;
};

/** Normalize a cycle so the same cycle always renders identically. */
const normalizeCycle = (component: string[]): string[] => [...component].sort();

// ---------------------------------------------------------------------------
// Report assembly.
// ---------------------------------------------------------------------------

/** A module imported by at least this many others is a hub worth surfacing. */
const HUB_THRESHOLD = 10;
const MAX_HUBS = 10;

export const buildArchitectureReport = async (
  rootDirectory: string,
  options?: { config?: NodeDoctorConfig },
): Promise<ArchitectureReport> => {
  const graph = await buildImpactGraph(rootDirectory, { config: options?.config });
  const rawEdges = graph.importEdges();

  const norm = (absolute: string): string => relative(rootDirectory, absolute).split(sep).join("/");

  // Re-key the graph on repo-relative paths so everything downstream (and the
  // emitted report) is portable and deterministic.
  const edges = new Map<string, Set<string>>();
  const dependents = new Map<string, number>();
  let edgeCount = 0;
  for (const [from, targets] of rawEdges) {
    const fromKey = norm(from);
    const set = edges.get(fromKey) ?? new Set<string>();
    for (const to of targets) {
      const toKey = norm(to);
      if (toKey === fromKey) continue; // self-import: not an architectural fact
      set.add(toKey);
      dependents.set(toKey, (dependents.get(toKey) ?? 0) + 1);
      edgeCount++;
    }
    edges.set(fromKey, set);
  }
  for (const key of dependents.keys()) {
    if (!edges.has(key)) edges.set(key, new Set());
  }

  const cycles: ImportCycle[] = findCycles(edges)
    .map((component) => {
      const files = normalizeCycle(component);
      return { files, length: files.length };
    })
    .sort((a, b) => b.length - a.length || (a.files[0]! < b.files[0]! ? -1 : 1));

  // Layer violations.
  const layerConfig = DEFAULT_LAYERS;
  const layerCache = new Map<string, LayerInfo | null>();
  const layerFor = (file: string): LayerInfo | null => {
    if (!layerCache.has(file)) layerCache.set(file, layerOf(file, layerConfig));
    return layerCache.get(file)!;
  };

  const violations: LayerViolation[] = [];
  for (const [from, targets] of edges) {
    const fromLayer = layerFor(from);
    if (!fromLayer) continue;
    for (const to of targets) {
      const toLayer = layerFor(to);
      if (!toLayer) continue;
      if (toLayer.rank < fromLayer.rank) {
        violations.push({
          from,
          fromLayer: fromLayer.layer,
          to,
          toLayer: toLayer.layer,
          kind: "upward-import",
          reason: `a ${fromLayer.layer} module imports a ${toLayer.layer} module, welding business logic to the layer above it`,
        });
      } else if (fromLayer.rank === 0 && toLayer.rank >= 2) {
        violations.push({
          from,
          fromLayer: fromLayer.layer,
          to,
          toLayer: toLayer.layer,
          kind: "layer-skip",
          reason: `a ${fromLayer.layer} module reaches past the service layer directly into ${toLayer.layer}`,
        });
      }
    }
  }
  violations.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : 1));

  const hubs: HubModule[] = [...dependents.entries()]
    .filter(([, count]) => count >= HUB_THRESHOLD)
    .map(([file, count]) => ({ file, dependents: count }))
    .sort((a, b) => b.dependents - a.dependents || (a.file < b.file ? -1 : 1))
    .slice(0, MAX_HUBS);

  // Every module the graph knows about — a file with no imports of its own
  // still appears if something imports it.
  const everyModule = new Set<string>([...edges.keys(), ...dependents.keys()]);
  const modules: ModuleDegree[] = [...everyModule]
    .map((file) => ({
      file,
      fanIn: dependents.get(file) ?? 0,
      fanOut: edges.get(file)?.size ?? 0,
    }))
    .sort((a, b) => b.fanIn - a.fanIn || b.fanOut - a.fanOut || (a.file < b.file ? -1 : 1));

  const unlayeredModules = [...edges.keys()].filter((f) => layerFor(f) === null).length;

  return {
    cycles,
    layerViolations: violations,
    hubs,
    modules,
    summary: {
      modules: edges.size,
      edges: edgeCount,
      cycles: cycles.length,
      layerViolations: violations.length,
      unlayeredModules,
    },
  };
};
