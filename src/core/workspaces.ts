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
import { scanProject, type ScanReport, type ScanProjectOptions } from "./scan.ts";
import { loadConfig, mergeConfig, type NodeDoctorConfig } from "./config.ts";
import { calculateScore, type ScoreResult } from "./score.ts";
import { mapPool } from "./pool.ts";

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
 * Scan every workspace member (optionally filtered) and aggregate a worst-of
 * report. Each member's config layers over the workspace-root config.
 */
export const scanWorkspaces = async (rootDirectory: string, options: ScanWorkspacesOptions = {}): Promise<WorkspaceReport> => {
  const rootConfig: NodeDoctorConfig = options.config ?? (await loadConfig(rootDirectory, options.configPath));

  let roots = await discoverWorkspaces(rootDirectory);
  if (options.projectFilter && options.projectFilter.length > 0) {
    const named = await mapPool(roots, 8, async (r) => ({ r, name: await readPackageName(r) }));
    roots = named
      .filter(({ r, name }) =>
        matchesFilter(name, relative(rootDirectory, r).split(sep).join("/"), r, rootDirectory, options.projectFilter!),
      )
      .map(({ r }) => r);
  }

  const projects = await mapPool(roots, options.projectConcurrency ?? 4, async (root): Promise<WorkspaceProjectReport> => {
    const projectConfig = await loadConfig(root);
    const report = await scanProject({
      ...options,
      rootDirectory: root,
      config: mergeConfig(rootConfig, projectConfig),
    });
    return {
      name: await readPackageName(root),
      packageRoot: root,
      normalizedRoot: relative(rootDirectory, root).split(sep).join("/") || ".",
      report,
    };
  });

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
