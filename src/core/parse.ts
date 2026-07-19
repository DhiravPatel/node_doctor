/**
 * The parser wrapper around oxc-parser.
 *
 *  - Chooses the right `lang`/`sourceType` from the file extension.
 *  - Returns the ESTree program plus a normalized list of parse errors.
 *  - Never throws on malformed input — a parse failure is a **coverage gap**,
 *    not a crash. Callers must treat `parseFailed: true` as "we could not read
 *    this file", never as "clean".
 */

import { parseSync } from "oxc-parser";
import type { AstNode } from "./types.ts";

export interface ParseOutput {
  /** ESTree Program (possibly partial on error). */
  program: AstNode;
  /** oxc module record (static imports/exports), or undefined. */
  module: unknown;
  /** Comment nodes ({ type, value, start, end }). */
  comments: Array<{ type: string; value: string; start: number; end: number }>;
  /** True if any hard parse error occurred. */
  parseFailed: boolean;
  /** Human-readable parse error messages. */
  errors: string[];
  /** The chosen oxc `lang`. */
  lang: "js" | "jsx" | "ts" | "tsx";
}

/**
 * Map a file extension to oxc's `lang`. TypeScript files never allow JSX angle
 * syntax (it's a type assertion), so `.ts` must parse as `ts`. Plain `.js` is
 * parsed as `jsx` so a stray React file in a backend repo does not hard-fail.
 */
export const langForPath = (filePath: string): "js" | "jsx" | "ts" | "tsx" => {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".tsx")) return "tsx";
  if (lower.endsWith(".ts") || lower.endsWith(".mts") || lower.endsWith(".cts")) return "ts";
  if (lower.endsWith(".jsx")) return "jsx";
  return "jsx"; // .js/.mjs/.cjs — jsx is a safe superset of plain JS
};

export const sourceTypeForPath = (filePath: string): "module" | "script" | "unambiguous" => {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".mjs") || lower.endsWith(".mts")) return "module";
  if (lower.endsWith(".cjs") || lower.endsWith(".cts")) return "script";
  return "unambiguous";
};

interface OxcError {
  severity?: string;
  message?: string;
  labels?: Array<{ start?: number }>;
}

const formatOxcError = (error: OxcError | string | null): string => {
  if (!error) return "parse error";
  if (typeof error === "string") return error;
  const msg = error.message || "parse error";
  const label = Array.isArray(error.labels) ? error.labels[0] : undefined;
  if (label && typeof label.start === "number") {
    return `${msg} (at offset ${label.start})`;
  }
  return msg;
};

/** Parse a single source string. Deterministic and side-effect free. */
export const parseSource = (filePath: string, sourceText: string): ParseOutput => {
  const lang = langForPath(filePath);
  const sourceType = sourceTypeForPath(filePath);
  try {
    const result = parseSync(filePath, sourceText, {
      lang,
      sourceType,
      // Do not emit ParenthesizedExpression nodes; diagnostics never step through them.
      preserveParens: false,
    });

    const errors: OxcError[] = Array.isArray(result.errors) ? (result.errors as OxcError[]) : [];
    // Treat any reported "Error"-severity finding as a hard failure for
    // coverage accounting, but still hand back the partial program.
    const hardErrors = errors.filter(
      (e) => !e || e.severity === undefined || e.severity === "Error",
    );

    return {
      program: result.program as unknown as AstNode,
      module: result.module,
      comments: Array.isArray(result.comments)
        ? (result.comments as ParseOutput["comments"])
        : [],
      parseFailed: hardErrors.length > 0,
      errors: hardErrors.map(formatOxcError),
      lang,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown parse error";
    return {
      program: { type: "Program", body: [], start: 0, end: 0 },
      module: undefined,
      comments: [],
      parseFailed: true,
      errors: [message],
      lang,
    };
  }
};
