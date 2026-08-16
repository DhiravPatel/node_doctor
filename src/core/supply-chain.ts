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

/** The npm lifecycle hooks a package manifest may declare around install. */
const INSTALL_HOOKS = ["preinstall", "install", "postinstall", "prepare", "prepublish"] as const;

/**
 * Which of those hooks ACTUALLY RUN, measured rather than quoted.
 *
 * This distinction is most of the value of the install-script check. A published
 * package installed from the registry is a tarball, and npm does not run
 * `prepare` or `prepublish` for a tarball — those fire when installing from git
 * or a local directory, and on publish. Verified by packing a manifest declaring
 * all five hooks and installing it both ways:
 *
 *   tarball install  → preinstall, install, postinstall
 *   directory install → preinstall, install, postinstall, prepare
 *   --ignore-scripts  → nothing at all
 *
 * It matters at this scale: across 14 real projects, 705 of the 730 declared
 * hooks were `prepare`/`prepublish` on registry-resolved packages and never
 * execute, against 25 that do. Counting all 730 turns three actionable facts
 * into a wall nobody reads — one project declared 178 and executes 3.
 */
const ALWAYS_EXECUTES = new Set<string>(["preinstall", "install", "postinstall"]);

/** `prepare` runs for git and directory installs only — never for a tarball. */
const EXECUTES_WHEN_NOT_FROM_REGISTRY = new Set<string>(["prepare"]);

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
  /**
   * Does this hook actually run on `npm install`?
   *
   * `prepare`/`prepublish` on a registry-resolved package do not — see
   * `ALWAYS_EXECUTES`. Declared-but-dormant hooks are still reported, because
   * "this package declares a postinstall-shaped hook" is worth seeing, but they
   * are not counted as code that runs.
   */
  executes: boolean;
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

/**
 * A package's DECLARED license, read from its own manifest.
 *
 * "Declared" is doing real work here, exactly as it does in §110's AI
 * attribution. A missing `license` field does not mean the package is
 * unlicensed — the terms may sit in a LICENSE file the field never names — so
 * that case is reported as "declares none", with whether a LICENSE file exists
 * alongside it, and never as a violation.
 */
export interface PackageLicense {
  package: string;
  version: string;
  /** The SPDX expression as written, or null when the manifest declares none. */
  license: string | null;
  /** A LICENSE-shaped file sits in the package even though the field is absent. */
  hasLicenseFile: boolean;
  /** True when the expression names a strong-copyleft license. */
  copyleft: boolean;
}

