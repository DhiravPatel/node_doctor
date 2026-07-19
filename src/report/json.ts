/**
 * JSON reporter. The report object is already built deterministically, so this
 * is a straight, stable serialization — the contract other tools build on.
 */

import type { ScanReport } from "../core/scan.ts";

/** Serialize a report to a pinned-schema JSON string (2-space indent). */
export const toJson = (report: ScanReport): string => JSON.stringify(report, null, 2);
