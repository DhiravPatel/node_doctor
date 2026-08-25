/**
 * Project discovery, capability detection, and diagnostic gating.
 *
 * Capabilities are the vocabulary that decides which diagnostics run. They are derived
 * cheaply from `package.json` (one manifest read — no lockfile parse, no install
 * tree walk) plus the presence of a `tsconfig.json`. Version ranges are inspected
 * so an Express `^5` dependency adds `express:5` and retires the Express-4 diagnostics.
 */

import { readFile, access } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import fg from "fast-glob";
import type { Diagnostic } from "./types.ts";

export interface PackageManifest {
  name?: string;
  type?: string;
  engines?: { node?: string };
  workspaces?: string[] | { packages?: string[] };
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

/**
 * Every capability token this module can ever grant.
 *
 * A gate naming a token that is not in here can never be satisfied, and a rule
 * behind such a gate is not "quiet" — it is DEAD, on every project and every
 * machine, indistinguishable in the report from a clean result.
 *
 * That is not hypothetical. `no-missing-websocket-error-handler` shipped with
 * `requires: ["ws"]` while `DEP_TOKENS` had no `ws` entry, so it could never run,
 * and the test suite stayed green throughout because the tests pass capabilities
 * straight to `lintSource` and bypass gating. This set exists so a test can
 * assert the invariant directly — see `tests/engine/capabilities.test.ts`.
 *
 * Keep it in step with the `caps.add(...)` calls below; the test is what makes
 * that obligation real rather than a comment.
 */
export const GRANTABLE_CAPABILITIES: ReadonlySet<string> = new Set<string>([
  ...Object.values(DEP_TOKENS),
  "node",
  "esm",
  "cjs",
  "typescript",
  "express:5",
  "bun",
  "deno",
  "edge",
  "tz:utc",
  "tz:non-utc",
]);

/** `node:<major>` is granted from `engines.node`, so it is matched by shape. */
export const isGrantableCapability = (token: string): boolean =>
  GRANTABLE_CAPABILITIES.has(token) || /^node:\d+$/.test(token);

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
/** Workspace globs declared by a manifest, plus pnpm's separate file. */
const workspaceGlobs = async (rootDirectory: string, pkg: PackageManifest | null): Promise<string[]> => {
  const declared = pkg?.workspaces;
  const globs = Array.isArray(declared) ? [...declared] : [...(declared?.packages ?? [])];
  try {
    const yaml = await readFile(join(rootDirectory, "pnpm-workspace.yaml"), "utf8");
    let inPackages = false;
    for (const raw of yaml.split("\n")) {
      const line = raw.replace(/#.*$/, "");
      if (/^packages\s*:/.test(line)) {
        inPackages = true;
        continue;
      }
      if (!inPackages) continue;
      const item = /^\s*-\s*(.+?)\s*$/.exec(line);
      if (item) globs.push(item[1]!.replace(/^["']|["']$/g, ""));
      else if (/^\S/.test(line)) inPackages = false;
    }
  } catch {
    /* no pnpm workspace file */
  }
  return globs;
};

/**
 * Dependencies declared by WORKSPACE MEMBERS, unioned in for capability detection.
 *
 * Without this, capability gating is wrong in exactly the repos where it matters
 * most. In a monorepo the database client is usually declared by one member and
 * re-exported to the rest: cal.com declares `@prisma/client` only in
 * `packages/prisma/package.json`, and every consumer imports `@calcom/prisma`.
 * The root manifest's only prisma-ish entry is `@prisma/internals`, which is not
 * a client. So a manifest-only reading of that repo yields **no `prisma`
 * capability at any level** — root, `packages/features`, `packages/trpc` and
 * `apps/web` all report NO — and every Prisma-gated diagnostic silently never
 * runs on one of the largest open-source Prisma codebases there is. That is
 * indistinguishable, in the report, from a clean result.
 *
 * Members' own manifests are read but not recursed into, and the count is
 * bounded: capability detection is meant to be cheap, and a token that needs
 * more evidence than this should be found another way.
 */
const MAX_WORKSPACE_MANIFESTS = 400;

/**
 * How far up to look for the workspace root.
 *
 * Scanning a member directly (`node-doctor scan packages/features`) is the
 * common case in CI, and that directory declares no `workspaces` of its own — so
 * without climbing, the member sees only its own manifest and the whole problem
 * above returns. Bounded, because an unbounded climb would read manifests
 * outside the project entirely.
 */
const WORKSPACE_ROOT_SEARCH_DEPTH = 6;

/** The nearest ancestor (or self) that declares workspaces, with its manifest. */
const enclosingWorkspaceRoot = async (
  rootDirectory: string,
): Promise<{ directory: string; globs: string[] } | null> => {
  let directory = rootDirectory;
  for (let depth = 0; depth <= WORKSPACE_ROOT_SEARCH_DEPTH; depth++) {
    const manifest = await readManifest(directory);
    const globs = await workspaceGlobs(directory, manifest);
    if (globs.length > 0) return { directory, globs };
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
};

const workspaceDependencies = async (
  rootDirectory: string,
  _pkg: PackageManifest | null,
): Promise<Record<string, string>> => {
  const found = await enclosingWorkspaceRoot(rootDirectory);
  if (!found) return {};
  const { directory: rootDir, globs } = found;
  rootDirectory = rootDir;
  if (globs.length === 0) return {};

  let manifests: string[];
  try {
    manifests = await fg(
      globs.map((glob) => `${glob.replace(/\/+$/, "")}/package.json`),
      {
        cwd: rootDirectory,
        absolute: true,
        onlyFiles: true,
        ignore: ["**/node_modules/**"],
        suppressErrors: true,
      },
    );
  } catch {
    return {};
  }

  const merged: Record<string, string> = {};
  for (const path of manifests.slice(0, MAX_WORKSPACE_MANIFESTS)) {
    let member: PackageManifest | null = null;
    try {
      member = JSON.parse(await readFile(path, "utf8")) as PackageManifest;
    } catch {
      continue;
    }
    for (const [name, range] of Object.entries(allDependencies(member))) {
      // First declaration wins; the root's own entries override all of these.
      if (!(name in merged)) merged[name] = range;
    }
  }
  return merged;
};

/**
 * The deployment timezone a project DECLARES, when it declares one.
 *
 * Some defects only exist away from UTC. A `Date` built from local wall-clock
 * components and rendered with `toISOString()` is wrong east of Greenwich and
 * exactly right on a UTC host — so a rule about it must not fire on a project
 * that pins `TZ=UTC`, or it reports correct code. Both halves are real in the
 * corpus: `finance_backend/.env` line 1 is `TZ=UTC`, while
 * `crm_backend/Dockerfile:22` and `pg_petpooja/Dockerfile:51` both set
 * `ENV TZ=Asia/Kolkata`.
 *
 * Only an explicit declaration counts. No declaration means unknown, and unknown
 * grants no token — so a rule requiring `tz:non-utc` stays silent rather than
 * guessing which hemisphere the host is in.
 */
const TZ_SOURCES = [".env", ".env.production", ".env.local", "Dockerfile", "docker-compose.yml", "docker-compose.yaml"];
/** `TZ=Asia/Kolkata`, `ENV TZ=UTC`, `ENV TZ Asia/Kolkata`, `- TZ=UTC`. */
const TZ_DECLARATION_RE = /(?:^|\n)\s*(?:-\s*)?(?:ENV\s+)?TZ[=\s]+["']?([A-Za-z][\w+\-/]*)["']?/;
/** Zone names that ARE UTC, so the offset is zero and the defect cannot occur. */
const UTC_ZONE_RE = /^(UTC|GMT|Etc\/UTC|Etc\/GMT|Etc\/Greenwich|Universal|Zulu|Z)$/i;

const declaredTimezone = async (rootDirectory: string): Promise<"utc" | "non-utc" | null> => {
  let seen: "utc" | "non-utc" | null = null;
  for (const file of TZ_SOURCES) {
    let content: string;
    try {
      content = await readFile(join(rootDirectory, file), "utf8");
    } catch {
      continue;
    }
    const match = TZ_DECLARATION_RE.exec(content);
    const zone = match?.[1];
    if (zone === undefined) continue;
    const kind = UTC_ZONE_RE.test(zone) ? ("utc" as const) : ("non-utc" as const);
    // Sources that DISAGREE prove nothing. Both of the corpus projects that pin
    // `ENV TZ=Asia/Kolkata` in their Dockerfile also ship a `.env` saying
    // `TZ=UTC`, and which one wins at runtime depends on whether the dotenv
    // loader runs before the first `Date` is constructed — not something this
    // file can settle. Conflict resolves to unknown, and unknown grants nothing.
    if (seen !== null && seen !== kind) return null;
    seen = kind;
  }
  return seen;
};

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
  // A monorepo's client libraries are declared by members, not by the root — see
  // `workspaceDependencies`. The root's own entries take precedence, so a version
  // pinned at the root still decides tokens like `express:5`.
  const memberDeps = await workspaceDependencies(rootDirectory, pkg);
  const effective: PackageManifest | null =
    Object.keys(memberDeps).length === 0
      ? pkg
      : { ...(pkg ?? {}), dependencies: { ...memberDeps, ...(pkg?.dependencies ?? {}) } };

  const capabilities = detectCapabilities(effective, {
    hasTsconfig,
    bun: bunLock || bunfig,
    deno: denoJson || denoJsonc,
    edge: wrangler,
  });

  // Only an explicit declaration grants a timezone token; silence on unknown.
  const timezone = await declaredTimezone(rootDirectory);
  if (timezone !== null) capabilities.add(timezone === "utc" ? "tz:utc" : "tz:non-utc");
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
  if (diagnostic.requiresAny && diagnostic.requiresAny.length > 0) {
    if (!diagnostic.requiresAny.some((token) => capabilities.has(token))) return false;
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
  // `requiresAny` is the FAMILY gate: at least one of these must be present.
  // Some defects are shared by several frameworks that spell them the same way —
  // a guard that responds without returning is the same bug, and the same fix, on
  // Express and Fastify — and `requires` (which is ALL) cannot express that. The
  // alternative was dropping the gate entirely and relying on the structural
  // check, which would have let the rule run on projects with no HTTP framework
  // at all. An empty array is treated as no constraint rather than as
  // unsatisfiable, so a mistaken `requiresAny: []` cannot silently kill a rule.
  if (diagnostic.requiresAny && diagnostic.requiresAny.length > 0) {
    if (!diagnostic.requiresAny.some((token) => capabilities.has(token))) return false;
  }
  if (diagnostic.disabledWhen) {
    for (const token of diagnostic.disabledWhen) if (capabilities.has(token)) return false;
  }
  return true;
};
