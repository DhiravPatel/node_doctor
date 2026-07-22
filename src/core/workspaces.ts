/**
 * Monorepo / npm-workspace support: discover every member package, scan each as
 * its own project (through a bounded concurrency pool), score them separately,
 * and aggregate a worst-of summary. Config is merged additively — a member's
 * config layers over the workspace-root config.
 *
 * Zero-config: a plain single package has no `workspaces` field, so discovery
 * returns nothing and the caller falls back to a single scan.
 */

import { readFile } from "node:fs/promises";
import { join, dirname, basename, resolve, relative, sep } from "node:path";
import fg from "fast-glob";
import { scanProject, sortFindings, type ScanReport, type ScanProjectOptions } from "./scan.ts";
import { loadConfig, mergeConfig, type NodeDoctorConfig } from "./config.ts";
import { calculateScore, type ScoreResult } from "./score.ts";
import { mapPool } from "./pool.ts";
import type { ModuleFacts } from "./graph.ts";

/** Extract `packages:` globs from a pnpm-workspace.yaml (small, tolerant parser). */
const parsePnpmPackages = (yaml: string): string[] => {
  const globs: string[] = [];
  let inPackages = false;
  for (const raw of yaml.split("\n")) {
    const line = raw.replace(/#.*$/, "");
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const item = /^\s*-\s*(.+?)\s*$/.exec(line);
      if (item) {
        globs.push(item[1]!.replace(/^["']|["']$/g, ""));
      } else if (/^\S/.test(line)) {
        inPackages = false; // dedented to a new top-level key
      }
    }
  }
  return globs;
};

/** The workspace globs declared at `rootDir` (package.json `workspaces` + pnpm). */
export const discoverWorkspaceGlobs = async (rootDir: string): Promise<string[]> => {
  const globs: string[] = [];
  try {
    const pkg = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8")) as {
      workspaces?: string[] | { packages?: string[] };
    };
    const ws = pkg.workspaces;
    if (Array.isArray(ws)) globs.push(...ws.filter((s): s is string => typeof s === "string"));
    else if (ws && Array.isArray(ws.packages)) globs.push(...ws.packages.filter((s): s is string => typeof s === "string"));
  } catch {
    /* no/invalid package.json */
  }
  try {
    globs.push(...parsePnpmPackages(await readFile(join(rootDir, "pnpm-workspace.yaml"), "utf8")));
  } catch {
    /* no pnpm-workspace.yaml */
  }
  return [...new Set(globs)];
};

export const isWorkspaceRoot = async (rootDir: string): Promise<boolean> =>
  (await discoverWorkspaceGlobs(rootDir)).length > 0;

/** Every member package root (a directory containing package.json), sorted. */
export const discoverWorkspaces = async (rootDir: string): Promise<string[]> => {
  const globs = await discoverWorkspaceGlobs(rootDir);
  if (globs.length === 0) return [];

  const positives = globs.filter((g) => !g.startsWith("!"));
  const negatives = globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1));
  const patterns = positives.map((g) => `${g.replace(/\/+$/, "")}/package.json`);
  const ignore = ["**/node_modules/**", ...negatives.map((g) => `${g.replace(/\/+$/, "")}/**`)];

  const matches = await fg(patterns, {
    cwd: rootDir,
    absolute: true,
    ignore,
    onlyFiles: true,
    suppressErrors: true,
    followSymbolicLinks: false,
  });
  return [...new Set(matches.map((m) => dirname(m)))].sort();
};

const readPackageName = async (dir: string): Promise<string> => {
  try {
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { name?: string };
    if (typeof pkg.name === "string" && pkg.name.length > 0) return pkg.name;
  } catch {
    /* fall through */
  }
  return basename(dir);
};

export interface WorkspaceProjectReport {
  name: string;
  packageRoot: string;
  /** Repo-relative, forward-slash root path. */
  normalizedRoot: string;
  report: ScanReport;
}

