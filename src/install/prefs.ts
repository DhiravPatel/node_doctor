/**
 * A tiny per-user preferences store at `~/.node-doctor/state.json` — remembers
 * which agent clients you installed to, to pre-select them next time. Read only
 * by interactive install; a deterministic scan never touches it, so offline
 * reproducibility is intact.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Prefs {
  /** Client ids selected on a previous install. */
  clients?: string[];
}

const dir = (): string => join(homedir(), ".node-doctor");
const file = (): string => join(dir(), "state.json");

export const readPrefs = async (): Promise<Prefs> => {
  try {
    const raw = JSON.parse(await readFile(file(), "utf8")) as Prefs;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
};

export const writePrefs = async (prefs: Prefs): Promise<void> => {
  try {
    await mkdir(dir(), { recursive: true });
    await writeFile(file(), JSON.stringify(prefs, null, 2) + "\n");
  } catch {
    /* best-effort — never fail an install because prefs couldn't be saved */
  }
};

/** Merge and persist the client selection (deduped). */
export const rememberClients = async (clients: string[]): Promise<void> => {
  const prev = await readPrefs();
  await writePrefs({ ...prev, clients: [...new Set([...(prev.clients ?? []), ...clients])] });
};
