/**
 * Offline SBOM (Software Bill of Materials) generation.
 *
 * Procurement and compliance reviews increasingly ask for an SBOM before a
 * service ships. Every mainstream generator produces one by talking to a
 * registry; node.doctor already has to read the dependency tree to scan a
 * project, so it can emit the same document with **zero network calls** — which
 * also means it works inside an air-gapped CI runner.
 *
 * Two things make this trustworthy rather than decorative:
 *
 * 1. **Real versions, not ranges.** `package.json` records `^4.18.2`; an SBOM
 *    that repeats the range is useless for vulnerability matching. We resolve
 *    what is actually installed from whichever lockfile is present
 *    (`package-lock.json` v2/v3, `pnpm-lock.yaml`, `yarn.lock` classic + berry)
 *    and only fall back to the declared range when the lockfile is absent or
 *    silent about that package.
 * 2. **Determinism.** Components are sorted by name and the document carries no
 *    timestamp, serial number, or machine path unless the caller injects one.
 *    Two runs on the same tree produce byte-identical bytes, so an SBOM can be
 *    committed and diffed like any other artifact.
 *
 * Nothing here throws on a corrupt lockfile: a broken lockfile degrades to
 * declared ranges rather than failing the scan.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { toolVersion } from "./version.ts";

/** SBOM document flavours node.doctor can emit. */
export type SbomFormat = "cyclonedx" | "spdx";

/** One resolved dependency of the scanned project. */
export interface SbomComponent {
  /** Package name exactly as declared (`@scope/name` keeps its scope). */
  name: string;
  /** Installed version from the lockfile, or the declared range as a fallback. */
  version: string;
  /** Package URL, e.g. `pkg:npm/%40scope/name@1.2.3`. */
  purl: string;
  /** True when the package came from `devDependencies` only. */
  dev: boolean;
}

export interface BuildSbomOptions {
  /** Document flavour. Default `"cyclonedx"`. */
  format?: SbomFormat;
  /** ISO-8601 creation time. Omitted entirely unless passed (determinism). */
  timestamp?: string;
  /** Override the tool version stamped into the metadata. */
  toolVersion?: string;
}

// ---------------------------------------------------------------------------
// Package URL
// ---------------------------------------------------------------------------

/**
 * Build an npm Package URL. Per the purl spec each segment is percent-encoded
 * — so a scope's `@` becomes `%40` — and npm names are lowercased.
 */
export const npmPurl = (name: string, version: string): string => {
  const lower = name.toLowerCase();
  const slash = lower.indexOf("/");
  const segments = slash === -1 ? [lower] : [lower.slice(0, slash), lower.slice(slash + 1)];
  const path = segments.map((s) => encodeURIComponent(s)).join("/");
  return `pkg:npm/${path}@${encodeURIComponent(version)}`;
};

// ---------------------------------------------------------------------------
// Lockfile readers
//
// Each returns a name -> installed-version map, or an empty map when the file
// is missing/unparseable. They are deliberately tolerant: a lockfile we cannot
// read costs us precision (we fall back to the declared range), never a crash.
// ---------------------------------------------------------------------------

