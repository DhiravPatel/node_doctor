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

export interface InstallOptions {
  /** Target a single client id; omit to install to all known clients. */
  client?: string;
  /** Project directory to install into (default cwd). */
  targetDir: string;
}

export interface InstallResult {
  written: string[];
  skipped: string[];
}

/** Read the bundled skill markdown shipped inside the package. */
export const readBundledSkill = async (): Promise<string> => {
  const url = new URL("../../skill/SKILL.md", import.meta.url);
  return readFile(url, "utf8");
};

/** Install the skill into one or all clients. */
export const installSkill = async (options: InstallOptions): Promise<InstallResult> => {
  const content = await readBundledSkill();
  const written: string[] = [];
  const skipped: string[] = [];

  const targets: [string, ClientTarget][] = options.client
    ? CLIENTS.has(options.client)
      ? [[options.client, CLIENTS.get(options.client)!]]
      : []
    : [...CLIENTS.entries()];

  if (options.client && targets.length === 0) {
    throw new Error(
      `unknown client "${options.client}". Known: ${[...CLIENTS.keys()].join(", ")}`,
    );
  }

  for (const [, target] of targets) {
    const full = resolve(join(options.targetDir, target.path));
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
