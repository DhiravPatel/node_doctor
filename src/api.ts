/**
 * The programmatic entry point. `diagnose()` wraps `scanProject` for the common
 * case and adds a resilient batch mode: scan many directories concurrently,
 * capture per-directory failures instead of throwing, and aggregate a worst-of
 * health score.
 *
 *   import { diagnose } from "node-doctor";
 *
 *   const report = await diagnose("./service");                 // single
 *   const batch  = await diagnose({ directories: ["a", "b"] }); // many
 */

import { scanProject, type ScanReport, type ScanProjectOptions } from "./core/scan.ts";
import { calculateScore, type ScoreResult } from "./core/score.ts";
import { mapPool } from "./core/pool.ts";
import type { Finding } from "./core/types.ts";

export type DiagnoseOptions = Omit<ScanProjectOptions, "rootDirectory">;

export interface BatchDiagnoseInput extends DiagnoseOptions {
  directories: string[];
  /** Directories scanned concurrently (default 4). */
  concurrency?: number;
}


export type DiagnoseOutcome =
  | { ok: true; directory: string; report: ScanReport }
  | { ok: false; directory: string; error: string };

export interface BatchDiagnoseResult {
  /** True when every directory scanned without error. */
  ok: boolean;
  results: DiagnoseOutcome[];
  /** Worst (lowest) score across the directories that scanned successfully. */
  score: ScoreResult;
  /** Every finding across all successful scans. */
  findings: Finding[];
}

export function diagnose(directory: string, options?: DiagnoseOptions): Promise<ScanReport>;
export function diagnose(input: BatchDiagnoseInput): Promise<BatchDiagnoseResult>;
export async function diagnose(
  a: string | BatchDiagnoseInput,
  b?: DiagnoseOptions,
): Promise<ScanReport | BatchDiagnoseResult> {
  if (typeof a === "string") {
    return scanProject({ rootDirectory: a, ...(b ?? {}) });
  }

  const { directories, concurrency, ...options } = a;
  const results = await mapPool(directories, concurrency ?? 4, async (directory): Promise<DiagnoseOutcome> => {
    try {
      return { ok: true, directory, report: await scanProject({ rootDirectory: directory, ...options }) };
    } catch (err) {
      return { ok: false, directory, error: err instanceof Error ? err.message : String(err) };
    }
  });

  const successes = results.filter((r): r is Extract<DiagnoseOutcome, { ok: true }> => r.ok);
  const worst = successes
    .map((r) => r.report.score)
    .reduce<ScoreResult | null>((acc, s) => (!acc || s.score < acc.score ? s : acc), null);

  return {
    ok: results.every((r) => r.ok),
    results,
    score: worst ?? calculateScore([], { totalLines: 0 }),
    findings: successes.flatMap((r) => r.report.findings),
  };
}
