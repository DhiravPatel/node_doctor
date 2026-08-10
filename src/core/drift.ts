/**
 * §104 — "why did this pass yesterday and fail today?", answered from the two
 * artifacts alone.
 *
 * The provenance record has shipped for a while: every report carries the tool
 * version, the ruleset hash, the config hash and the capability set. What had
 * never been built is the thing the record exists FOR. Nothing read it back, so
 * the question it was designed to answer still had to be answered by hand.
 *
 * That question is the most common one any analyzer gets asked, and it has
 * exactly one useful shape: **did the CODE change, or did the TOOL change?** A
 * CI failure means something different in each case, and the difference is not
 * visible in a finding diff — `node-doctor delta` will faithfully report six new
 * findings whether they came from six new bugs or from one new rule.
 *
 * This reads two reports and attributes the difference:
 *
 *   - the tool version moved;
 *   - the RULESET moved, and which rules were added, removed, or re-graded —
 *     the artifact now records the exact `id:severity` list its hash is built
 *     from, so this names them rather than saying "something changed";
 *   - the config moved;
 *   - the CAPABILITIES moved, which silently turns whole gated packs on and off
 *     — adding a Prisma dependency enables every `requires: ["prisma"]` rule,
 *     and nothing about that looks like a tooling change from the outside;
 *   - the scan did not cover the same ground: a different file count, or a
 *     baseline taken from an INCOMPLETE scan, which makes the comparison
 *     unsound rather than merely different.
 *
 * When none of those moved, the code changed — and that is the answer worth
 * having, because it is the only case where the finding delta means what it
 * appears to mean.
 *
 * PRECISION MODEL. Every statement here is a fact read out of the two files. It
 * infers nothing, ranks nothing, and where a report predates a field it says the
 * comparison is unavailable rather than assuming equality — an older artifact
 * has no `ruleset`, and treating that as "the ruleset did not change" would be
 * exactly the wrong answer.
 */

import type { ScanReport } from "./scan.ts";

export type DriftCause =
  | "tool-version"
  | "ruleset"
  | "config"
  | "capabilities"
  | "coverage"
  | "incomplete-scan"
  | "code";

export interface RulesetChange {
  added: string[];
  removed: string[];
  /** Rules present in both, at a different severity. */
  regraded: Array<{ id: string; from: string; to: string }>;
  /** True when either artifact predates the recorded ruleset list. */
  comparable: boolean;
}

export interface DriftAttribution {
  cause: DriftCause;
  /** One sentence: what moved, and what it means for the finding delta. */
  message: string;
}

export interface DriftReport {
  /** The causes found, in the order they are worth reading. */
  causes: DriftAttribution[];
  /**
   * True when nothing about the tool, its rules, its config, its capabilities or
   * its coverage moved — so a finding difference is a real code change.
   */
  codeOnly: boolean;
  toolVersion: { baseline: string; current: string; changed: boolean };
  ruleset: RulesetChange;
  capabilities: { added: string[]; removed: string[] };
  coverage: {
    baselineFiles: number;
    currentFiles: number;
    baselineComplete: boolean;
    currentComplete: boolean;
  };
  score: { baseline: number; current: number; delta: number };
  findings: { baseline: number; current: number; delta: number };
}

/** Split a recorded `id:severity` entry. Ids never contain a colon. */
const splitEntry = (entry: string): { id: string; severity: string } => {
  const at = entry.lastIndexOf(":");
  return at === -1 ? { id: entry, severity: "" } : { id: entry.slice(0, at), severity: entry.slice(at + 1) };
};

const diffRuleset = (baseline: readonly string[] | undefined, current: readonly string[] | undefined): RulesetChange => {
  // An artifact from before the ruleset list existed cannot be compared, and
  // saying "unchanged" would be precisely the wrong answer.
  if (!Array.isArray(baseline) || !Array.isArray(current) || baseline.length === 0 || current.length === 0) {
    return { added: [], removed: [], regraded: [], comparable: false };
  }
  const before = new Map(baseline.map((e) => [splitEntry(e).id, splitEntry(e).severity]));
  const after = new Map(current.map((e) => [splitEntry(e).id, splitEntry(e).severity]));

  const added: string[] = [];
  const removed: string[] = [];
  const regraded: Array<{ id: string; from: string; to: string }> = [];
  for (const [id, severity] of after) {
    const was = before.get(id);
    if (was === undefined) added.push(id);
    else if (was !== severity) regraded.push({ id, from: was, to: severity });
  }
  for (const id of before.keys()) if (!after.has(id)) removed.push(id);

  added.sort();
  removed.sort();
  regraded.sort((a, b) => (a.id < b.id ? -1 : 1));
  return { added, removed, regraded, comparable: true };
};

const setDiff = (baseline: readonly string[], current: readonly string[]): { added: string[]; removed: string[] } => {
  const before = new Set(baseline);
  const after = new Set(current);
  return {
    added: current.filter((c) => !before.has(c)).sort(),
    removed: baseline.filter((b) => !after.has(b)).sort(),
  };
};

