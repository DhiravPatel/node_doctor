/**
 * In-place config editing for `node-doctor diagnostics set|enable|disable|
 * category|ignore-tag|unignore-tag`.
 *
 * node-doctor.config.js is executable, so we never rewrite it statically —
 * instead we edit a data config (node-doctor.config.json or the package.json
 * `nodeDoctor` key), creating node-doctor.config.json when none exists. When
 * only an un-editable JS config is present we print the exact block to paste.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DIAGNOSTICS_BY_ID, DIAGNOSTICS } from "../core/registry.ts";
import { loadConfigWithSource, parseJsonc, type DiagnosticSetting } from "../core/config.ts";

const SCHEMA_REF = "./node_modules/node-doctor/schema/node-doctor.config.schema.json";

export type ConfigAction =
  | { kind: "set"; id: string; setting: DiagnosticSetting }
  | { kind: "enable"; id: string }
  | { kind: "disable"; id: string }
  | { kind: "category"; category: string; setting: DiagnosticSetting }
  | { kind: "ignore-tag"; tag: string }
  | { kind: "unignore-tag"; tag: string };

export interface WriteResult {
  ok: boolean;
  path?: string;
  messages: string[];
  /** When a JS config blocks editing, the block the user should paste. */
  printBlock?: string;
  exitCode: number;
}

interface EditableConfig {
  diagnostics?: Record<string, DiagnosticSetting>;
  ignoreTags?: string[];
  [k: string]: unknown;
}

const CATEGORY_BY_LOWER = new Map(
  ["Security", "Reliability", "Bugs", "Performance", "Maintainability"].map((c) => [c.toLowerCase(), c]),
);

/** Apply one action to a plain config object; returns a human message or an error. */
const applyOne = (cfg: EditableConfig, action: ConfigAction): { message: string } | { error: string } => {
  const setSeverity = (id: string, setting: DiagnosticSetting): { message: string } | { error: string } => {
    if (!DIAGNOSTICS_BY_ID.has(id)) return { error: `unknown diagnostic "${id}" (see \`node-doctor diagnostics\`)` };
    cfg.diagnostics = cfg.diagnostics ?? {};
    cfg.diagnostics[id] = setting;
    return { message: `${id} → ${setting}` };
  };

  switch (action.kind) {
    case "set":
      return setSeverity(action.id, action.setting);
    case "disable":
      return setSeverity(action.id, "off");
    case "enable": {
      const d = DIAGNOSTICS_BY_ID.get(action.id);
      if (!d) return { error: `unknown diagnostic "${action.id}"` };
      return setSeverity(action.id, d.severity);
    }
    case "category": {
      const canonical = CATEGORY_BY_LOWER.get(action.category.toLowerCase());
      if (!canonical) return { error: `unknown category "${action.category}"` };
      cfg.diagnostics = cfg.diagnostics ?? {};
      let n = 0;
      for (const d of DIAGNOSTICS) {
        if (d.category === canonical) {
          cfg.diagnostics[d.id] = action.setting;
          n++;
        }
      }
      return { message: `${n} ${canonical} diagnostic(s) → ${action.setting}` };
    }
    case "ignore-tag": {
      const tags = new Set(cfg.ignoreTags ?? []);
      tags.add(action.tag);
      cfg.ignoreTags = [...tags].sort();
      return { message: `ignoring tag "${action.tag}"` };
    }
    case "unignore-tag": {
      cfg.ignoreTags = (cfg.ignoreTags ?? []).filter((t) => t !== action.tag);
      if (cfg.ignoreTags.length === 0) delete cfg.ignoreTags;
      return { message: `no longer ignoring tag "${action.tag}"` };
    }
  }
};

/** Load, mutate, and persist the config for the given actions. */
export const applyConfigActions = async (cwd: string, actions: ConfigAction[]): Promise<WriteResult> => {
  const loaded = await loadConfigWithSource(cwd, undefined);
  const messages: string[] = [];

  // Read the raw object we will edit (preserving unrelated keys).
  let target: { path: string; kind: "json" | "package" } | undefined;
  let raw: EditableConfig = {};
  let pkg: Record<string, unknown> | undefined;

  if (loaded.format === "js") {
    // Can't statically edit executable config — compute the intended block and print it.
    const preview: EditableConfig = {};
    for (const a of actions) applyOne(preview, a);
    const block = `diagnostics: ${JSON.stringify(preview.diagnostics ?? {}, null, 2)}`;
    return {
      ok: false,
      messages: [`Config at ${loaded.sourcePath} is executable JS and can't be edited automatically.`],
      printBlock: block,
      exitCode: 1,
    };
  }

  if (loaded.format === "json" && loaded.sourcePath) {
    raw = parseJsonc(await readFile(loaded.sourcePath, "utf8")) as EditableConfig;
    target = { path: loaded.sourcePath, kind: "json" };
  } else if (loaded.format === "package" && loaded.sourcePath) {
    pkg = JSON.parse(await readFile(loaded.sourcePath, "utf8")) as Record<string, unknown>;
    raw = (pkg.nodeDoctor as EditableConfig | undefined) ?? {};
    target = { path: loaded.sourcePath, kind: "package" };
  } else {
    // No config yet — create node-doctor.config.json in cwd.
    raw = { $schema: SCHEMA_REF };
    target = { path: join(cwd, "node-doctor.config.json"), kind: "json" };
  }

  for (const action of actions) {
    const result = applyOne(raw, action);
    if ("error" in result) return { ok: false, messages: [result.error], exitCode: 2 };
    messages.push(result.message);
  }

  if (target.kind === "package" && pkg) {
    pkg.nodeDoctor = raw;
    await writeFile(target.path, JSON.stringify(pkg, null, 2) + "\n");
  } else {
    await writeFile(target.path, JSON.stringify(raw, null, 2) + "\n");
  }

  return { ok: true, path: target.path, messages, exitCode: 0 };
};

const isSetting = (s: string): s is DiagnosticSetting => s === "off" || s === "warn" || s === "error";

/**
 * Parse `diagnostics <verb> …` positionals into a ConfigAction (positionals[0]
 * is the verb). Returns undefined when positionals[0] isn't a writing verb.
 */
export const parseConfigAction = (positionals: string[]): ConfigAction | { error: string } | undefined => {
  const [verb, a, b] = positionals;
  switch (verb) {
    case "set":
      if (!a || !b) return { error: "usage: node-doctor diagnostics set <id> <off|warn|error>" };
      if (!isSetting(b)) return { error: `severity must be off|warn|error (got "${b}")` };
      return { kind: "set", id: a, setting: b };
    case "enable":
      if (!a) return { error: "usage: node-doctor diagnostics enable <id>" };
      return { kind: "enable", id: a };
    case "disable":
      if (!a) return { error: "usage: node-doctor diagnostics disable <id>" };
      return { kind: "disable", id: a };
    case "category":
      if (!a || !b) return { error: "usage: node-doctor diagnostics category <name> <off|warn|error>" };
      if (!isSetting(b)) return { error: `severity must be off|warn|error (got "${b}")` };
      return { kind: "category", category: a, setting: b };
    case "ignore-tag":
      if (!a) return { error: "usage: node-doctor diagnostics ignore-tag <tag>" };
      return { kind: "ignore-tag", tag: a };
    case "unignore-tag":
      if (!a) return { error: "usage: node-doctor diagnostics unignore-tag <tag>" };
      return { kind: "unignore-tag", tag: a };
    default:
      return undefined;
  }
};
