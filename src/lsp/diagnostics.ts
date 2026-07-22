/**
 * Translate node.doctor findings into LSP shapes.
 *
 * Kept pure and separate from the transport so the fiddly part — node.doctor
 * positions are 1-based, LSP positions are 0-based, and an off-by-one here puts
 * every squiggle on the wrong line — is unit-tested rather than eyeballed in an
 * editor.
 */

import type { Finding } from "../core/types.ts";
import { DIAGNOSTICS_BY_ID } from "../core/registry.ts";

/** LSP DiagnosticSeverity: 1 Error, 2 Warning, 3 Information, 4 Hint. */
const LSP_SEVERITY = { error: 1, warn: 2 } as const;

export interface LspPosition {
  line: number;
  character: number;
}
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
export interface LspDiagnostic {
  range: LspRange;
  severity: number;
  code: string;
  source: string;
  message: string;
  /** Carried through so a code action can recover the finding it came from. */
  data?: { diagnostic: string; line: number };
}

/**
 * The range to underline. node.doctor reports a single 1-based point; we
 * underline to the end of the identifier-ish token at that column so the squiggle
 * has visible width instead of being a zero-length caret.
 */
export const rangeForFinding = (finding: Finding, lineText: string | undefined): LspRange => {
  const line = Math.max(0, finding.line - 1);
  const character = Math.max(0, finding.column - 1);
  let endCharacter = character + 1;
  if (lineText !== undefined) {
    const token = /^[A-Za-z0-9_$.[\]"'`-]+/.exec(lineText.slice(character));
    if (token) endCharacter = character + token[0].length;
    else endCharacter = Math.max(character + 1, lineText.length);
  }
  return { start: { line, character }, end: { line, character: endCharacter } };
};

/** Convert one finding into an LSP diagnostic. */
export const toLspDiagnostic = (finding: Finding, lineText?: string): LspDiagnostic => ({
  range: rangeForFinding(finding, lineText),
  severity: LSP_SEVERITY[finding.severity],
  code: `node-doctor/${finding.diagnostic}`,
  source: "node.doctor",
  // The recommendation is the actionable half — an editor shows both.
  message: `${finding.message}\n\nFix: ${finding.recommendation}`,
  data: { diagnostic: finding.diagnostic, line: finding.line },
});

export const toLspDiagnostics = (findings: Finding[], sourceText: string): LspDiagnostic[] => {
  const lines = sourceText.split("\n");
  return findings.map((f) => toLspDiagnostic(f, lines[f.line - 1]));
};

// ---------------------------------------------------------------------------
// Hover
// ---------------------------------------------------------------------------

/** Is this 0-based position inside the range? */
export const rangeContains = (range: LspRange, position: LspPosition): boolean => {
  if (position.line < range.start.line || position.line > range.end.line) return false;
  if (position.line === range.start.line && position.character < range.start.character) return false;
  if (position.line === range.end.line && position.character > range.end.character) return false;
  return true;
};

/** Markdown hover card for the finding under the cursor, or null. */
export const hoverFor = (diagnostics: LspDiagnostic[], position: LspPosition): string | null => {
  const hit = diagnostics.find((d) => rangeContains(d.range, position));
  if (!hit) return null;
  const id = hit.data?.diagnostic ?? "";
  const meta = DIAGNOSTICS_BY_ID.get(id);
  const header = meta ? `**${meta.title}**\n\n${meta.category} · ${meta.severity}` : `**${hit.code}**`;
  const body = hit.message.split("\n\nFix: ");
  return [
    header,
    "",
    body[0] ?? hit.message,
    "",
    body[1] ? `**Fix:** ${body[1]}` : "",
    "",
    `\`${hit.code}\``,
  ]
    .filter((s) => s !== "")
    .join("\n");
};

// ---------------------------------------------------------------------------
// Code actions
// ---------------------------------------------------------------------------

export interface LspTextEdit {
  range: LspRange;
  newText: string;
}
export interface LspCodeAction {
  title: string;
  kind: string;
  edit?: { changes: Record<string, LspTextEdit[]> };
}

/** The indentation of a line, so an inserted comment lines up with the code. */
const indentOf = (lineText: string | undefined): string => /^\s*/.exec(lineText ?? "")?.[0] ?? "";

/**
 * Quick fixes for the findings in `range`. The suppression action deliberately
 * inserts a `-- ` reason placeholder rather than a bare disable: node.doctor
 * raises `suppression-without-reason` for an unexplained suppression, so an
 * action that produced one would just trade a finding for another finding.
 */
export const codeActionsFor = (
  uri: string,
  diagnostics: LspDiagnostic[],
  range: LspRange,
  sourceText: string,
): LspCodeAction[] => {
  const lines = sourceText.split("\n");
  const actions: LspCodeAction[] = [];
  const seen = new Set<string>();

  for (const d of diagnostics) {
    if (d.range.start.line > range.end.line || d.range.end.line < range.start.line) continue;
    const id = d.data?.diagnostic;
    if (!id || seen.has(id + d.range.start.line)) continue;
    seen.add(id + d.range.start.line);

    const line = d.range.start.line;
    const indent = indentOf(lines[line]);
    actions.push({
      title: `node.doctor: suppress ${id} on this line (requires a reason)`,
      kind: "quickfix",
      edit: {
        changes: {
          [uri]: [
            {
              range: { start: { line, character: 0 }, end: { line, character: 0 } },
              newText: `${indent}// node-doctor-disable-next-line ${id} -- TODO: explain why this is safe\n`,
            },
          ],
        },
      },
    });
  }
  return actions;
};
