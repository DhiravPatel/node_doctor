/**
 * Configuration resolution. A project may configure node.doctor via, in order of
 * precedence at each directory level:
 *   1. node-doctor.config.{js,mjs,cjs}   (executable)
 *   2. node-doctor.config.{json,jsonc}   (data — safely machine-editable)
 *   3. the `nodeDoctor` key in package.json
 *
 * Resolution walks up from the scan root to the project boundary (a directory
 * containing `.git`) so a nested package inherits the repo-root config. Missing
 * config is never an error — the tool is zero-config by default.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, parse as parsePath } from "node:path";
import { pathToFileURL } from "node:url";
import type { Severity } from "./types.ts";

export type DiagnosticSetting = "off" | "warn" | "error";
export type BlockingLevel = "error" | "warning" | "none";

/** A per-path override: re-severity or disable diagnostics for matching files. */
export interface ConfigOverride {
  files: string[];
  diagnostics: Record<string, DiagnosticSetting>;
}

export interface NodeDoctorConfig {
  /** Per-diagnostic override: disable or change severity. */
  diagnostics?: Record<string, DiagnosticSetting>;
  /** Diagnostic families to disable. */
  ignoreTags?: string[];
  /** Extra path globs to ignore (in addition to the built-ins). */
  ignore?: string[];
  /** Default exit policy. */
  blocking?: BlockingLevel;
  /** Redirect the scan to another directory (resolved against the config file). */
  rootDir?: string;
  /** Per-path severity overrides. */
  overrides?: ConfigOverride[];
}

export type ConfigFormat = "js" | "json" | "package" | "none";

export interface LoadedConfig {
  config: NodeDoctorConfig;
  /** Absolute path of the file the config came from (undefined for defaults). */
  sourcePath?: string;
  format: ConfigFormat;
}

/**
 * Always-applied ignore globs.
 *
 * Every entry is machine-generated output. Analysing it is worse than useless:
 * nobody can act on a finding in a file they do not write, and minified bundles
 * actively manufacture false positives, because any analysis that tracks
 * identifiers by name collides constantly with single-letter names rebound
 * hundreds of times in one file.
 *
 * Measured: a Next.js static export (`out/_next/**`) produced **183 of one
 * project's 184 findings**, 167 of them a single rule firing on mangled bundle
 * code. `.next/**` was already covered but `out/_next/**` — the `next export`
 * destination — was not, so the same artifact was ignored under one name and
 * scanned under another.
 */
export const BUILTIN_IGNORES: readonly string[] = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  // `next export` writes the same bundles here, and this was the gap.
  "**/out/_next/**",
  "**/.nuxt/**",
  "**/coverage/**",
  "**/.node-doctor-cache/**",
  // Vite's pre-bundled dependency cache — copies of node_modules, by definition.
  "**/.vite/**",
  // `prisma generate` output: a client rewritten on every schema change.
  "**/prisma/generated/**",
  "**/*.d.ts",
  "**/*.min.js",
  "**/*.bundle.js",
  "**/*.vendor.js",
];

const JS_CONFIG_FILES = ["node-doctor.config.js", "node-doctor.config.mjs", "node-doctor.config.cjs"];
const JSON_CONFIG_FILES = ["node-doctor.config.json", "node-doctor.config.jsonc"];

const isRuleSetting = (v: unknown): v is DiagnosticSetting =>
  v === "off" || v === "warn" || v === "error";

const asSettingsMap = (source: unknown): Record<string, DiagnosticSetting> | undefined => {
  if (!source || typeof source !== "object") return undefined;
  const out: Record<string, DiagnosticSetting> = {};
  for (const [id, setting] of Object.entries(source as Record<string, unknown>)) {
    if (isRuleSetting(setting)) out[id] = setting;
  }
  return out;
};

const normalize = (raw: unknown): NodeDoctorConfig => {
  const config: NodeDoctorConfig = {};
  if (!raw || typeof raw !== "object") return config;
  const obj = raw as Record<string, unknown>;

  // `rules` is accepted as a legacy alias for `diagnostics`.
  const settings = asSettingsMap(obj.diagnostics ?? obj.rules);
  if (settings) config.diagnostics = settings;

  if (Array.isArray(obj.ignoreTags)) {
    config.ignoreTags = obj.ignoreTags.filter((t): t is string => typeof t === "string");
  }
  if (Array.isArray(obj.ignore)) {
    config.ignore = obj.ignore.filter((g): g is string => typeof g === "string");
  }
  if (obj.blocking === "error" || obj.blocking === "warning" || obj.blocking === "none") {
    config.blocking = obj.blocking;
  }
  if (typeof obj.rootDir === "string") config.rootDir = obj.rootDir;

  if (Array.isArray(obj.overrides)) {
    const overrides: ConfigOverride[] = [];
    for (const entry of obj.overrides) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const files = Array.isArray(e.files)
        ? e.files.filter((f): f is string => typeof f === "string")
        : typeof e.files === "string"
          ? [e.files]
          : [];
      const diagnostics = asSettingsMap(e.diagnostics ?? e.rules);
      if (files.length > 0 && diagnostics && Object.keys(diagnostics).length > 0) {
        overrides.push({ files, diagnostics });
      }
    }
    if (overrides.length > 0) config.overrides = overrides;
  }
  return config;
};

