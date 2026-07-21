/**
 * `node-doctor install` — write the agent skill into supported clients.
 *
 * The skill is **bundled locally** (read from the package's `skill/SKILL.md`);
 * there is no runtime remote fetch — an offline-first divergence from
 * react.doctor (§14). The client → path map is extensible; add an entry and the
 * command targets it.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface ClientTarget {
  label: string;
  /** Path relative to the target project directory. */
  path: string;
}

/** Known agent clients and where their project-level skill/diagnostics file lives. */
export const CLIENTS = new Map<string, ClientTarget>([
  ["claude-code", { label: "Claude Code", path: ".claude/skills/node-doctor/SKILL.md" }],
  ["cursor", { label: "Cursor", path: ".cursor/diagnostics/node-doctor.mdc" }],
  ["windsurf", { label: "Windsurf", path: ".windsurf/diagnostics/node-doctor.md" }],
  ["codex", { label: "Codex", path: ".codex/skills/node-doctor.md" }],
  ["cline", { label: "Cline", path: ".clinerules/node-doctor.md" }],
  ["copilot", { label: "GitHub Copilot", path: ".github/copilot-instructions.md" }],
]);

/** The two bundled skills. */
export type SkillName = "node-doctor" | "improve-node";

export interface InstallOptions {
  /** Target a single client id; omit to install to `clients` (or all known). */
  client?: string;
  /** Explicit client id list (e.g. the detected ones). Ignored if `client` is set. */
  clients?: string[];
  /** Which bundled skill to install (default the main node-doctor skill). */
  skill?: SkillName;
  /** Project directory to install into (default cwd). */
  targetDir: string;
}

export interface InstallResult {
  written: string[];
  skipped: string[];
}

/** Read a bundled skill's markdown shipped inside the package. */
export const readBundledSkill = async (skill: SkillName = "node-doctor"): Promise<string> => {
  const rel = skill === "improve-node" ? "../../skill/improve-node/SKILL.md" : "../../skill/SKILL.md";
  return readFile(new URL(rel, import.meta.url), "utf8");
};

/** Rewrite a client's target path for a non-default skill (own folder/filename). */
const pathForSkill = (basePath: string, skill: SkillName): string =>
  skill === "node-doctor" ? basePath : basePath.replace(/node-doctor/g, skill);

/** Install the skill into one, some, or all clients. */
export const installSkill = async (options: InstallOptions): Promise<InstallResult> => {
  const skill = options.skill ?? "node-doctor";
  const content = await readBundledSkill(skill);
  const written: string[] = [];
  const skipped: string[] = [];

  let targets: [string, ClientTarget][];
  if (options.client) {
    if (!CLIENTS.has(options.client)) {
      throw new Error(`unknown client "${options.client}". Known: ${[...CLIENTS.keys()].join(", ")}`);
    }
    targets = [[options.client, CLIENTS.get(options.client)!]];
  } else if (options.clients && options.clients.length > 0) {
    targets = options.clients.filter((id) => CLIENTS.has(id)).map((id) => [id, CLIENTS.get(id)!]);
  } else {
    targets = [...CLIENTS.entries()];
  }

  for (const [, target] of targets) {
    const full = resolve(join(options.targetDir, pathForSkill(target.path, skill)));
    try {
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content);
      written.push(full);
    } catch {
      skipped.push(full);
    }
  }

  return { written, skipped };
};
