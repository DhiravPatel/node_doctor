/**
 * Project discovery, capability detection, and diagnostic gating.
 *
 * Capabilities are the vocabulary that decides which diagnostics run. They are derived
 * cheaply from `package.json` (one manifest read — no lockfile parse, no install
 * tree walk) plus the presence of a `tsconfig.json`. Version ranges are inspected
 * so an Express `^5` dependency adds `express:5` and retires the Express-4 diagnostics.
 */

import { readFile, access } from "node:fs/promises";
import { join, basename } from "node:path";
import type { Diagnostic } from "./types.ts";

export interface PackageManifest {
  name?: string;
  type?: string;
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export interface ProjectInfo {
  name: string;
  rootDirectory: string;
  capabilities: Set<string>;
}

/** dependency name → capability token (version-independent). */
const DEP_TOKENS: Record<string, string> = {
  express: "express",
  fastify: "fastify",
  hono: "hono",
  koa: "koa",
  "@nestjs/core": "nest",
  "@adonisjs/core": "adonis",
  "@prisma/client": "prisma",
  prisma: "prisma",
  "drizzle-orm": "drizzle",
  knex: "knex",
  mongoose: "mongoose",
  typeorm: "typeorm",
  sequelize: "sequelize",
  jsonwebtoken: "jsonwebtoken",
  jose: "jose",
  typescript: "typescript",
};

/** Extract the leading major version from a semver range (`^5.0.0` → 5). */
export const majorVersion = (range: string | undefined): number | null => {
  if (typeof range !== "string") return null;
  const match = range.match(/(\d+)/);
  return match ? Number.parseInt(match[1]!, 10) : null;
};

const allDependencies = (pkg: PackageManifest): Record<string, string> => ({
  ...pkg.dependencies,
  ...pkg.devDependencies,
  ...pkg.peerDependencies,
  ...pkg.optionalDependencies,
});

/**
 * Pure capability detection — testable without touching the filesystem.
 */
export const detectCapabilities = (
  pkg: PackageManifest | null,
  opts: { hasTsconfig?: boolean } = {},
): Set<string> => {
  const caps = new Set<string>(["node"]);
  const manifest = pkg ?? {};

  caps.add(manifest.type === "module" ? "esm" : "cjs");

  const deps = allDependencies(manifest);

  for (const [dep, version] of Object.entries(deps)) {
    const token = DEP_TOKENS[dep];
    if (token) caps.add(token);
    if (dep === "express") {
      const major = majorVersion(version);
      if (major !== null && major >= 5) caps.add("express:5");
    }
  }

  if ("typescript" in deps || opts.hasTsconfig) caps.add("typescript");

  const nodeMajor = majorVersion(manifest.engines?.node);
  if (nodeMajor !== null) caps.add(`node:${nodeMajor}`);

  return caps;
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const readManifest = async (rootDirectory: string): Promise<PackageManifest | null> => {
  try {
    const raw = await readFile(join(rootDirectory, "package.json"), "utf8");
    return JSON.parse(raw) as PackageManifest;
  } catch {
    return null;
  }
};

/** Discover a project's name and capabilities from disk. */
export const discoverProject = async (rootDirectory: string): Promise<ProjectInfo> => {
  const pkg = await readManifest(rootDirectory);
  const hasTsconfig = await exists(join(rootDirectory, "tsconfig.json"));
  const capabilities = detectCapabilities(pkg, { hasTsconfig });
  const name = (pkg?.name && pkg.name.trim()) || basename(rootDirectory) || "project";
  return { name, rootDirectory, capabilities };
};

/**
 * Should a diagnostic run against a project with these capabilities?
 *  - every `requires` token must be present;
 *  - no `disabledWhen` token may be present;
 *  - opt-in diagnostics (`defaultEnabled: false`) stay off unless explicitly enabled
 *    by config (handled in the scan layer).
 */
export const shouldEnableDiagnostic = (diagnostic: Diagnostic, capabilities: Set<string>): boolean => {
  if (diagnostic.defaultEnabled === false) return false;
  if (diagnostic.requires) {
    for (const token of diagnostic.requires) {
      if (!capabilities.has(token)) return false;
    }
  }
  if (diagnostic.disabledWhen) {
    for (const token of diagnostic.disabledWhen) {
      if (capabilities.has(token)) return false;
    }
  }
  return true;
};

/** Capability check ignoring opt-in status (used by config force-enable). */
export const capabilitiesSatisfied = (diagnostic: Diagnostic, capabilities: Set<string>): boolean => {
  if (diagnostic.requires) {
    for (const token of diagnostic.requires) if (!capabilities.has(token)) return false;
  }
  if (diagnostic.disabledWhen) {
    for (const token of diagnostic.disabledWhen) if (capabilities.has(token)) return false;
  }
  return true;
};
