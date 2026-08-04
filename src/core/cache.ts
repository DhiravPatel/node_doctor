/**
 * Content-hash sidecar cache (§19). An unchanged file is never re-analyzed
 * between runs — the biggest win for local iteration and warm-cache CI.
 *
 * A cache entry is keyed on two hashes: the file's content, and a **probe** —
 * the exact set of enabled diagnostics, their effective severities, and the project's
 * capabilities. Change any of those and the entry is invalid, so the cache can
 * never return stale results after a config or ruleset change. Reused results
 * are byte-identical to a fresh run, preserving determinism.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Diagnostic, Severity } from "./types.ts";

export const CACHE_DIR_NAME = ".node-doctor-cache";
const CACHE_FILE = "cache.json";
// v2 adds `suppressedKeys` (§161): the ratchet must know which findings vanished
// because they were SUPPRESSED rather than fixed, and a cached file has to carry
// that fact too. Bumping the version discards v1 entries cleanly.
const CACHE_VERSION = 2;

/** A cached per-file analysis (file-scope only). */
export interface CacheEntry {
  hash: string;
  probe: string;
  pending: unknown[];
  /** Evidence keys of findings an inline directive suppressed in this file. */
  suppressedKeys: string[];
  totalLines: number;
  parseFailed: boolean;
  errors: string[];
}

export interface CacheStore {
  version: number;
  files: Record<string, CacheEntry>;
}

export const hashContent = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);

/** The probe hash: enabled diagnostics + severities + capabilities. */
export const computeProbe = (
  diagnostics: Diagnostic[],
  effectiveSeverity: Map<string, Severity>,
  capabilities: Set<string>,
): string => {
  const ruleSig = diagnostics
    .map((r) => `${r.id}:${effectiveSeverity.get(r.id) ?? r.severity}`)
    .sort()
    .join(",");
  const capSig = [...capabilities].sort().join(",");
  return createHash("sha256").update(`${CACHE_VERSION}|${ruleSig}|${capSig}`).digest("hex").slice(0, 16);
};

export const loadCache = async (cacheDir: string): Promise<CacheStore> => {
  try {
    const raw = await readFile(join(cacheDir, CACHE_FILE), "utf8");
    const parsed = JSON.parse(raw) as CacheStore;
    if (parsed.version === CACHE_VERSION && parsed.files) return parsed;
  } catch {
    /* missing/corrupt — start fresh */
  }
  return { version: CACHE_VERSION, files: {} };
};

export const saveCache = async (cacheDir: string, store: CacheStore): Promise<void> => {
  try {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, CACHE_FILE), JSON.stringify(store));
  } catch {
    /* cache is best-effort — never fail a scan because it couldn't be written */
  }
};
