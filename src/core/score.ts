/**
 * Local, transparent, published scoring (§12). No network call, no hidden model.
 * The formula is pure and reproducible by hand; the weights live in one block so
 * they can be tuned in one place.
 */

import type { Category, Finding, Severity } from "./types.ts";
import { CATEGORIES } from "./types.ts";

/** Weight tables. Change scoring here and nowhere else. */
export const SEVERITY_WEIGHTS: Record<Severity, number> = {
  error: 3,
  warn: 1,
};

export const CATEGORY_WEIGHTS: Record<Category, number> = {
  Security: 2.0,
  Reliability: 1.5,
  Bugs: 1.5,
  Performance: 1.0,
  Maintainability: 0.5,
};

/** Weighted points per kLOC that map to a full 100-point penalty. */
export const DENSITY_AT_ZERO = 100;

export type ScoreLabel = "healthy" | "needs work" | "critical";

export interface ScoreResult {
  score: number;
  label: ScoreLabel;
  weighted: number;
  perThousandLines: number;
  byCategory: Record<Category, number>;
}

/** The weight of a single finding. */
export const findingWeight = (severity: Severity, category: Category): number =>
  SEVERITY_WEIGHTS[severity] * CATEGORY_WEIGHTS[category];

const labelFor = (score: number): ScoreLabel =>
  score >= 75 ? "healthy" : score >= 50 ? "needs work" : "critical";

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Run the scoring model on a finding set. */
export const calculateScore = (
  findings: readonly Finding[],
  opts: { totalLines: number },
): ScoreResult => {
  const totalLines = Math.max(opts.totalLines, 1);

  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
  let weighted = 0;

  for (const d of findings) {
    weighted += findingWeight(d.severity, d.category);
    byCategory[d.category] += 1;
  }

  const perThousandLines = (weighted / totalLines) * 1000;
  const penalty = Math.min(100, (perThousandLines / DENSITY_AT_ZERO) * 100);
  const score = Math.max(0, Math.round(100 - penalty));

  return {
    score,
    label: labelFor(score),
    weighted: round2(weighted),
    perThousandLines: round2(perThousandLines),
    byCategory,
  };
};