export interface WorkspaceReport {
  schemaVersion: number;
  multiProject: true;
  rootDirectory: string;
  projects: WorkspaceProjectReport[];
  /** Worst (lowest) project score — the headline for the whole workspace. */
  score: ScoreResult;
  worstProject: string | null;
  projectCount: number;
  totalFindings: number;
}

export interface ScanWorkspacesOptions extends Omit<ScanProjectOptions, "rootDirectory"> {
  /** Select member projects by name, basename, or path (repeatable). */
  projectFilter?: string[];
  /** Max projects scanned concurrently (default: 4). */
  projectConcurrency?: number;
}

/** Does a member match one of the --project selectors? */
const matchesFilter = (name: string, normalizedRoot: string, packageRoot: string, rootDir: string, selectors: string[]): boolean =>
  selectors.some((sel) => {
    if (sel === name || sel === basename(packageRoot)) return true;
    if (normalizedRoot === sel.replace(/\/+$/, "")) return true;
    return packageRoot === resolve(rootDir, sel);
  });

/**
 * §96 — cross-package reachability.
 *
 * A member scanned on its own cannot know that `packages/db`'s synchronous read
 * sits on a request path, because the handler that reaches it lives in
 * `apps/api`. This second pass rebuilds the project graph over *every* member's
 * facts, so reachability crosses the package boundary.
 *
 * Two deliberate bounds keep the cost honest:
 *  - Only members that another member imports are re-analyzed. A leaf app gains
 *    nothing — its own handlers were already in its own graph.
 *  - Findings are deduplicated by finding `id` (path + position + rule), so what survives is exactly the
 *    set that needed the cross-package edge to be seen at all.
 *
 * A cross-package finding is attributed to the package that *contains* it, not
 * the one that reaches it: that is the team who has to fix the code.
 */
const addCrossPackageFindings = async (
  projects: WorkspaceProjectReport[],
  workspacePackages: Map<string, string>,
  factsByRoot: Map<string, ModuleFacts[]>,
  rootConfig: NodeDoctorConfig,
  options: ScanWorkspacesOptions,
): Promise<void> => {
  if (projects.length < 2) return;

  // Member-level import edges: who imports whom, by package name.
  const importsOf = new Map<string, Set<string>>();
  for (const [ownerRoot, facts] of factsByRoot) {
    const targets = new Set<string>();
    for (const f of facts) {
      for (const imp of f.imports.values()) {
        for (const [name, targetRoot] of workspacePackages) {
          if (targetRoot === ownerRoot) continue;
          if (imp.source === name || imp.source.startsWith(name + "/")) targets.add(targetRoot);
        }
      }
    }
    importsOf.set(ownerRoot, targets);
  }

  const importedRoots = new Set<string>();
  for (const targets of importsOf.values()) for (const t of targets) importedRoots.add(t);
  if (importedRoots.size === 0) return;

  /**
   * Every member that reaches `root` through the member graph. Only these can
   * contribute a handler whose request path ends inside `root`, so widening
   * `external` to the whole monorepo buys nothing and costs a full graph
   * traversal per member — the cost grows with member count independently of
   * tree size.
   */
  const transitiveImportersOf = (root: string): string[] => {
    const found = new Set<string>();
    const queue = [root];
    while (queue.length > 0) {
      const target = queue.shift()!;
      for (const [owner, targets] of importsOf) {
        if (!targets.has(target) || found.has(owner)) continue;
        found.add(owner);
        queue.push(owner);
      }
    }
    found.delete(root);
    return [...found].sort();
  };

  await mapPool([...importedRoots].sort(), options.projectConcurrency ?? 4, async (root) => {
    const project = projects.find((p) => p.packageRoot === root);
    const own = factsByRoot.get(root);
    if (!project || !own || own.length === 0) return;

    // Sorted, not Map order: factsByRoot is populated from a concurrency pool, so
    // its insertion order is scan-completion order — pure I/O timing. That order
    // reaches the graph, and the taint hop trail baked into a message, so leaving
    // it unsorted makes evidenceKey differ run to run and CI report a pre-existing
    // finding as newly introduced.
    const external: ModuleFacts[] = [];
    for (const otherRoot of transitiveImportersOf(root)) {
      external.push(...(factsByRoot.get(otherRoot) ?? []));
    }
    if (external.length === 0) return;

    const projectConfig = await loadConfig(root);
    const report = await scanProject({
      ...options,
      rootDirectory: root,
      config: mergeConfig(rootConfig, projectConfig),
      only: own.map((f) => f.filePath).sort(),
      workspacePackages,
      externalModuleFacts: external,
      onModuleFacts: undefined, // facts are already captured; do not re-notify the caller
      // Phase C re-runs nothing new, and a partial file list must never rewrite
      // the member's cache.
      secrets: false,
      cache: false,
    });

    // `id`, not `evidenceKey`: evidenceKey is deliberately position-independent, so
    // two byte-identical boilerplate sites in one package collide and the second is
    // silently dropped. `id` carries normalizedFilePath::line:column, which is the
    // "same site, same rule" test this pass actually wants.
    const seen = new Set(project.report.findings.map((f) => f.id));
    const fresh = report.findings.filter((f) => !seen.has(f.id));
    if (fresh.length === 0) return;

    project.report.findings = sortFindings([...project.report.findings, ...fresh]);
    project.report.score = calculateScore(project.report.findings, {
      totalLines: project.report.project.totalLines,
    });
  });
};

