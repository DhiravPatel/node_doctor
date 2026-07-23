/**
 * Blast-radius / change-impact analysis (§120).
 *
 * "If I touch this file, what breaks?" — answered from the project import graph
 * rather than guessed. Given a set of changed files, it walks the graph *backward*
 * (who imports whom) to every file that transitively depends on them, and marks
 * which of those contain request handlers — the routes whose behaviour a change
 * can actually alter. In a monorepo the same walk crosses package boundaries, so
 * a change in `packages/db` surfaces the apps that would ship it.
 *
 * This is deterministic graph reachability, not a heuristic: a file is either a
 * transitive dependent or it is not. There is no false-positive surface the way a
 * pattern-matching diagnostic has — the only judgement is what the import graph
 * can resolve, and an unresolved dynamic import simply does not extend reach
 * (sound toward silence, exactly like the rest of the engine).
 *
 * It pairs with `--diff`: the blast radius of the files a PR changed is the review
 * surface that matters, and "your two-line change to db/pool.ts is reachable from
 * 14 routes" is the sentence that makes a reviewer slow down.
 */

import { relative, sep } from "node:path";
import { readFile } from "node:fs/promises";
import fg from "fast-glob";
import { parseSource } from "./parse.ts";
import { attachParents } from "./walk.ts";
import { resolveScopes } from "./scope.ts";
import { collectRequestHandlers } from "./request-path.ts";
import { collectModuleFacts, buildProjectGraph, type ProjectGraph, type WorkspacePackages } from "./graph.ts";
import { BUILTIN_IGNORES, type NodeDoctorConfig } from "./config.ts";
import { mapPool } from "./pool.ts";

const SOURCE_GLOB = "**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}";

/** One file that transitively depends on a changed file. */
export interface Dependent {
  /** Repo-relative, forward-slash path. */
  normalizedFilePath: string;
  /** Absolute path. */
  filePath: string;
  /** Fewest import hops from any changed file (1 = direct importer). */
  depth: number;
  /** Does this file register a request handler? Its routes may change behaviour. */
  hasHandlers: boolean;
}

export interface ImpactReport {
  /** The changed files that were found in the graph, normalized + sorted. */
  changed: string[];
  /** Changed files that were requested but are not in the analyzed graph. */
  unresolved: string[];
  /** Every transitive dependent, nearest first then alphabetical. */
  dependents: Dependent[];
  /** Dependents that contain request handlers — the routes at risk. */
  routeBearingFiles: string[];
  /** Total distinct files whose behaviour a change can reach (dependents only). */
  reachedCount: number;
}

/**
 * Invert the forward import edges into "who imports X", then BFS outward from the
 * changed set. Pure and deterministic: inputs are the graph and the changed set,
 * output is sorted, and Map iteration never reaches the result.
 */
export const computeImpact = (graph: ProjectGraph, changedAbsolute: readonly string[]): ImpactReport => {
  // Reverse edges: importedFile → set of files that import it.
  const reverse = new Map<string, Set<string>>();
  for (const [from, tos] of graph.importEdges()) {
    for (const to of tos) {
      const set = reverse.get(to) ?? new Set<string>();
      set.add(from);
      reverse.set(to, set);
    }
  }

  const inGraph = new Set(graph.modules.keys());
  const changed: string[] = [];
  const unresolved: string[] = [];
  const seeds: string[] = [];
  for (const abs of changedAbsolute) {
    if (inGraph.has(abs)) {
      seeds.push(abs);
      changed.push(graph.modules.get(abs)!.normalizedFilePath);
    } else {
      unresolved.push(abs);
    }
  }

  // BFS over reverse edges, recording the shortest depth to each dependent.
  const depth = new Map<string, number>();
  let frontier = [...new Set(seeds)];
  let d = 0;
  const seed = new Set(seeds);
  while (frontier.length > 0) {
    d += 1;
    const next: string[] = [];
    for (const file of frontier) {
      for (const importer of reverse.get(file) ?? []) {
        // A changed file that also imports another changed file is not its own
        // dependent; and the shortest depth wins.
        if (seed.has(importer)) continue;
        if (depth.has(importer)) continue;
        depth.set(importer, d);
        next.push(importer);
      }
    }
    frontier = next;
  }

  const dependents: Dependent[] = [...depth.entries()]
    .map(([filePath, hops]) => {
      const facts = graph.modules.get(filePath);
      return {
        filePath,
        normalizedFilePath: facts?.normalizedFilePath ?? filePath,
        depth: hops,
        hasHandlers: (facts?.handlers.size ?? 0) > 0,
      };
    })
    .sort((a, b) => a.depth - b.depth || (a.normalizedFilePath < b.normalizedFilePath ? -1 : 1));

  return {
    changed: changed.slice().sort(),
    unresolved: unresolved.slice().sort(),
    dependents,
    routeBearingFiles: dependents.filter((x) => x.hasHandlers).map((x) => x.normalizedFilePath).sort(),
    reachedCount: dependents.length,
  };
};

export interface BuildImpactGraphOptions {
  config?: NodeDoctorConfig;
  only?: string[];
  parallel?: boolean;
  workspacePackages?: WorkspacePackages;
}

/**
 * Build a project graph over a directory purely for impact queries — the same
 * Phase-A fact collection the scanner does, without running any diagnostic.
 */
export const buildImpactGraph = async (
  rootDirectory: string,
  options: BuildImpactGraphOptions = {},
): Promise<ProjectGraph> => {
  const files =
    options.only && options.only.length > 0
      ? options.only.slice().sort()
      : (
          await fg([SOURCE_GLOB], {
            cwd: rootDirectory,
            ignore: [...BUILTIN_IGNORES, ...(options.config?.ignore ?? [])],
            absolute: true,
            dot: false,
            followSymbolicLinks: false,
            suppressErrors: true,
          })
        ).sort();

  const concurrency = options.parallel === false ? 1 : 8;
  const factsList = (
    await mapPool(files, concurrency, async (filePath) => {
      let sourceText: string;
      try {
        sourceText = await readFile(filePath, "utf8");
      } catch {
        return null;
      }
      const parsed = parseSource(filePath, sourceText);
      if (parsed.parseFailed) return null;
      const program = parsed.program;
      attachParents(program);
      const scope = resolveScopes(program);
      const handlers = collectRequestHandlers(program, scope);
      const normalizedFilePath = relative(rootDirectory, filePath).split(sep).join("/");
      return collectModuleFacts(filePath, normalizedFilePath, program, scope, handlers);
    })
  ).filter((f): f is NonNullable<typeof f> => f !== null);

  return buildProjectGraph(factsList, options.workspacePackages);
};
