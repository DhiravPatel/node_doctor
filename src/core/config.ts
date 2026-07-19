/**
 * Configuration: a `node-doctor.config.js`/`.mjs` file or a `nodeDoctor` key in
 * `package.json`. Everything is optional; the tool is zero-config by default.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Severity } from "./types.ts";

export type DiagnosticSetting = "off" | "warn" | "error";
export type BlockingLevel = "error" | "warning" | "none";

export interface NodeDoctorConfig {
  /** Per-diagnostic override: disable or change severity. */
  diagnostics?: Record<string, DiagnosticSetting>;
  /** Diagnostic families to disable. */
  ignoreTags?: string[];
  /** Extra path globs to ignore (in addition to the built-ins). */
  ignore?: string[];
  /** Default exit policy. */
  blocking?: BlockingLevel;
}

/** Always-applied ignore globs. */
export const BUILTIN_IGNORES: readonly string[] = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/coverage/**",
  "**/.node-doctor-cache/**",
  "**/*.d.ts",
  "**/*.min.js",
];

const CONFIG_FILES = ["node-doctor.config.js", "node-doctor.config.mjs"];

const isRuleSetting = (v: unknown): v is DiagnosticSetting =>
  v === "off" || v === "warn" || v === "error";

const normalize = (raw: unknown): NodeDoctorConfig => {
  const config: NodeDoctorConfig = {};
  if (!raw || typeof raw !== "object") return config;
  const obj = raw as Record<string, unknown>;

  // `rules` is accepted as a legacy alias for `diagnostics`.
  const settingsSource = (obj.diagnostics ?? obj.rules) as Record<string, unknown> | undefined;
  if (settingsSource && typeof settingsSource === "object") {
    const diagnostics: Record<string, DiagnosticSetting> = {};
    for (const [id, setting] of Object.entries(settingsSource)) {
      if (isRuleSetting(setting)) diagnostics[id] = setting;
    }
    config.diagnostics = diagnostics;
  }
  if (Array.isArray(obj.ignoreTags)) {
    config.ignoreTags = obj.ignoreTags.filter((t): t is string => typeof t === "string");
  }
  if (Array.isArray(obj.ignore)) {
    config.ignore = obj.ignore.filter((g): g is string => typeof g === "string");
  }
  if (obj.blocking === "error" || obj.blocking === "warning" || obj.blocking === "none") {
    config.blocking = obj.blocking;
  }
  return config;
};

/**
 * Load configuration from disk. Explicit `configPath` wins; otherwise probe the
 * config files then the `nodeDoctor` key in package.json. Missing config is not
 * an error — returns `{}`.
 */
export const loadConfig = async (
  rootDirectory: string,
  configPath?: string,
): Promise<NodeDoctorConfig> => {
  if (configPath) {
    const mod = await import(pathToFileURL(configPath).href);
    return normalize(mod.default ?? mod);
  }

  for (const file of CONFIG_FILES) {
    const full = join(rootDirectory, file);
    try {
      await readFile(full, "utf8"); // existence probe (import errors are opaque)
      const mod = await import(pathToFileURL(full).href);
      return normalize(mod.default ?? mod);
    } catch {
      // not present or not importable — fall through
    }
  }

  try {
    const raw = await readFile(join(rootDirectory, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { nodeDoctor?: unknown };
    if (pkg.nodeDoctor) return normalize(pkg.nodeDoctor);
  } catch {
    // no package.json / no key
  }

  return {};
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