/**
 * Parse JSON with tolerance for `//` and block comments and trailing commas
 * (JSONC). Deliberately small — enough for a human-maintained config file.
 */
export const parseJsonc = (text: string): unknown => {
  let out = "";
  let inString = false;
  let quote = "";
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const next = text[i + 1];
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i++;
      } else if (c === quote) {
        inString = false;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      quote = c;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  // Strip trailing commas before } or ].
  out = out.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(out);
};

const readConfigFile = async (fullPath: string): Promise<unknown> => {
  if (/\.jsonc?$/.test(fullPath)) {
    return parseJsonc(await readFile(fullPath, "utf8"));
  }
  const mod = (await import(pathToFileURL(fullPath).href)) as { default?: unknown };
  return mod.default ?? mod;
};

/** True at a project/repo boundary (or the filesystem root). */
const isBoundary = (dir: string): boolean => existsSync(join(dir, ".git"));

/**
 * Resolve config, walking up from `rootDirectory` to the project boundary.
 * Explicit `configPath` short-circuits the walk.
 */
export const loadConfigWithSource = async (
  rootDirectory: string,
  configPath?: string,
): Promise<LoadedConfig> => {
  if (configPath) {
    try {
      return { config: normalize(await readConfigFile(configPath)), sourcePath: configPath, format: /\.jsonc?$/.test(configPath) ? "json" : "js" };
    } catch {
      return { config: {}, format: "none" };
    }
  }

  let dir = rootDirectory;
  for (;;) {
    for (const file of JS_CONFIG_FILES) {
      const full = join(dir, file);
      if (existsSync(full)) {
        try {
          return { config: normalize(await readConfigFile(full)), sourcePath: full, format: "js" };
        } catch {
          /* unreadable — keep looking */
        }
      }
    }
    for (const file of JSON_CONFIG_FILES) {
      const full = join(dir, file);
      if (existsSync(full)) {
        try {
          return { config: normalize(await readConfigFile(full)), sourcePath: full, format: "json" };
        } catch {
          /* malformed — keep looking */
        }
      }
    }
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { nodeDoctor?: unknown };
        if (pkg.nodeDoctor) return { config: normalize(pkg.nodeDoctor), sourcePath: pkgPath, format: "package" };
      } catch {
        /* ignore */
      }
    }

    if (isBoundary(dir)) break;
    const parent = dirname(dir);
    if (parent === dir || parsePath(dir).root === dir) break;
    dir = parent;
  }

  return { config: {}, format: "none" };
};

/**
 * Load configuration from disk (config only). Backwards-compatible entry point.
 */
export const loadConfig = async (
  rootDirectory: string,
  configPath?: string,
): Promise<NodeDoctorConfig> => (await loadConfigWithSource(rootDirectory, configPath)).config;

/**
 * Merge a project config over a base (workspace-root) config, additively:
 * per-diagnostic settings and overrides layer (project wins on conflict), tag
 * and path ignores union, and scalar fields prefer the project's value.
 */
export const mergeConfig = (base: NodeDoctorConfig, over: NodeDoctorConfig): NodeDoctorConfig => {
  const merged: NodeDoctorConfig = {};
  const diagnostics = { ...(base.diagnostics ?? {}), ...(over.diagnostics ?? {}) };
  if (Object.keys(diagnostics).length > 0) merged.diagnostics = diagnostics;
  const ignoreTags = [...new Set([...(base.ignoreTags ?? []), ...(over.ignoreTags ?? [])])];
  if (ignoreTags.length > 0) merged.ignoreTags = ignoreTags;
  const ignore = [...new Set([...(base.ignore ?? []), ...(over.ignore ?? [])])];
  if (ignore.length > 0) merged.ignore = ignore;
  const overrides = [...(base.overrides ?? []), ...(over.overrides ?? [])];
  if (overrides.length > 0) merged.overrides = overrides;
  const blocking = over.blocking ?? base.blocking;
  if (blocking) merged.blocking = blocking;
  const rootDir = over.rootDir ?? base.rootDir;
  if (rootDir) merged.rootDir = rootDir;
  return merged;
};

/** The effective severity for a diagnostic after config, or "off". */
export const effectiveSetting = (
  ruleId: string,
  ruleSeverity: Severity,
  config: NodeDoctorConfig,
): DiagnosticSetting => {
  const override = config.diagnostics?.[ruleId];
  if (override) return override;
  return ruleSeverity;
};

// ---------------------------------------------------------------------------
// Per-path overrides
// ---------------------------------------------------------------------------

/** Compile a glob (supporting **, *, ?) into a RegExp anchored to a full path. */
export const globToRegExp = (glob: string): RegExp => {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // ** matches across path separators
        re += "[^\\0]*";
        i++;
        if (glob[i + 1] === "/") i++; // consume trailing slash of **/
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
};