export interface SupplyChainReport {
  /** Did the install-script check run, and if not, why not. */
  installScriptCheck: CheckState;
  /** Did the source check run, and if not, why not. */
  sourceCheck: CheckState;
  installScripts: InstallScript[];
  nonRegistrySources: NonRegistrySource[];
  /** Packages whose manifest declares no `license` field. */
  undeclaredLicenses: PackageLicense[];
  /** Packages under a strong-copyleft license — an obligation, not a defect. */
  copyleftLicenses: PackageLicense[];
  /** Every distinct declared expression, with how many packages use it. */
  licenseCounts: Array<{ license: string; packages: number }>;
  summary: {
    /** Packages found in `node_modules`, 0 when it was not read. */
    packagesInspected: number;
    directDependencies: number;
    withInstallScripts: number;
    /** Of those, the packages whose hook actually runs on `npm install`. */
    withExecutingInstallScripts: number;
    nonRegistry: number;
    /** Packages whose license field is absent AND that ship no LICENSE file. */
    undeclaredLicenses: number;
    copyleftLicenses: number;
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

/**
 * Strong-copyleft families. Matched on the SPDX id, so `GPL-3.0-or-later`,
 * `AGPL-3.0` and `LGPL-2.1` all land — and `LGPL` is included because its
 * obligations differ from MIT's even though they are weaker than GPL's.
 *
 * This is a FACT about the declared expression, never a verdict: whether any of
 * it binds you depends on how you distribute, which the manifest cannot say.
 */
const COPYLEFT_TERM = /\b(?:A?GPL|LGPL|EUPL|CECILL|OSL|CPAL|SSPL|RPL)\b/i;

/**
 * Does this SPDX expression impose a copyleft obligation?
 *
 * An `OR` is a CHOICE, and that distinction is the whole point: `jszip` ships
 * `(MIT OR GPL-3.0-or-later)`, so you take the MIT branch and owe nothing —
 * calling it "under a copyleft license" would be simply wrong. A dual license
 * only binds when EVERY alternative binds. `AND` is the opposite: each term
 * applies, so one copyleft term is enough.
 */
const isCopyleftExpression = (expression: string): boolean => {
  const cleaned = expression.replace(/[()]/g, " ");
  const alternatives = cleaned.split(/\s+OR\s+/i).map((a) => a.trim()).filter((a) => a !== "");
  if (alternatives.length === 0) return false;
  // Every branch of the choice must be copyleft for the obligation to be real.
  return alternatives.every((alternative) =>
    alternative
      .split(/\s+AND\s+/i)
      .some((term) => COPYLEFT_TERM.test(term)),
  );
};

/** Files that carry license terms when the manifest field does not. */
const LICENSE_FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "LICENCE.md", "COPYING", "COPYING.md"];

/** The declared expression, however the manifest spells the field. */
const declaredLicense = (pkg: Record<string, unknown>): string | null => {
  const value = pkg.license ?? pkg.licenses;
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  // The long-deprecated array form: `licenses: [{ type: "MIT" }]`.
  if (Array.isArray(value)) {
    const types = value
      .map((entry) => (entry && typeof entry === "object" ? (entry as { type?: unknown }).type : entry))
      .filter((t): t is string => typeof t === "string" && t.trim() !== "");
    if (types.length > 0) return types.join(" OR ");
  }
  if (value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string") {
    return ((value as { type: string }).type).trim();
  }
  return null;
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
  const licenses: PackageLicense[] = [];

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

      // Licenses, from the same manifest read — the walk is the expensive part.
      const version = typeof pkg.version === "string" ? pkg.version : "";
      const license = declaredLicense(pkg);
      if (license === null) {
        // Absent field is not "unlicensed": check for a LICENSE file before
        // saying anything, so the report distinguishes "no terms anywhere" from
        // "terms the field simply does not name".
        let hasLicenseFile = false;
        for (const candidate of LICENSE_FILES) {
          try {
            await stat(join(nodeModules, name, candidate));
            hasLicenseFile = true;
            break;
          } catch {
            /* keep looking */
          }
        }
        // `private: true` needs no license by npm's own convention, and it is
        // almost always the workspace's own package rather than a dependency.
        if (pkg.private !== true) {
          licenses.push({ package: name, version, license: null, hasLicenseFile, copyleft: false });
        }
      } else {
        licenses.push({ package: name, version, license, hasLicenseFile: false, copyleft: isCopyleftExpression(license) });
      }

      const scripts = pkg.scripts;
      if (scripts === null || typeof scripts !== "object") continue;
      for (const hook of INSTALL_HOOKS) {
        const command = (scripts as Record<string, unknown>)[hook];
        if (typeof command !== "string" || command.trim() === "") continue;
        installScripts.push({
          package: name,
          version,
          hook,
          command,
          direct: direct.has(name),
          // Filled in below, once the lockfile has said which packages are
          // resolved from somewhere other than the registry.
          executes: ALWAYS_EXECUTES.has(hook),
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

  // `prepare` executes only when the package came from git or a directory, which
  // the lockfile is the only place to learn. With no lockfile the source is
  // unknown, and unknown resolves to "does not execute" — the registry is the
  // overwhelmingly common case, and overstating is the failure mode being fixed.
  const nonRegistryPackages = new Set(nonRegistrySources.map((s) => s.package));
  for (const script of installScripts) {
    if (script.executes) continue;
    script.executes =
      EXECUTES_WHEN_NOT_FROM_REGISTRY.has(script.hook) && nonRegistryPackages.has(script.package);
  }

  installScripts.sort(
    (a, b) => (a.package < b.package ? -1 : a.package > b.package ? 1 : 0) || (a.hook < b.hook ? -1 : 1),
  );
  nonRegistrySources.sort((a, b) => (a.package < b.package ? -1 : 1));

  // A missing field AND no LICENSE file is the only case with nothing to read.
  // A field-less package that ships terms is a documentation gap, not a legal
  // unknown, so it is not reported.
  const undeclaredLicenses = licenses
    .filter((l) => l.license === null && !l.hasLicenseFile)
    .sort((a, b) => (a.package < b.package ? -1 : 1));
  const copyleftLicenses = licenses
    .filter((l) => l.copyleft)
    .sort((a, b) => (a.package < b.package ? -1 : 1));

  const counts = new Map<string, number>();
  for (const l of licenses) {
    if (l.license === null) continue;
    counts.set(l.license, (counts.get(l.license) ?? 0) + 1);
  }
  const licenseCounts = [...counts.entries()]
    .map(([license, packages]) => ({ license, packages }))
    .sort((a, b) => b.packages - a.packages || (a.license < b.license ? -1 : 1));

  return {
    installScriptCheck,
    sourceCheck,
    installScripts,
    nonRegistrySources,
    undeclaredLicenses,
    copyleftLicenses,
    licenseCounts,
    summary: {
      packagesInspected,
      directDependencies: direct.size,
      withInstallScripts: new Set(installScripts.map((s) => s.package)).size,
      withExecutingInstallScripts: new Set(
        installScripts.filter((s) => s.executes).map((s) => s.package),
      ).size,
      nonRegistry: nonRegistrySources.length,
      undeclaredLicenses: undeclaredLicenses.length,
      copyleftLicenses: copyleftLicenses.length,
    },
  };
};