const list = (items: readonly string[], limit = 6): string =>
  items.length <= limit
    ? items.map((i) => `\`${i}\``).join(", ")
    : `${items.slice(0, limit).map((i) => `\`${i}\``).join(", ")} and ${items.length - limit} more`;

export const explainDrift = (baseline: ScanReport, current: ScanReport): DriftReport => {
  const causes: DriftAttribution[] = [];

  const toolChanged = baseline.provenance.toolVersion !== current.provenance.toolVersion;
  if (toolChanged) {
    causes.push({
      cause: "tool-version",
      message: `node.doctor moved from ${baseline.provenance.toolVersion} to ${current.provenance.toolVersion}. Rules can be added, tightened or corrected in any release, so a finding difference across a version bump is not evidence of a code change.`,
    });
  }

  const ruleset = diffRuleset(baseline.provenance.ruleset, current.provenance.ruleset);
  const rulesetHashChanged = baseline.provenance.rulesetHash !== current.provenance.rulesetHash;
  if (rulesetHashChanged) {
    if (!ruleset.comparable) {
      causes.push({
        cause: "ruleset",
        message:
          "The active ruleset changed, but one of these reports predates the recorded rule list, so which rules moved cannot be recovered from the artifacts. Re-run the baseline with this version to get a nameable answer next time.",
      });
    } else {
      const parts: string[] = [];
      if (ruleset.added.length > 0) parts.push(`${ruleset.added.length} added (${list(ruleset.added)})`);
      if (ruleset.removed.length > 0) parts.push(`${ruleset.removed.length} removed (${list(ruleset.removed)})`);
      if (ruleset.regraded.length > 0) {
        parts.push(
          `${ruleset.regraded.length} re-graded (${list(ruleset.regraded.map((r) => `${r.id}: ${r.from}→${r.to}`))})`,
        );
      }
      causes.push({
        cause: "ruleset",
        message: `The active ruleset changed: ${parts.join("; ")}. Findings from an added or re-graded rule are new to the REPORT, not to the code.`,
      });
    }
  }

  if (baseline.provenance.configHash !== current.provenance.configHash) {
    causes.push({
      cause: "config",
      message:
        "The resolved configuration changed. Severity overrides, ignore globs, `--ignore-tag` and enabled/disabled rules all live here, so a finding can appear or vanish with no edit to the code at all.",
    });
  }

  const capabilities = setDiff(baseline.provenance.capabilities, current.provenance.capabilities);
  if (capabilities.added.length > 0 || capabilities.removed.length > 0) {
    const parts: string[] = [];
    if (capabilities.added.length > 0) parts.push(`gained ${list(capabilities.added)}`);
    if (capabilities.removed.length > 0) parts.push(`lost ${list(capabilities.removed)}`);
    causes.push({
      cause: "capabilities",
      message: `The project's detected capabilities changed — it ${parts.join(" and ")}. Whole packs are gated on these, so adding a dependency silently switches on every rule that requires it.`,
    });
  }

  const baselineFiles = baseline.project.analyzedFileCount;
  const currentFiles = current.project.analyzedFileCount;
  if (baselineFiles !== currentFiles) {
    causes.push({
      cause: "coverage",
      message: `The scans covered different amounts of code: ${baselineFiles} file(s) then, ${currentFiles} now. Some of the finding difference is simply that there is more or less to look at.`,
    });
  }

  if (!baseline.project.complete || !current.project.complete) {
    const which = !baseline.project.complete && !current.project.complete ? "Both scans" : !baseline.project.complete ? "The baseline scan" : "The current scan";
    causes.push({
      cause: "incomplete-scan",
      message: `${which} did not finish cleanly — a parse failure or a timeout means part of the tree was never analysed. A finding that is absent from an incomplete scan was not necessarily fixed, so this comparison is unsound rather than merely different.`,
    });
  }

  const codeOnly = causes.length === 0;
  if (codeOnly) {
    causes.push({
      cause: "code",
      message:
        "Nothing about the tool, its rules, its configuration, its capabilities or its coverage moved. The difference is the code — which means the finding delta means exactly what it appears to mean.",
    });
  }

  return {
    causes,
    codeOnly,
    toolVersion: {
      baseline: baseline.provenance.toolVersion,
      current: current.provenance.toolVersion,
      changed: toolChanged,
    },
    ruleset,
    capabilities,
    coverage: {
      baselineFiles,
      currentFiles,
      baselineComplete: baseline.project.complete,
      currentComplete: current.project.complete,
    },
    score: {
      baseline: baseline.score.score,
      current: current.score.score,
      delta: current.score.score - baseline.score.score,
    },
    findings: {
      baseline: baseline.findings.length,
      current: current.findings.length,
      delta: current.findings.length - baseline.findings.length,
    },
  };
};