/**
 * The effective per-diagnostic settings for one file, layering matching
 * `overrides` on top of the base config. Returns undefined settings unchanged.
 */
export const settingsForFile = (
  config: NodeDoctorConfig,
  normalizedPath: string,
): Record<string, DiagnosticSetting> => {
  const merged: Record<string, DiagnosticSetting> = { ...(config.diagnostics ?? {}) };
  for (const override of config.overrides ?? []) {
    const matches = override.files.some((g) => globToRegExp(g).test(normalizedPath));
    if (matches) Object.assign(merged, override.diagnostics);
  }
  return merged;
};

/**
 * Is this file a VENDORED third-party library checked into the repository?
 *
 * `node_modules` and `*.min.js` are already ignored, but a copy of jQuery or
 * Highcharts committed under `webroot/`, `public/js/`, `assets/` or `lib/` is
 * invisible to both — and it is not the developer's code. Nobody can act on a
 * finding inside a vendored library: the fix is to upgrade the dependency, not
 * to edit the file, and editing it would be undone by the next update.
 *
 * Measured on a CakePHP app in the corpus: **1,871 of its 1,871 findings** came
 * from `webroot/` and `Vendor/` — six separate copies of `jquery.js`, plus
 * `highcharts.src.js`, `datatables_do_not_delete.js`, `fusioncharts.js` and
 * `jquery-ui.custom.js` — and ZERO came from first-party code. The report was
 * pure noise.
 *
 * The test is on CONTENT, not on the path, and that choice is load-bearing.
 * Ignoring `**​/webroot/**` would have been simpler and wrong: that directory is
 * CakePHP's document root and also holds the application's own scripts
 * (`admin_gebo/admin.js`, `support_panel_web/support_actions_faq.js`), which
 * must keep being analysed. Verified against those files — none matches.
 *
 * Two signals, both of which a distributed library carries and hand-written
 * application code essentially never does:
 *
 *   - A LICENSE BANNER in the first few KB — `/*!`, `@license`, `@preserve`, or
 *     a copyright line with a year. Libraries carry these because their licence
 *     requires the notice to survive redistribution.
 *   - A UMD PREAMBLE, the wrapper a build tool emits so one file works under
 *     CommonJS, AMD and a browser global. Application code has no reason to
 *     detect `define.amd` about itself.
 */
const VENDORED_SIGNALS: readonly RegExp[] = [
  /^﻿?\s*\/\*!/,
  /@license|@preserve/i,
  /\(c\)\s*(?:19|20)\d\d|Copyright\s+(?:\(c\)\s*)?(?:19|20)\d\d/i,
  // UMD, in the spellings bundlers and hand-rolled libraries actually emit.
  /typeof\s+exports\s*===?\s*["']object["'][\s\S]{0,200}?typeof\s+define\s*===?\s*["']function["']/,
  /typeof\s+module\s*===?\s*["']object["']\s*&&\s*typeof\s+module\.exports\s*===?\s*["']object["']/,
  /typeof\s+define\s*===?\s*["']function["']\s*&&\s*define\.amd/,
];

/** How much of the file to inspect — a banner or UMD wrapper is always at the top. */
const VENDORED_PROBE_BYTES = 4096;

/**
 * A line no human wrote.
 *
 * Minified and obfuscated bundles are machine output even when they carry no
 * licence banner and no UMD wrapper — an obfuscator strips both. The corpus has
 * one at 688,354 bytes on a SINGLE line, which the banner and UMD signals both
 * miss, and which produced findings whose "variables" are `_0x34e2f2`.
 *
 * A 2,000-character line is three orders of magnitude past anything a person
 * types and well past what any formatter emits. But length alone is not enough:
 * BOTH conditions are required, because a small file with one long line is not a
 * bundle — it is more likely something pathological that the reader needs TOLD
 * about. This tool's whole posture is that "I did not look" must never be
 * reported as "there is nothing", so a file that cannot be analysed is surfaced
 * as a coverage gap rather than silently dropped, and only genuine machine output
 * is dropped. A real minified bundle is both one-lined AND large.
 */
const MINIFIED_LINE_LENGTH = 2000;
const MINIFIED_MIN_BYTES = 50_000;

const hasMachineLengthLine = (sourceText: string): boolean => {
  if (sourceText.length < MINIFIED_MIN_BYTES) return false;
  const head = sourceText.slice(0, VENDORED_PROBE_BYTES * 2);
  // No newline at all within the probe window means the first line is at least
  // this long already.
  if (!head.includes("\n")) return head.length >= MINIFIED_LINE_LENGTH;
  return head.split("\n").some((line) => line.length >= MINIFIED_LINE_LENGTH);
};

export const looksVendoredLibrary = (sourceText: string): boolean => {
  const head = sourceText.slice(0, VENDORED_PROBE_BYTES);
  return VENDORED_SIGNALS.some((signal) => signal.test(head)) || hasMachineLengthLine(sourceText);
};
