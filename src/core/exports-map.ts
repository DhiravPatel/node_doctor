/**
 * §185 — Conditional-Export Resolution Correctness (`node-doctor exports-check`).
 *
 * A `package.json` `exports` map is a resolution PROGRAM, and it is routinely
 * wrong in ways that surface only for *some* consumers — which is the worst kind
 * of wrong, because it works for the author. A `require` condition pointing at
 * ESM throws `ERR_REQUIRE_ESM` for every CommonJS consumer while the ESM ones
 * are fine. A `types` condition ordered after `default` is never reached, so
 * TypeScript silently falls back to `any` and nobody notices until a rename
 * breaks at runtime. A subpath whose target does not exist is
 * `ERR_MODULE_NOT_FOUND` for whoever imports it, and `npm publish` does not
 * check.
 *
 * §155 diffs the export *surface* between revisions. Nothing checks that the map
 * **resolves at all**, and the check is pure arithmetic against the files on
 * disk: no heuristics, no dataflow, no network.
 *
 * PRECISION MODEL. Everything reported is a fact about a file that is or is not
 * there, or about a key order that is or is not what Node and TypeScript read.
 * The abstentions are where the arithmetic stops being exact:
 *
 *   - A WILDCARD target (`./*`, `./dist/*.js`) is expanded and reported only
 *     when NOTHING matches it. A pattern that matches some files is doing its
 *     job, and enumerating which subpaths a consumer might ask for is not
 *     decidable.
 *   - The MODULE SYSTEM of a target is read from the file itself — its
 *     extension first (`.mjs`/`.cjs` are unambiguous), then, for `.js`, the
 *     nearest `package.json` `type`, then the syntax actually in the file.
 *     When those disagree or none is conclusive, the target is not judged.
 *   - A target outside the package directory, or one this cannot read, is
 *     reported as unresolvable rather than guessed at.
 *   - `node_modules` is never walked: this checks the package YOU publish.
 *
 * Deterministic: entries sorted by subpath then condition path, no clock.
 */

import { readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import type { NodeDoctorConfig } from "./config.ts";
import { parseSource } from "./parse.ts";
import type { AstNode } from "./types.ts";

/** What is wrong with one entry in the map. */
export type ExportProblem =
  | "missing-target"
  | "require-points-at-esm"
  | "import-points-at-cjs"
  | "types-after-default"
  | "types-condition-not-first"
  | "main-disagrees-with-exports"
  | "dead-wildcard";

export interface ExportFinding {
  problem: ExportProblem;
  /** The subpath key, e.g. "." or "./client". */
  subpath: string;
  /** The condition path that led here, e.g. `exports["."].require`. */
  conditionPath: string;
  /** The target as written in the manifest. */
  target: string | null;
  /** One sentence: what breaks, and for whom. */
  message: string;
}

export interface ExportsCheckReport {
  /** The package this is about, repo-relative. */
  manifestPath: string;
  packageName: string | null;
  /** False when the manifest declares no `exports` map — nothing to check. */
  hasExportsMap: boolean;
  findings: ExportFinding[];
  summary: {
    subpaths: number;
    conditions: number;
    findings: number;
  };
}

// ---------------------------------------------------------------------------
// Module-system detection.
// ---------------------------------------------------------------------------

type ModuleKind = "esm" | "cjs" | "unknown";

/** ESM/CJS from the extension alone, where the extension is conclusive. */
const kindFromExtension = (file: string): ModuleKind => {
  if (/\.mjs$/.test(file)) return "esm";
  if (/\.cjs$/.test(file)) return "cjs";
  return "unknown";
};

/** The `type` of the nearest package.json at or above `dir`, bounded. */
const nearestType = async (dir: string, stopAt: string): Promise<"module" | "commonjs" | null> => {
  let cur = dir;
  for (let i = 0; i < 12; i++) {
    try {
      const raw: unknown = JSON.parse(await readFile(join(cur, "package.json"), "utf8"));
      if (raw !== null && typeof raw === "object") {
        const type = (raw as Record<string, unknown>).type;
        if (type === "module" || type === "commonjs") return type;
        return "commonjs"; // an explicit manifest with no `type` means CJS
      }
    } catch {
      // keep walking up
    }
    if (cur === stopAt) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
};

/**
 * The module system a file actually is.
 *
 * Extension first (unambiguous), then the nearest `type`, and only then the
 * syntax — because a `.js` file with no import/export at all is legal in both
 * systems and guessing from its emptiness would be wrong.
 */
const moduleKindOf = async (file: string, packageDir: string): Promise<ModuleKind> => {
  const byExtension = kindFromExtension(file);
  if (byExtension !== "unknown") return byExtension;

  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch {
    return "unknown";
  }

  // ESM SYNTAX IS CONCLUSIVE for the question this rule asks. Whether the
  // nearest `type` says `module` (so it IS an ES module) or `commonjs` (so it
  // is a syntax error waiting to happen), the one thing that is certain is
  // that `require()` cannot load it — which is exactly the claim being made.
  if (hasEsmSyntax(source, file)) return "esm";

  const declared = await nearestType(dirname(file), packageDir);
  if (declared === "module") return "esm";
  if (declared === "commonjs") return "cjs";
  return hasCjsSyntax(source, file) ? "cjs" : "unknown";
};

const hasEsmSyntax = (source: string, file: string): boolean => {
  const parsed = parseSource(file, source);
  if (parsed.parseFailed) return false;
  return ((parsed.program.body as AstNode[] | undefined) ?? []).some(
    (n) =>
      n.type === "ImportDeclaration" ||
      n.type === "ExportNamedDeclaration" ||
      n.type === "ExportDefaultDeclaration" ||
      n.type === "ExportAllDeclaration",
  );
};

const hasCjsSyntax = (source: string, file: string): boolean => {
  const parsed = parseSource(file, source);
  if (parsed.parseFailed) return false;
  // `module.exports` / `exports.x` anywhere at the top level is conclusive.
  return /(^|[^.\w])(module\.exports|exports\.[A-Za-z_$])/.test(source);
};

// ---------------------------------------------------------------------------
// Map walking.
// ---------------------------------------------------------------------------

/** Conditions Node resolves at runtime, in the order it tries them. */
const RUNTIME_CONDITIONS = new Set(["node", "node-addons", "import", "require", "default", "browser", "deno", "bun"]);

interface Entry {
  subpath: string;
  conditionPath: string;
  /**
   * The condition chain that reaches this target, outermost first — tracked
   * structurally as the map is walked. Reading it back out of `conditionPath`
   * would be string surgery on a field that embeds arbitrary subpath names.
   */
  conditions: string[];
  target: string;
}

/** Flatten a subpath's value into every (conditionPath, target) it can produce. */
const flattenTargets = (
  subpath: string,
  value: unknown,
  path: string,
  out: Entry[],
  orderProblems: ExportFinding[],
  conditions: string[] = [],
  depth = 0,
): void => {
  if (depth > 8) return;
  if (typeof value === "string") {
    out.push({ subpath, conditionPath: path, conditions, target: value });
    return;
  }
  if (Array.isArray(value)) {
    // A spec-legal fallback array: Node takes the first that resolves.
    value.forEach((v, i) =>
      flattenTargets(subpath, v, `${path}[${i}]`, out, orderProblems, conditions, depth + 1),
    );
    return;
  }
  if (value === null || typeof value !== "object") return;

  const keys = Object.keys(value as Record<string, unknown>);

  // TypeScript reads the FIRST matching condition. A `types` key after
  // `default` is never reached, and the package silently resolves to `any`.
  const typesIndex = keys.indexOf("types");
  if (typesIndex > -1) {
    const defaultIndex = keys.indexOf("default");
    if (defaultIndex > -1 && defaultIndex < typesIndex) {
      orderProblems.push({
        problem: "types-after-default",
        subpath,
        conditionPath: `${path}.types`,
        target: null,
        message:
          "`types` is ordered after `default`, so TypeScript never reaches it — every consumer silently resolves this package to `any`. Conditions are matched in declaration order; `types` must come first.",
      });
    } else if (typesIndex > 0) {
      const earlier = keys.slice(0, typesIndex).filter((k) => RUNTIME_CONDITIONS.has(k));
      if (earlier.length > 0) {
        orderProblems.push({
          problem: "types-condition-not-first",
          subpath,
          conditionPath: `${path}.types`,
          target: null,
          message: `\`types\` is ordered after ${earlier.map((k) => `\`${k}\``).join(", ")}. Conditions match in declaration order, so a consumer whose resolver matches one of those first never sees the types.`,
        });
      }
    }
  }

  for (const key of keys) {
    flattenTargets(
      subpath,
      (value as Record<string, unknown>)[key],
      `${path}.${key}`,
      out,
      orderProblems,
      [...conditions, key],
      depth + 1,
    );
  }
};

/** A target reached only through `types`/`typings` is a declaration file. */
const isTypesOnly = (conditions: string[]): boolean =>
  conditions.includes("types") || conditions.includes("typings");

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------

const fileExists = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

export const buildExportsCheckReport = async (
  rootDirectory: string,
  options: { config?: NodeDoctorConfig; manifestPath?: string } = {},
): Promise<ExportsCheckReport> => {
  const manifestFile = options.manifestPath ?? join(rootDirectory, "package.json");
  const manifestPath = relative(rootDirectory, manifestFile).split(sep).join("/") || "package.json";
  const packageDir = dirname(manifestFile);

  const empty = (name: string | null): ExportsCheckReport => ({
    manifestPath,
    packageName: name,
    hasExportsMap: false,
    findings: [],
    summary: { subpaths: 0, conditions: 0, findings: 0 },
  });

  let manifest: Record<string, unknown>;
  try {
    const raw: unknown = JSON.parse(await readFile(manifestFile, "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return empty(null);
    manifest = raw as Record<string, unknown>;
  } catch {
    return empty(null);
  }
  const packageName = typeof manifest.name === "string" ? manifest.name : null;
  const exportsField = manifest.exports;
  if (exportsField === undefined || exportsField === null) return empty(packageName);

  // A bare string or a condition object at the top is the "." subpath; an
  // object whose keys all start with "." is a subpath map.
  const subpathMap: Record<string, unknown> =
    typeof exportsField === "string" || Array.isArray(exportsField)
      ? { ".": exportsField }
      : Object.keys(exportsField as Record<string, unknown>).every((k) => k.startsWith("."))
        ? (exportsField as Record<string, unknown>)
        : { ".": exportsField };

  const entries: Entry[] = [];
  const findings: ExportFinding[] = [];
  for (const subpath of Object.keys(subpathMap).sort()) {
    flattenTargets(subpath, subpathMap[subpath], `exports["${subpath}"]`, entries, findings);
  }

  const fg = (await import("fast-glob")).default;

  for (const entry of entries) {
    const conditions = entry.conditions;
    // `types`/`typings` targets are declaration files; the runtime checks below
    // do not apply to them.
    const isTypesCondition = isTypesOnly(conditions);

    if (!entry.target.startsWith(".")) {
      // A bare specifier target re-exports another package; not this map's file.
      continue;
    }

    if (entry.target.includes("*")) {
      const pattern = entry.target.replace(/^\.\//, "");
      const matches = await fg([pattern], {
        cwd: packageDir,
        onlyFiles: true,
        followSymbolicLinks: false,
        suppressErrors: true,
      });
      if (matches.length === 0) {
        findings.push({
          problem: "dead-wildcard",
          subpath: entry.subpath,
          conditionPath: entry.conditionPath,
          target: entry.target,
          message: `The pattern \`${entry.target}\` matches no file in the package, so every subpath it is meant to serve is \`ERR_PACKAGE_PATH_NOT_EXPORTED\`.`,
        });
      }
      continue; // a matching pattern is doing its job
    }

    const absolute = resolve(packageDir, entry.target);
    if (!absolute.startsWith(packageDir + sep) && absolute !== packageDir) {
      findings.push({
        problem: "missing-target",
        subpath: entry.subpath,
        conditionPath: entry.conditionPath,
        target: entry.target,
        message: `\`${entry.target}\` resolves outside the package directory, so it is not published and cannot be loaded by a consumer.`,
      });
      continue;
    }

    if (!(await fileExists(absolute))) {
      findings.push({
        problem: "missing-target",
        subpath: entry.subpath,
        conditionPath: entry.conditionPath,
        target: entry.target,
        message: `\`${entry.target}\` does not exist. A consumer importing this gets \`ERR_MODULE_NOT_FOUND\` — and \`npm publish\` does not check.`,
      });
      continue;
    }

    if (isTypesCondition) continue;

    const kind = await moduleKindOf(absolute, packageDir);
    if (kind === "unknown") continue; // not conclusive — say nothing

    if (conditions.includes("require") && kind === "esm") {
      findings.push({
        problem: "require-points-at-esm",
        subpath: entry.subpath,
        conditionPath: entry.conditionPath,
        target: entry.target,
        message: `The \`require\` condition points at \`${entry.target}\`, which is ESM. Every CommonJS consumer gets \`ERR_REQUIRE_ESM\` — while ESM consumers work, so this passes the author's own test.`,
      });
      continue;
    }
    if (conditions.includes("import") && kind === "cjs" && /\.cjs$/.test(entry.target)) {
      findings.push({
        problem: "import-points-at-cjs",
        subpath: entry.subpath,
        conditionPath: entry.conditionPath,
        target: entry.target,
        message: `The \`import\` condition points at \`${entry.target}\`, which is CommonJS. Named imports from it are not statically analysable, so \`import { x } from "…"\` fails at link time for ESM consumers.`,
      });
    }
  }

  // `main` and `exports["."]` disagreeing is a real split: older resolvers and
  // bundlers read `main`, modern Node reads `exports`.
  const main = manifest.main;
  if (typeof main === "string" && subpathMap["."] !== undefined) {
    // Only RUNTIME targets can disagree with `main`. A `.` export that carries
    // nothing but `types` says nothing about which file gets loaded, and `main`
    // is then the only runtime answer there is — not a split.
    const dotTargets = entries.filter(
      (e) =>
        e.subpath === "." &&
        !e.target.includes("*") &&
        e.target.startsWith(".") &&
        !isTypesOnly(e.conditions),
    );
    const mainAbsolute = resolve(packageDir, main);
    const anyMatches = dotTargets.some((e) => resolve(packageDir, e.target) === mainAbsolute);
    if (dotTargets.length > 0 && !anyMatches && (await fileExists(mainAbsolute))) {
      findings.push({
        problem: "main-disagrees-with-exports",
        subpath: ".",
        conditionPath: "main",
        target: main,
        message: `\`main\` is \`${main}\`, which no \`exports["."]\` condition resolves to. Modern Node reads \`exports\` and older resolvers and bundlers read \`main\`, so the two audiences load different files.`,
      });
    }
  }

  findings.sort(
    (a, b) =>
      (a.subpath < b.subpath ? -1 : a.subpath > b.subpath ? 1 : 0) ||
      (a.conditionPath < b.conditionPath ? -1 : a.conditionPath > b.conditionPath ? 1 : 0) ||
      (a.problem < b.problem ? -1 : 1),
  );

  return {
    manifestPath,
    packageName,
    hasExportsMap: true,
    findings,
    summary: {
      subpaths: Object.keys(subpathMap).length,
      conditions: entries.length,
      findings: findings.length,
    },
  };
};
