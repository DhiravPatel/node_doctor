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

/**
 * The nesting depth past which the native parser overflows its stack. A stack
 * overflow inside `parseSync` is a SIGSEGV — the process dies with no output,
 * taking the whole scan with it, and no `try`/`catch` can intercept it. So the
 * depth is measured cheaply on the raw text FIRST and such a file is declared a
 * parse failure, which is the honest answer anyway: we did not analyze it.
 *
 * Empirically the native limit sits near 5,000; 1,500 is far below anything
 * hand-written and still below the cliff for machine-generated output.
 */
const MAX_NESTING_DEPTH = 1500;

/**
 * Does the source nest brackets deeper than the parser can survive?
 *
 * This runs BEFORE parsing, so it cannot ask the AST — it counts characters.
 * To keep the count honest it skips the places brackets are not structure:
 * string and template literals, and both comment forms. Regex literals are not
 * skipped, because telling `/[(]/` from a division without a parser is exactly
 * the ambiguity that needs one; a file would need 1,500 net-unbalanced brackets
 * inside regexes to be mismeasured, which does not happen in practice.
 *
 * The error direction is the safe one anyway: over-counting declares a file
 * unparseable, which costs coverage on that file and never invents a finding.
 */
const exceedsNestingLimit = (sourceText: string): boolean => {
  let depth = 0;
  /**
   * For every template literal whose `${…}` hole we are currently inside, the
   * bracket depth the hole opened at. Returning to that depth means the hole
   * closed and template TEXT resumes — which is how nested templates stay
   * balanced instead of drifting.
   */
  const holeDepths: number[] = [];
  let inTemplateText = false;

  for (let i = 0; i < sourceText.length; i++) {
    const c = sourceText[i]!;

    if (inTemplateText) {
      if (c === "\\") {
        i++;
      } else if (c === "`") {
        inTemplateText = false;
      } else if (c === "$" && sourceText[i + 1] === "{") {
        holeDepths.push(depth);
        depth++;
        if (depth > MAX_NESTING_DEPTH) return true;
        inTemplateText = false;
        i++;
      }
      continue;
    }

    // Comments hold no structure.
    if (c === "/" && sourceText[i + 1] === "/") {
      const nl = sourceText.indexOf("\n", i + 2);
      if (nl === -1) return false;
      i = nl;
      continue;
    }
    if (c === "/" && sourceText[i + 1] === "*") {
      const end = sourceText.indexOf("*/", i + 2);
      if (end === -1) return false;
      i = end + 1;
      continue;
    }

    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      for (; i < sourceText.length; i++) {
        const s = sourceText[i]!;
        if (s === "\\") i++;
        else if (s === quote || s === "\n") break; // unterminated: let the parser judge
      }
      continue;
    }
    if (c === "`") {
      inTemplateText = true;
      continue;
    }

    if (c === "(" || c === "[" || c === "{") {
      depth++;
      if (depth > MAX_NESTING_DEPTH) return true;
    } else if (c === ")" || c === "]" || c === "}") {
      if (depth > 0) depth--;
      if (holeDepths.length > 0 && depth === holeDepths[holeDepths.length - 1]) {
        holeDepths.pop();
        inTemplateText = true;
      }
    }
  }
  return false;
};

/** Parse a single source string. Deterministic and side-effect free. */
export const parseSource = (filePath: string, sourceText: string): ParseOutput => {
  const lang = langForPath(filePath);
  const sourceType = sourceTypeForPath(filePath);

  // Guard before handing the text to the native parser: past its stack limit the
  // failure mode is process death, not an exception.
  if (exceedsNestingLimit(sourceText)) {
    return {
      program: { type: "Program", body: [], start: 0, end: 0 },
      module: undefined,
      comments: [],
      parseFailed: true,
      errors: [
        `nesting deeper than ${MAX_NESTING_DEPTH} brackets — not analyzed (the parser cannot handle it without crashing the process)`,
      ],
      lang,
    };
  }

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
