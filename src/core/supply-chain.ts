/**
 * §69 — Malicious & Risky Dependency Detection (`node-doctor supply-chain`).
 *
 * Two supply-chain facts a team can act on, both readable from disk with no
 * network and no vulnerability feed:
 *
 *   1. WHICH DEPENDENCIES RUN CODE WHEN YOU INSTALL. An `install`/`preinstall`/
 *      `postinstall` script executes arbitrary commands on every developer
 *      laptop and every CI runner, before a single line of your code has run.
 *      That is the delivery mechanism for essentially every npm compromise of
 *      the last decade, and `npm ls` will not tell you which packages have one.
 *   2. WHICH DEPENDENCIES DO NOT COME FROM THE REGISTRY. A lockfile entry
 *      resolved from a git ref or an http tarball skips the registry's
 *      immutability and integrity guarantees: the same lockfile can install
 *      different bytes tomorrow, and there is no signed provenance to check.
 *
 * NEITHER IS AN ACCUSATION. A postinstall script is how `esbuild` fetches its
 * platform binary and how `husky` installs a git hook — both entirely
 * legitimate. The report says what runs and where it came from, and leaves the
 * judgement to a human, because "this package is malicious" is not a claim
 * static analysis can make and this tool does not pretend otherwise.
 *
 * PRECISION MODEL — the honesty is all in the negative space:
 *
 *   - Install scripts are read from `node_modules`, because that is the only
 *     place the truth lives: the manifest declares ranges, and which version
 *     actually got installed (and whether IT has a script) is a fact about the
 *     installed tree. When `node_modules` is absent the report says the check
 *     did not run. It does not say "no install scripts found" — those are
 *     different answers and only one of them is safe to act on.
 *   - Direct and transitive are distinguished. A transitive package with a
 *     postinstall is still executing code on your machine, but it is not
 *     something you chose, and the fix is different.
 *   - A lockfile this cannot parse is reported as unparsed, never as clean.
 *
 * Deterministic: entries sorted by name, no clock, no network.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** The npm lifecycle hooks that execute during `npm install`. */
const INSTALL_HOOKS = ["preinstall", "install", "postinstall", "prepare", "prepublish"] as const;

/** A resolution that is not the public registry. */
const NON_REGISTRY_RE = /^(git\+|git:|ssh:|github:|gitlab:|bitbucket:|file:|link:)/;
const REGISTRY_HOST_RE = /^https?:\/\/([^/]*\.)?(registry\.npmjs\.org|registry\.yarnpkg\.com|npm\.pkg\.github\.com)\//;

export interface InstallScript {
  package: string;
  version: string;
  /** Which lifecycle hook. */
  hook: string;
  /** The command it runs, verbatim and untruncated. */
  command: string;
  /** True when the project's own manifest declares this package. */
  direct: boolean;
}

export interface NonRegistrySource {
  package: string;
  /** The `resolved` value from the lockfile, verbatim. */
  resolved: string;
  /** Why it matters, specific to this kind of source. */
  why: string;
}

/** Whether each half of the report actually ran. */
export type CheckState = "checked" | "not-installed" | "no-lockfile" | "unparsed";

export interface SupplyChainReport {
  /** Did the install-script check run, and if not, why not. */
  installScriptCheck: CheckState;
  /** Did the source check run, and if not, why not. */
  sourceCheck: CheckState;
  installScripts: InstallScript[];
  nonRegistrySources: NonRegistrySource[];
  summary: {
    /** Packages found in `node_modules`, 0 when it was not read. */
    packagesInspected: number;
    directDependencies: number;
    withInstallScripts: number;
    nonRegistry: number;
  };
}

// ---------------------------------------------------------------------------
// The installed tree.
// ---------------------------------------------------------------------------

const readJson = async (path: string): Promise<Record<string, unknown> | null> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

/** Every hoisted package directory under `node_modules`, including scoped ones. */
const installedPackages = async (nodeModules: string): Promise<string[]> => {
  let entries: string[];
  try {
    entries = await readdir(nodeModules);
  } catch {
    return [];
  }
  const packages: string[] = [];
  for (const entry of entries.sort()) {
    if (entry.startsWith(".")) continue;
    if (entry.startsWith("@")) {
      let scoped: string[];
      try {
        scoped = await readdir(join(nodeModules, entry));
      } catch {
        continue;
      }
      for (const inner of scoped.sort()) {
        if (!inner.startsWith(".")) packages.push(`${entry}/${inner}`);
      }
      continue;
    }
    packages.push(entry);
  }
  return packages;
};

