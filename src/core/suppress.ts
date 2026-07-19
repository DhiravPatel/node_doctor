/**
 * Inline suppression comments.
 *
 *   // node-doctor-disable-next-line <diagnostic?> -- <reason>
 *   // node-doctor-disable-line <diagnostic?> -- <reason>
 *   /* node-doctor-disable <diagnostic?> -- <reason> *␟/    (block start)
 *   /* node-doctor-enable  <diagnostic?> *␟/                (block end)
 *
 * A **reason is mandatory** on every `disable` form. A disable without one still
 * suppresses, but the engine raises a `suppression-without-reason` finding, so
 * the escape hatch can never hide a problem silently (§17, guardrail).
 */

import type { Locator } from "./location.ts";

interface Comment {
  type: string;
  value: string;
  start: number;
  end: number;
}

type Kind = "next-line" | "line" | "disable" | "enable";

interface Directive {
  kind: Kind;
  /** null → applies to all diagnostics. */
  diagnostics: Set<string> | null;
  reason: string | null;
  line: number;
  column: number;
}

// A simple anchored head match; the diagnostics list and reason are split by hand
// afterwards (a single mega-regex risks catastrophic backtracking).
const DIRECTIVE_HEAD_RE = /node-doctor-(disable-next-line|disable-line|disable|enable)\b/;

const parseRuleList = (raw: string | undefined): Set<string> | null => {
  if (!raw) return null;
  const ids = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^node-doctor\//, ""));
  return ids.length > 0 ? new Set(ids) : null;
};

const kindOf = (token: string): Kind => {
  switch (token) {
    case "disable-next-line":
      return "next-line";
    case "disable-line":
      return "line";
    case "enable":
      return "enable";
    default:
      return "disable";
  }
};

/** Parse suppression directives out of a file's comments. */
export const parseDirectives = (comments: Comment[], locate: Locator): Directive[] => {
  const directives: Directive[] = [];
  for (const comment of comments) {
    const text = comment.value.trim();
    const head = DIRECTIVE_HEAD_RE.exec(text);
    if (!head) continue;
    const kind = kindOf(head[1]!);
    const rest = text.slice(head.index + head[0].length);
    const dash = rest.indexOf("--");
    const rulesPart = dash >= 0 ? rest.slice(0, dash) : rest;
    const reason = dash >= 0 ? rest.slice(dash + 2).trim() || null : null;
    const diagnostics = parseRuleList(rulesPart);
    const { line, column } = locate(comment.start);
    directives.push({ kind, diagnostics, reason, line, column });
  }
  return directives;
};

export interface FindingLike {
  diagnostic: string;
  line: number;
}

export interface SuppressionResult<T extends FindingLike> {
  kept: T[];
  suppressed: T[];
  /** Directives that suppressed something but lacked a reason. */
  reasonMissing: Array<{ line: number; column: number }>;
}

const applies = (directive: Directive, ruleId: string): boolean =>
  directive.diagnostics === null || directive.diagnostics.has(ruleId);

/**
 * Partition findings into kept vs suppressed, and surface any reason-less
 * directives that actually suppressed a finding.
 */
export const applySuppressions = <T extends FindingLike>(
  findings: T[],
  directives: Directive[],
): SuppressionResult<T> => {
  const nextLine = directives.filter((d) => d.kind === "next-line");
  const sameLine = directives.filter((d) => d.kind === "line");
  const blocks = directives.filter((d) => d.kind === "disable" || d.kind === "enable");

  // Build block ranges per diagnostic scope, in source order.
  const blockDisabled = (ruleId: string, line: number): Directive | null => {
    let active: Directive | null = null;
    for (const d of blocks) {
      if (d.line > line) break;
      if (!applies(d, ruleId)) continue;
      active = d.kind === "disable" ? d : null;
    }
    return active;
  };

  const kept: T[] = [];
  const suppressed: T[] = [];
  const reasonMissingSet = new Map<string, { line: number; column: number }>();

  const markReason = (d: Directive): void => {
    if (d.reason === null) {
      reasonMissingSet.set(`${d.line}:${d.column}`, { line: d.line, column: d.column });
    }
  };

  for (const diag of findings) {
    let by: Directive | null = null;

    for (const d of nextLine) {
      if (d.line + 1 === diag.line && applies(d, diag.diagnostic)) {
        by = d;
        break;
      }
    }
    if (!by) {
      for (const d of sameLine) {
        if (d.line === diag.line && applies(d, diag.diagnostic)) {
          by = d;
          break;
        }
      }
    }
    if (!by) by = blockDisabled(diag.diagnostic, diag.line);

    if (by) {
      suppressed.push(diag);
      markReason(by);
    } else {
      kept.push(diag);
    }
  }

  return {
    kept,
    suppressed,
    reasonMissing: [...reasonMissingSet.values()].sort((a, b) => a.line - b.line || a.column - b.column),
  };
};
