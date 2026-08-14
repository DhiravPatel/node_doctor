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
  // §2 — the remaining server frameworks. Detection alone is useful before any
  // framework-specific diagnostic exists: it drives `detected:` in the report,
  // route extraction, and the capability gates that keep rules off the wrong stack.
  "@hapi/hapi": "hapi",
  hapi: "hapi",
  restify: "restify",
  sails: "sails",
  "@feathersjs/feathers": "feathers",
  "@loopback/core": "loopback",
  next: "next",
  "@remix-run/server-runtime": "remix",
  "@remix-run/node": "remix",
  "serverless-http": "serverless",
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
  // AI-feature security (§105–§109). The `ai` token gates the whole pack, so the
  // rules are completely silent on a project that never calls a model. `mcp` is a
  // narrower token for servers that expose tools to a model — a strictly higher
  // blast radius, since the model, not a person, drives the tool call.
  openai: "ai",
  "@anthropic-ai/sdk": "ai",
  "@google/generative-ai": "ai",
  "@google/genai": "ai",
  "cohere-ai": "ai",
  "@mistralai/mistralai": "ai",
  "groq-sdk": "ai",
  replicate: "ai",
  ollama: "ai",
  ai: "ai", // Vercel AI SDK
  langchain: "ai",
  "@langchain/core": "ai",
  llamaindex: "ai",
  "@modelcontextprotocol/sdk": "mcp",
  // Ambient/implicit transactions. These packages open a transaction in
  // AsyncLocalStorage or via a decorator, so a write can be inside one with no
  // evidence at the call site at all. Any rule that reasons about transactions
  // lexically is unsound on such a project and must disable itself — see
  // `no-untransacted-dependent-writes`.
  "cls-hooked": "ambient-transaction",
  "typeorm-transactional": "ambient-transaction",
  "typeorm-transactional-cls-hooked": "ambient-transaction",
  "nestjs-cls": "ambient-transaction",
  "@nestjs-cls/transactional": "ambient-transaction",
  "@nestjs/cls": "ambient-transaction",
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
export interface RuntimeMarkers {
  /** bun.lockb / bunfig.toml present. */
  bun?: boolean;
  /** deno.json(c) present. */
  deno?: boolean;
  /** wrangler.toml, vercel edge config, or an `edge` runtime export. */
  edge?: boolean;
}

export const detectCapabilities = (
  pkg: PackageManifest | null,
  opts: { hasTsconfig?: boolean } & RuntimeMarkers = {},
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

  // An MCP server is an AI surface — the model drives its tools — so it gets the
  // general AI-security rules too, on top of the MCP-specific one.
  if (caps.has("mcp")) caps.add("ai");

  const nodeMajor = majorVersion(manifest.engines?.node);
  if (nodeMajor !== null) caps.add(`node:${nodeMajor}`);

  // Runtime detection (§94, §95). These are additive: a project can target Node
  // and deploy some routes to the edge, and both rule sets should apply.
  if (opts.bun || "bun-types" in deps || "@types/bun" in deps) caps.add("bun");
  if (opts.deno) caps.add("deno");
  // Deliberately NOT keyed on devDependencies: `wrangler` is a CLI and
  // `@cloudflare/workers-types` is a types-only package, so both sit in the
  // devDependencies of repos whose runtime is plain Node. Claiming "edge" from
  // one of those turns every `node:fs` in a normal Express server into an error.
  // A deploy manifest (wrangler.toml) or a runtime dependency is required.
  const runtimeDeps = manifest.dependencies ?? {};
  if (opts.edge || "@vercel/edge" in runtimeDeps || "@cloudflare/workers-types" in runtimeDeps) {
    caps.add("edge");
  }

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
  const [hasTsconfig, bunLock, bunfig, denoJson, denoJsonc, wrangler] = await Promise.all([
    exists(join(rootDirectory, "tsconfig.json")),
    exists(join(rootDirectory, "bun.lockb")),
    exists(join(rootDirectory, "bunfig.toml")),
    exists(join(rootDirectory, "deno.json")),
    exists(join(rootDirectory, "deno.jsonc")),
    exists(join(rootDirectory, "wrangler.toml")),
  ]);
  const capabilities = detectCapabilities(pkg, {
    hasTsconfig,
    bun: bunLock || bunfig,
    deno: denoJson || denoJsonc,
    edge: wrangler,
  });
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