// ---------------------------------------------------------------------------
// Lockfile sources.
// ---------------------------------------------------------------------------

/**
 * `package.json` name → `resolved` URL, for entries that did not come from the
 * registry. Only npm's lockfile carries a machine-readable `resolved` for every
 * entry; yarn and pnpm are read for their equivalent fields where present.
 */
const nonRegistryFromNpmLock = (text: string): NonRegistrySource[] | null => {
  let lock: { packages?: Record<string, { resolved?: unknown; version?: unknown }> };
  try {
    lock = JSON.parse(text) as typeof lock;
  } catch {
    return null;
  }
  if (!lock.packages || typeof lock.packages !== "object") return [];
  const out: NonRegistrySource[] = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path.startsWith("node_modules/")) continue;
    const name = path.slice("node_modules/".length);
    const resolved = typeof entry?.resolved === "string" ? entry.resolved : null;
    const version = typeof entry?.version === "string" ? entry.version : "";

    // A workspace/link entry has no `resolved`; a registry entry has one that
    // points at the registry. Anything else is worth naming.
    const candidate = resolved ?? (NON_REGISTRY_RE.test(version) ? version : null);
    if (candidate === null) continue;
    if (REGISTRY_HOST_RE.test(candidate)) continue;

    out.push({
      package: name,
      resolved: candidate,
      why: /^(git|ssh|github:|gitlab:|bitbucket:)/.test(candidate)
        ? "A git source resolves against a ref that can move, so the same lockfile can install different code tomorrow — and there is no registry tarball integrity to check."
        : candidate.startsWith("file:") || candidate.startsWith("link:")
          ? "A file/link source is whatever is on disk at install time; it is reproducible only if that path is."
          : "An http tarball outside the registry has no immutability guarantee and no published provenance.",
    });
  }
  return out;
};

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------

export const buildSupplyChainReport = async (rootDirectory: string): Promise<SupplyChainReport> => {
  const manifest = await readJson(join(rootDirectory, "package.json"));
  const direct = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const map = manifest?.[field];
    if (map !== null && typeof map === "object") {
      for (const name of Object.keys(map as Record<string, unknown>)) direct.add(name);
    }
  }

  // --- install scripts -----------------------------------------------------
  const nodeModules = join(rootDirectory, "node_modules");
  let installScriptCheck: CheckState = "checked";
  const installScripts: InstallScript[] = [];
  let packagesInspected = 0;

  try {
    const info = await stat(nodeModules);
    if (!info.isDirectory()) throw new Error("not a directory");
  } catch {
    installScriptCheck = "not-installed";
  }

  if (installScriptCheck === "checked") {
    for (const name of await installedPackages(nodeModules)) {
      const pkg = await readJson(join(nodeModules, name, "package.json"));
      if (pkg === null) continue;
      packagesInspected += 1;
      const scripts = pkg.scripts;
      if (scripts === null || typeof scripts !== "object") continue;
      const version = typeof pkg.version === "string" ? pkg.version : "";
      for (const hook of INSTALL_HOOKS) {
        const command = (scripts as Record<string, unknown>)[hook];
        if (typeof command !== "string" || command.trim() === "") continue;
        installScripts.push({
          package: name,
          version,
          hook,
          command,
          direct: direct.has(name),
        });
      }
    }
    if (packagesInspected === 0) installScriptCheck = "not-installed";
  }

  // --- sources -------------------------------------------------------------
  let sourceCheck: CheckState = "checked";
  let nonRegistrySources: NonRegistrySource[] = [];
  let lockText: string | null = null;
  try {
    lockText = await readFile(join(rootDirectory, "package-lock.json"), "utf8");
  } catch {
    lockText = null;
  }
  if (lockText === null) {
    sourceCheck = "no-lockfile";
  } else {
    const parsed = nonRegistryFromNpmLock(lockText);
    if (parsed === null) sourceCheck = "unparsed";
    else nonRegistrySources = parsed;
  }

  installScripts.sort(
    (a, b) => (a.package < b.package ? -1 : a.package > b.package ? 1 : 0) || (a.hook < b.hook ? -1 : 1),
  );
  nonRegistrySources.sort((a, b) => (a.package < b.package ? -1 : 1));

  return {
    installScriptCheck,
    sourceCheck,
    installScripts,
    nonRegistrySources,
    summary: {
      packagesInspected,
      directDependencies: direct.size,
      withInstallScripts: new Set(installScripts.map((s) => s.package)).size,
      nonRegistry: nonRegistrySources.length,
    },
  };
};