/** pnpm/yarn record peer-disambiguated versions like `1.2.3(react@18.0.0)`. */
const cleanVersion = (raw: string): string | null => {
  const value = raw.trim().replace(/^["']|["']$/g, "");
  if (!value) return null;
  // `link:../pkg`, `file:./vendor`, `workspace:*` are not distributable versions.
  if (/^(?:link|file|workspace|portal):/.test(value)) return null;
  const stripped = value.replace(/[(_].*$/, "").trim();
  return stripped.length > 0 ? stripped : null;
};

/** Strip a quote pair and a trailing colon from a YAML/yarn key. */
const unquote = (raw: string): string => raw.trim().replace(/^["']|["']$/g, "");

/**
 * npm `package-lock.json`. v3 exposes only `packages` (keyed by install path);
 * v2 carries both `packages` and the legacy v1 `dependencies` tree, so we read
 * `packages` first and fall back to the legacy shape.
 */
const parseNpmLock = (text: string): Map<string, string> => {
  const out = new Map<string, string>();
  const lock = JSON.parse(text) as {
    packages?: Record<string, { version?: unknown }>;
    dependencies?: Record<string, { version?: unknown }>;
  };
  if (lock.packages && typeof lock.packages === "object") {
    for (const [path, entry] of Object.entries(lock.packages)) {
      // Only hoisted top-level installs: `node_modules/<name>`, never nested.
      if (!path.startsWith("node_modules/")) continue;
      const name = path.slice("node_modules/".length);
      if (name.includes("/node_modules/")) continue;
      const version = typeof entry?.version === "string" ? cleanVersion(entry.version) : null;
      if (version) out.set(name, version);
    }
  }
  if (lock.dependencies && typeof lock.dependencies === "object") {
    for (const [name, entry] of Object.entries(lock.dependencies)) {
      if (out.has(name)) continue;
      const version = typeof entry?.version === "string" ? cleanVersion(entry.version) : null;
      if (version) out.set(name, version);
    }
  }
  return out;
};

/**
 * `pnpm-lock.yaml`. An indentation-tracking mini-parser (no YAML dependency)
 * that reads the direct-dependency maps only — either the v9 `importers.<dir>`
 * blocks or the flat root-level `dependencies:` of v5/v6 — so the transitive
 * `packages:`/`snapshots:` graph never pollutes the direct set. `packages:`
 * keys are used as a last-resort fallback for names the importers missed.
 */
const parsePnpmLock = (text: string): Map<string, string> => {
  const direct = new Map<string, string>();
  const fallback = new Map<string, string>();
  const stack: { indent: number; key: string }[] = [];
  const DEP_KEYS = new Set(["dependencies", "devDependencies", "optionalDependencies"]);

  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) continue;
    const match = /^(.+?):(?:\s+(.*))?$/.exec(trimmed);
    if (!match) continue;
    const indent = raw.length - raw.trimStart().length;
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();

    const key = unquote(match[1]!);
    const value = (match[2] ?? "").trim();
    const path = [...stack.map((s) => s.key), key];

    // `packages:`/`snapshots:` keys: `express@4.18.2`, `/express/4.18.2`, `/express@4.18.2`.
    if (path.length === 2 && (path[0] === "packages" || path[0] === "snapshots")) {
      const entry = parsePnpmPackageKey(key);
      if (entry && !fallback.has(entry.name)) fallback.set(entry.name, entry.version);
    }

    // Direct deps: [dependencies, name] or [importers, <dir>, dependencies, name].
    const depIndex = path.length >= 2 && DEP_KEYS.has(path[path.length - 2]!) ? path.length - 2 : -1;
    const anchored =
      depIndex === 0 || (depIndex === 2 && path[0] === "importers");
    if (anchored && value) {
      const version = cleanVersion(value);
      if (version && !direct.has(key)) direct.set(key, version);
    }

    // Nested form: `<name>:` then `specifier:`/`version:` one level deeper.
    if (key === "version" && path.length >= 3 && DEP_KEYS.has(path[path.length - 3]!)) {
      const owner = path[path.length - 2]!;
      const nestedIndex = path.length - 3;
      if (nestedIndex === 0 || (nestedIndex === 2 && path[0] === "importers")) {
        const version = cleanVersion(value);
        if (version && !direct.has(owner)) direct.set(owner, version);
      }
    }

    if (!value) stack.push({ indent, key });
  }

  for (const [name, version] of fallback) if (!direct.has(name)) direct.set(name, version);
  return direct;
};

/** `express@4.18.2` | `/express/4.18.2` | `/@scope/name@1.2.3` -> name + version. */
const parsePnpmPackageKey = (key: string): { name: string; version: string } | null => {
  let body = key.startsWith("/") ? key.slice(1) : key;
  if (!body) return null;
  const at = body.indexOf("@", body.startsWith("@") ? 1 : 0);
  if (at > 0) {
    const version = cleanVersion(body.slice(at + 1));
    return version ? { name: body.slice(0, at), version } : null;
  }
  // v5 style `/name/version` (scoped: `/@scope/name/version`).
  const slash = body.lastIndexOf("/");
  if (slash <= 0) return null;
  const version = cleanVersion(body.slice(slash + 1));
  if (!version || !/^\d/.test(version)) return null;
  body = body.slice(0, slash);
  return body ? { name: body, version } : null;
};

/** `@types/node@npm:^20.0.0` -> `@types/node`; `express@^4` -> `express`. */
const descriptorName = (descriptor: string): string | null => {
  const value = unquote(descriptor);
  if (!value || value.startsWith("__")) return null;
  const at = value.indexOf("@", value.startsWith("@") ? 1 : 0);
  const name = at === -1 ? value : value.slice(0, at);
  const range = at === -1 ? "" : value.slice(at + 1);
  if (range.startsWith("workspace:")) return null; // the project itself
  return name || null;
};

/**
 * `yarn.lock`, both dialects. v1 classic writes `version "4.18.2"`; berry
 * (v2+) writes `version: 4.18.2`. Both share the shape "column-0 descriptor
 * list ending in `:`, then an indented block", so one scanner handles them.
 * Only the first `version` line at the block's own indent counts — a nested
 * `dependencies:` block can legitimately contain a package named `version`.
 */
const parseYarnLock = (text: string): Map<string, string> => {
  const out = new Map<string, string>();
  let names: string[] = [];
  let blockIndent = -1;
  let resolved = false;

  const flush = (): void => {
    names = [];
    blockIndent = -1;
    resolved = false;
  };

  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;

    if (indent === 0) {
      flush();
      if (!trimmed.endsWith(":")) continue;
      names = trimmed
        .slice(0, -1)
        .split(",")
        .map((d) => descriptorName(d))
        .filter((n): n is string => n !== null);
      continue;
    }

    if (names.length === 0 || resolved) continue;
    if (blockIndent === -1) blockIndent = indent;
    if (indent !== blockIndent) continue;

    const match = /^version:?[ \t]+(.+)$/.exec(trimmed);
    if (!match) continue;
    const version = cleanVersion(match[1]!);
    if (!version) continue;
    resolved = true;
    for (const name of names) if (!out.has(name)) out.set(name, version);
  }
  return out;
};

const readIfPresent = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
};

/**
 * Installed-version map for `rootDirectory`. Lockfiles are probed in the same
 * order as `detectPackageManager` (pnpm, yarn, npm) and the first one that
 * yields any resolution wins; a corrupt file is skipped, not fatal.
 */
export const resolveLockedVersions = async (rootDirectory: string): Promise<Map<string, string>> => {
  const readers: [string, (text: string) => Map<string, string>][] = [
    ["pnpm-lock.yaml", parsePnpmLock],
    ["yarn.lock", parseYarnLock],
    ["package-lock.json", parseNpmLock],
  ];
  for (const [file, parse] of readers) {
    const text = await readIfPresent(join(rootDirectory, file));
    if (text === null) continue;
    try {
      const map = parse(text);
      if (map.size > 0) return map;
    } catch {
      /* malformed lockfile — fall through to the next candidate */
    }
  }
  return new Map();
};

// ---------------------------------------------------------------------------
// Component collection
// ---------------------------------------------------------------------------

interface RootManifest {
  name: string;
  version: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

const readManifest = async (rootDirectory: string): Promise<RootManifest> => {
  const empty: RootManifest = { name: "project", version: "0.0.0", dependencies: {}, devDependencies: {} };
  const text = await readIfPresent(join(rootDirectory, "package.json"));
  if (text === null) return empty;
  try {
    const pkg = JSON.parse(text) as Partial<RootManifest> | null;
    if (!pkg || typeof pkg !== "object") return empty;
    const asRecord = (value: unknown): Record<string, string> => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    };
    return {
      name: typeof pkg.name === "string" && pkg.name ? pkg.name : empty.name,
      version: typeof pkg.version === "string" && pkg.version ? pkg.version : empty.version,
      dependencies: asRecord(pkg.dependencies),
      devDependencies: asRecord(pkg.devDependencies),
    };
  } catch {
    return empty;
  }
};

/**
 * Direct dependencies of the project at `rootDirectory`, sorted by name, with
 * versions resolved from the lockfile where possible. A package declared in
 * both `dependencies` and `devDependencies` is reported once, as production —
 * it ships, so it belongs in the shipped inventory.
 */
export const collectComponents = async (rootDirectory: string): Promise<SbomComponent[]> => {
  const manifest = await readManifest(rootDirectory);
  const declared = new Map<string, boolean>(); // name -> dev
  for (const name of Object.keys(manifest.devDependencies)) declared.set(name, true);
  for (const name of Object.keys(manifest.dependencies)) declared.set(name, false);
  if (declared.size === 0) return [];

  const locked = await resolveLockedVersions(rootDirectory);

  const components: SbomComponent[] = [];
  for (const [name, dev] of declared) {
    const range = dev ? manifest.devDependencies[name] : manifest.dependencies[name];
    const version = locked.get(name) ?? range ?? "unknown";
    components.push({ name, version, purl: npmPurl(name, version), dev });
  }
  components.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return components;
};

// ---------------------------------------------------------------------------
// Document builders
// ---------------------------------------------------------------------------

const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;

/** npm's deterministic tarball layout; `NOASSERTION` when we only have a range. */
const downloadLocation = (name: string, version: string): string => {
  if (!EXACT_SEMVER.test(version)) return "NOASSERTION";
  const bare = name.slice(name.indexOf("/") + 1);
  return `https://registry.npmjs.org/${name}/-/${bare}-${version}.tgz`;
};

/** SPDX element ids are restricted to `[a-zA-Z0-9.-]`; keep them unique. */
const spdxId = (component: SbomComponent, taken: Set<string>): string => {
  const slug = `${component.name}-${component.version}`.replace(/[^a-zA-Z0-9.-]/g, "-");
  let id = `SPDXRef-Package-${slug}`;
  let n = 1;
  while (taken.has(id)) id = `SPDXRef-Package-${slug}-${n++}`;
  taken.add(id);
  return id;
};

const buildCycloneDx = (
  manifest: RootManifest,
  components: SbomComponent[],
  version: string,
  timestamp: string | undefined,
): unknown => ({
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  metadata: {
    ...(timestamp ? { timestamp } : {}),
    tools: [{ vendor: "node.doctor", name: "node-doctor", version }],
    component: {
      "bom-ref": npmPurl(manifest.name, manifest.version),
      type: "application",
      name: manifest.name,
      version: manifest.version,
      purl: npmPurl(manifest.name, manifest.version),
    },
  },
  components: components.map((c) => ({
    "bom-ref": c.purl,
    type: "library",
    name: c.name,
    version: c.version,
    // CycloneDX marks build-only dependencies as excluded from the deliverable.
    scope: c.dev ? "excluded" : "required",
    purl: c.purl,
  })),
});

const buildSpdx = (
  manifest: RootManifest,
  components: SbomComponent[],
  version: string,
  timestamp: string | undefined,
): unknown => {
  const taken = new Set<string>();
  const packages = components.map((c) => {
    const id = spdxId(c, taken);
    return {
      SPDXID: id,
      name: c.name,
      versionInfo: c.version,
      downloadLocation: downloadLocation(c.name, c.version),
      filesAnalyzed: false,
      licenseConcluded: "NOASSERTION",
      licenseDeclared: "NOASSERTION",
      copyrightText: "NOASSERTION",
      externalRefs: [
        {
          referenceCategory: "PACKAGE-MANAGER",
          referenceType: "purl",
          referenceLocator: c.purl,
        },
      ],
    };
  });
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `${manifest.name}-${manifest.version}`,
    documentNamespace: `https://spdx.org/spdxdocs/${encodeURIComponent(manifest.name)}-${encodeURIComponent(manifest.version)}`,
    creationInfo: {
      // `created` is omitted unless injected: a timestamp would break byte
      // determinism, which matters more here than strict schema completeness.
      ...(timestamp ? { created: timestamp } : {}),
      creators: [`Tool: node-doctor-${version}`],
    },
    packages,
    relationships: packages.map((p) => ({
      spdxElementId: "SPDXRef-DOCUMENT",
      relationshipType: "DESCRIBES",
      relatedSpdxElement: p.SPDXID,
    })),
  };
};

/**
 * Render the project's SBOM as a pretty-printed JSON string. Byte-identical
 * across runs for an unchanged tree unless `timestamp` is supplied.
 */
export const buildSbom = async (rootDirectory: string, options: BuildSbomOptions = {}): Promise<string> => {
  const manifest = await readManifest(rootDirectory);
  const components = await collectComponents(rootDirectory);
  const version = options.toolVersion ?? toolVersion();
  const document =
    options.format === "spdx"
      ? buildSpdx(manifest, components, version, options.timestamp)
      : buildCycloneDx(manifest, components, version, options.timestamp);
  return JSON.stringify(document, null, 2) + "\n";
};
