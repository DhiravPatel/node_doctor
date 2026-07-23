/**
 * Attack-path / exploitability proof (§121).
 *
 * A security finding is only worth acting on if it is *reachable*. The
 * interprocedural taint engine already computes, for every injection sink fed by
 * request data, the exact chain of function calls that carries the caller's input
 * from a request handler to the sink. This surfaces that chain as a navigable
 * source→sink path — the proof, not a heuristic assertion, that the finding is
 * exploitable: caller data enters at the handler, flows through each named helper,
 * and lands in an `eval` / shell / SQL sink.
 *
 * It is deterministic by construction: the path is the one the graph resolved, and
 * an unresolvable dynamic call simply never produced a path in the first place. No
 * new analysis, no false-positive surface beyond what the taint rule already has —
 * this is a *view* over data the engine already trusts enough to raise a finding.
 */

import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import { createLocator } from "./location.ts";
import type { ProjectGraph } from "./graph.ts";

/** One located step in a source→sink path. */
export interface PathStep {
  /** `file:functionName`, as the taint engine labels it. */
  label: string;
  normalizedFilePath: string;
  line: number;
  column: number;
}

export interface AttackPath {
  kind: "eval" | "shell" | "sql";
  /** Human name for the sink class. */
  sinkKind: string;
  /** The sink call site — the last step, where caller data is executed. */
  sink: { normalizedFilePath: string; line: number; column: number };
  /** Handler → helper → … → the function holding the sink. */
  steps: PathStep[];
}

const SINK_LABEL: Record<AttackPath["kind"], string> = {
  eval: "dynamic code execution (eval / Function)",
  shell: "a shell command",
  sql: "a SQL query",
};

/**
 * Every source→sink attack path in the graph, sorted deterministically. Reads each
 * referenced file once to convert byte offsets into `line:column`.
 */
export const collectAttackPaths = async (graph: ProjectGraph, rootDirectory: string): Promise<AttackPath[]> => {
  const sites = graph.taintedSinkSites();

  // One locator per file, built lazily — a path revisits the same files.
  const locators = new Map<string, ReturnType<typeof createLocator> | null>();
  const locatorFor = async (filePath: string): Promise<ReturnType<typeof createLocator> | null> => {
    if (locators.has(filePath)) return locators.get(filePath)!;
    let loc: ReturnType<typeof createLocator> | null = null;
    try {
      loc = createLocator(await readFile(filePath, "utf8"));
    } catch {
      loc = null;
    }
    locators.set(filePath, loc);
    return loc;
  };
  const norm = (filePath: string): string => relative(rootDirectory, filePath).split(sep).join("/");

  const paths: AttackPath[] = [];
  for (const site of sites) {
    const steps: PathStep[] = [];
    for (const hop of site.hops) {
      const loc = await locatorFor(hop.filePath);
      const at = loc ? loc(hop.offset) : { line: 0, column: 0 };
      steps.push({ label: hop.label, normalizedFilePath: norm(hop.filePath), line: at.line, column: at.column });
    }
    const sinkLoc = await locatorFor(site.filePath);
    const sinkAt = sinkLoc ? sinkLoc((site.node.start as number) ?? 0) : { line: site.node.line ?? 0, column: 0 };
    paths.push({
      kind: site.kind,
      sinkKind: SINK_LABEL[site.kind],
      sink: { normalizedFilePath: site.normalizedFilePath, line: sinkAt.line, column: sinkAt.column },
      steps,
    });
  }

  // Deterministic: by sink location, then kind.
  return paths.sort(
    (a, b) =>
      (a.sink.normalizedFilePath < b.sink.normalizedFilePath ? -1 : a.sink.normalizedFilePath > b.sink.normalizedFilePath ? 1 : 0) ||
      a.sink.line - b.sink.line ||
      (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
  );
};