/**
 * Scan every workspace member (optionally filtered) and aggregate a worst-of
 * report. Each member's config layers over the workspace-root config.
 */
export const scanWorkspaces = async (rootDirectory: string, options: ScanWorkspacesOptions = {}): Promise<WorkspaceReport> => {
  const rootConfig: NodeDoctorConfig = options.config ?? (await loadConfig(rootDirectory, options.configPath));

  const allRoots = await discoverWorkspaces(rootDirectory);
  // Built from every member, not just the selected ones: --project narrows what
  // is scanned, but a selected package must still resolve its siblings by name.
  const workspacePackages = new Map<string, string>();
  for (const root of allRoots) workspacePackages.set(await readPackageName(root), root);

  let roots = allRoots;
  if (options.projectFilter && options.projectFilter.length > 0) {
    const named = await mapPool(roots, 8, async (r) => ({ r, name: await readPackageName(r) }));
    roots = named
      .filter(({ r, name }) =>
        matchesFilter(name, relative(rootDirectory, r).split(sep).join("/"), r, rootDirectory, options.projectFilter!),
      )
      .map(({ r }) => r);
  }

  // §96 — Phase A facts per member, kept for the cross-package pass below.
  const factsByRoot = new Map<string, ModuleFacts[]>();

  const projects = await mapPool(roots, options.projectConcurrency ?? 4, async (root): Promise<WorkspaceProjectReport> => {
    const projectConfig = await loadConfig(root);
    const report = await scanProject({
      ...options,
      rootDirectory: root,
      config: mergeConfig(rootConfig, projectConfig),
      workspacePackages,
      onModuleFacts: (facts) => factsByRoot.set(root, facts),
    });
    return {
      name: await readPackageName(root),
      packageRoot: root,
      normalizedRoot: relative(rootDirectory, root).split(sep).join("/") || ".",
      report,
    };
  });

  await addCrossPackageFindings(projects, workspacePackages, factsByRoot, rootConfig, options);

  // Worst-of: the lowest project score is the workspace headline.
  let worst: WorkspaceProjectReport | null = null;
  let totalFindings = 0;
  for (const p of projects) {
    totalFindings += p.report.findings.length;
    if (!worst || p.report.score.score < worst.report.score.score) worst = p;
  }
  const score: ScoreResult = worst ? worst.report.score : calculateScore([], { totalLines: 0 });

  return {
    schemaVersion: projects[0]?.report.schemaVersion ?? 2,
    multiProject: true,
    rootDirectory,
    projects,
    score,
    worstProject: worst ? worst.name : null,
    projectCount: projects.length,
    totalFindings,
  };
};

/** All findings across every member (for CI gating). */
export const workspaceFindings = (report: WorkspaceReport): ScanReport["findings"] =>
  report.projects.flatMap((p) => p.report.findings);
