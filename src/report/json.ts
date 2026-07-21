/**
 * JSON reporter. The report object is already built deterministically, so this
 * is a straight, stable serialization — the contract other tools build on.
 */

import type { ScanReport } from "../core/scan.ts";
import { SCHEMA_VERSION } from "../core/scan.ts";

export interface JsonOptions {
  /** Emit without indentation (for machine consumption / smaller payloads). */
  compact?: boolean;
}

/** Serialize a report to a pinned-schema JSON string (2-space indent by default). */
export const toJson = (report: ScanReport, options: JsonOptions = {}): string =>
  options.compact ? JSON.stringify(report) : JSON.stringify(report, null, 2);

/**
 * A well-formed error report, emitted in `--json` mode when a command throws so
 * CI consumers always receive valid, parseable JSON (never a bare stack trace).
 */
export interface JsonErrorReport {
  schemaVersion: number;
  ok: false;
  error: { name: string; message: string };
  project: null;
  findings: never[];
  score: null;
}

export const toJsonError = (err: unknown, options: JsonOptions = {}): string => {
  const e = err instanceof Error ? err : new Error(String(err));
  const payload: JsonErrorReport = {
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    error: { name: e.name || "Error", message: e.message },
    project: null,
    findings: [],
    score: null,
  };
  return options.compact ? JSON.stringify(payload) : JSON.stringify(payload, null, 2);
};
