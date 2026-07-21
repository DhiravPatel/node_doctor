/**
 * Detect which coding-agent clients are present, so `install` can default to the
 * ones actually in use instead of writing to every known path. A client counts
 * as present if its CLI is on PATH or its config directory exists (in the project
 * or the home directory).
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";

/** Is `bin` resolvable on PATH? (extracted from the agent-fix flow). */
export const onPath = (bin: string): boolean => {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

interface ClientProbe {
  id: string;
  label: string;
  bins: string[];
  /** Marker directories; `~/…` resolves against home, others against the project. */
  dirs: string[];
}

// Ids match the skill `CLIENTS` map so a detected client maps to an install target.
const CLIENT_PROBES: ClientProbe[] = [
  { id: "claude-code", label: "Claude Code", bins: ["claude"], dirs: [".claude", "~/.claude"] },
  { id: "cursor", label: "Cursor", bins: ["cursor", "cursor-agent"], dirs: [".cursor", "~/.cursor"] },
  { id: "windsurf", label: "Windsurf", bins: ["windsurf"], dirs: [".windsurf", "~/.codeium"] },
  { id: "codex", label: "Codex", bins: ["codex"], dirs: [".codex", "~/.codex"] },
  { id: "cline", label: "Cline", bins: [], dirs: [".clinerules"] },
];

const dirExists = (dir: string, cwd: string): boolean => {
  const full = dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : isAbsolute(dir) ? dir : join(cwd, dir);
  return existsSync(full);
};

export interface DetectedClient {
  id: string;
  label: string;
}

/** Client ids present on this machine / in this project, in preference order. */
export const detectInstalledClients = (cwd: string = process.cwd()): DetectedClient[] =>
  CLIENT_PROBES.filter((p) => p.bins.some(onPath) || p.dirs.some((d) => dirExists(d, cwd))).map((p) => ({
    id: p.id,
    label: p.label,
  }));
