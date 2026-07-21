/**
 * A dependency-free source code frame: a few lines of context around a location
 * with a caret under the offending column. Minified/oversized lines fall back to
 * an empty string so the caller keeps the bare `file:line:col`.
 */

export interface CodeFrameOptions {
  sourceText: string;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
  /** Lines of context above and below (default 2). */
  context?: number;
  /** Skip framing lines longer than this (minified guard, default 240). */
  maxLineLength?: number;
  /** Left padding applied to every rendered row (default 5 spaces). */
  indent?: string;
  /** Colorizer for the gutter and context (default: identity). */
  dim?: (s: string) => string;
  /** Colorizer for the caret marker (default: identity). */
  caret?: (s: string) => string;
}

const identity = (s: string): string => s;

/** Render the frame, or "" when the target line is out of range or minified. */
export const renderCodeFrame = (opts: CodeFrameOptions): string => {
  const context = opts.context ?? 2;
  const maxLen = opts.maxLineLength ?? 240;
  const indent = opts.indent ?? "     ";
  const dim = opts.dim ?? identity;
  const caret = opts.caret ?? identity;

  const lines = opts.sourceText.split("\n");
  if (opts.line < 1 || opts.line > lines.length) return "";
  const target = lines[opts.line - 1] ?? "";
  if (target.length > maxLen) return ""; // minified / pathological — don't frame

  const start = Math.max(1, opts.line - context);
  const end = Math.min(lines.length, opts.line + context);
  const gutterWidth = String(end).length;

  const out: string[] = [];
  for (let n = start; n <= end; n++) {
    const text = lines[n - 1] ?? "";
    if (text.length > maxLen) continue; // skip a huge neighbouring line
    const isTarget = n === opts.line;
    const marker = isTarget ? ">" : " ";
    const num = String(n).padStart(gutterWidth, " ");
    out.push(`${indent}${dim(`${marker} ${num} │`)} ${text}`);
    if (isTarget) {
      const pad = " ".repeat(Math.max(0, opts.column - 1));
      out.push(`${indent}${dim(`${" ".repeat(gutterWidth + 2)} │`)} ${pad}${caret("^")}`);
    }
  }
  return out.join("\n");
};
