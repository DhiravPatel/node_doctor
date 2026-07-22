/**
 * CODEOWNERS routing and PR risk scoring (§89, §90).
 *
 * A CI comment listing forty findings across nine teams gets read by nobody. If
 * the tool can say *which team owns each one*, the comment becomes nine small,
 * actionable messages instead of one large ignorable one. And a single risk
 * number lets a reviewer triage before reading anything at all.
 *
 * CODEOWNERS parsing follows GitHub's semantics: last matching rule wins, and a
 * pattern with no owners deliberately clears ownership.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Finding } from "./types.ts";
import { CATEGORY_WEIGHTS } from "./score.ts";

/** The paths GitHub looks in, in order. */
const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

export interface OwnerRule {
  pattern: string;
  owners: string[];
}

/**
 * Translate a CODEOWNERS pattern to a matcher. Rules follow gitignore syntax:
 * a leading `/` anchors to the repo root, a trailing `/` matches a directory's
 * contents, and a bare name matches at any depth.
 */
const patternToRegExp = (pattern: string): RegExp => {
  let p = pattern.trim();
  const anchored = p.startsWith("/");
  if (anchored) p = p.slice(1);
  if (p.endsWith("/")) p = p.slice(0, -1);

  // Walk the pattern so `**`, `*` and `?` get distinct meanings — `*` must not
  // cross a path separator, `**` must.
  let body = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "*" && p[i + 1] === "*") {
      // `**` spans directories *including none*: `a/**/b` matches `a/b` as well as
      // `a/x/y/b`. So the token must absorb the following separator rather than
      // leaving it literal, which would require at least one intermediate segment.
      if (p[i + 2] === "/") {
        body += "(?:.*/)?";
        i += 2;
      } else {
        body += ".*";
        i++;
      }
    } else if (c === "*") {
      body += "[^/]*";
    } else if (c === "?") {
      body += "[^/]";
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      body += `\\${c}`;
    } else {
      body += c;
    }
  }

  // Only a directory-shaped rule covers its contents. GitHub documents `docs/*` as
  // matching `docs/getting-started.md` but NOT `docs/build-app/troubleshooting.md`,
  // so appending the contents suffix unconditionally would make `docs/*` — and the
  // ubiquitous monorepo `packages/*` — swallow the whole subtree and outrank the
  // catch-all that should have won.
  const lastSegment = p.split("/").pop() ?? "";
  const isDirRule = pattern.trim().endsWith("/") || !/[*?]/.test(lastSegment);
  const prefix = anchored ? "^" : "^(?:.*/)?";
  return new RegExp(`${prefix}${body}${isDirRule ? "(?:/.*)?" : ""}$`);
};

/** Parse CODEOWNERS text into rules, in file order. */
export const parseCodeowners = (text: string): OwnerRule[] => {
  const rules: OwnerRule[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line.length === 0) continue;
    const parts = line.split(/\s+/);
    const pattern = parts[0]!;
    // A pattern with no owners clears ownership for those paths — keep it.
    rules.push({ pattern, owners: parts.slice(1).filter((o) => o.startsWith("@") || o.includes("@")) });
  }
  return rules;
};

/** Read CODEOWNERS from the conventional locations; [] when absent. */
export const loadCodeowners = async (rootDirectory: string): Promise<OwnerRule[]> => {
  for (const rel of CODEOWNERS_PATHS) {
    try {
      return parseCodeowners(await readFile(join(rootDirectory, rel), "utf8"));
    } catch {
      /* try the next location */
    }
  }
  return [];
};

/** Owners for a path — GitHub semantics: the LAST matching rule wins. */
export const ownersFor = (normalizedFilePath: string, rules: OwnerRule[]): string[] => {
  let owners: string[] = [];
  for (const rule of rules) {
    if (patternToRegExp(rule.pattern).test(normalizedFilePath)) owners = rule.owners;
  }
  return owners;
};

export interface OwnedFindings {
  owner: string;
  findings: Finding[];
}

/**
 * Group findings by owning team. Unowned findings are collected under
 * `"(unowned)"` rather than dropped — silently hiding a finding because nobody
 * claimed the file is exactly how it goes unfixed.
 */
export const groupByOwner = (findings: Finding[], rules: OwnerRule[]): OwnedFindings[] => {
  const byOwner = new Map<string, Finding[]>();
  for (const f of findings) {
    const owners = ownersFor(f.normalizedFilePath, rules);
    const keys = owners.length > 0 ? owners : ["(unowned)"];
    for (const key of keys) {
      const list = byOwner.get(key) ?? [];
      list.push(f);
      byOwner.set(key, list);
    }
  }
  return [...byOwner.entries()]
    .map(([owner, fs]) => ({ owner, findings: fs }))
    .sort((a, b) => b.findings.length - a.findings.length || (a.owner < b.owner ? -1 : 1));
};

// ---------------------------------------------------------------------------
// §90 — PR risk score
// ---------------------------------------------------------------------------

export type RiskLevel = "low" | "moderate" | "high" | "severe";

export interface PrRisk {
  score: number;
  level: RiskLevel;
  /** Plain-language reasons, most significant first. */
  reasons: string[];
  filesTouched: number;
  introduced: number;
}

/**
 * Score how dangerous a change is, from the findings it introduced and how much
 * surface it touches. Deliberately simple and explainable — a reviewer must be
 * able to see *why* it scored what it did, or they will ignore the number.
 */
export const scorePrRisk = (introduced: Finding[], filesTouched: number): PrRisk => {
  const reasons: string[] = [];
  let score = 0;

  const errors = introduced.filter((f) => f.severity === "error");
  const security = introduced.filter((f) => f.category === "Security");
  const highConfidence = introduced.filter((f) => f.confidence === "high");

  // An unknown category must not produce NaN — that would surface as "low risk"
  // and quietly wave through the exact change this is meant to stop.
  for (const f of introduced) score += (CATEGORY_WEIGHTS[f.category] ?? 1) * (f.severity === "error" ? 2 : 1);
  // Breadth matters independently: a wide change is harder to review well.
  score += Math.min(10, filesTouched * 0.5);

  if (security.length > 0) reasons.push(`${security.length} security finding(s) introduced`);
  if (errors.length > 0) reasons.push(`${errors.length} error-severity finding(s) introduced`);
  if (highConfidence.length > 0) reasons.push(`${highConfidence.length} high-confidence finding(s) — safe to act on`);
  if (filesTouched > 20) reasons.push(`${filesTouched} files touched — broad surface`);
  // Describe the diff, not the absence of a matched bucket: the score already
  // includes these findings, so claiming "none" contradicts the number beside it.
  if (reasons.length === 0) {
    reasons.push(
      introduced.length === 0 ? "no findings introduced" : `${introduced.length} finding(s) introduced`,
    );
  }

  const rounded = Math.round(score * 10) / 10;
  const level: RiskLevel =
    security.length > 0 || rounded >= 20 ? "severe" : rounded >= 10 ? "high" : rounded >= 3 ? "moderate" : "low";

  return { score: rounded, level, reasons, filesTouched, introduced: introduced.length };
};
