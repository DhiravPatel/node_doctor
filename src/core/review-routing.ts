/**
 * §163 — Blast-Radius-Aware Review Routing (`node-doctor review`).
 *
 * "Who should review this?" is normally a guess, and the guess is usually wrong
 * in the same direction: a one-line change to a leaf gets the same three
 * reviewers as a one-line change to the module forty routes depend on. The
 * import graph already knows which is which, and CODEOWNERS already knows who
 * owns what — this joins them.
 *
 * For a set of changed files it answers three questions:
 *
 *   1. HOW FAR does this reach? (§120's blast radius: transitive dependents and
 *      the routes among them)
 *   2. WHO must know? (§89's CODEOWNERS resolution, applied not just to the
 *      changed files but to everything downstream of them — the people whose
 *      code this can break, who would otherwise never see the PR)
 *   3. HOW MUCH scrutiny? A depth level derived from reach, not from taste.
 *
 * PRECISION MODEL. Like §160, this cannot produce a false positive in the
 * finding sense: it emits no findings and suppresses none. It routes attention.
 * The one claim it does make — the review level — is derived from counted graph
 * facts (dependents, route-bearing dependents, hub status) with the thresholds
 * stated in the output, so a reader can always see why a change was escalated
 * rather than having to trust it.
 *
 * A file the graph does not contain is reported as unresolved rather than
 * silently scored zero: "I could not see this change" and "this change is safe"
 * must never look the same.
 *
 * Deterministic: owners sorted, files sorted, level a pure function of counts.
 */

import type { NodeDoctorConfig } from "./config.ts";
import { buildImpactGraph, computeImpact } from "./impact.ts";
import { loadCodeowners, ownersFor, type OwnerRule } from "./ownership.ts";
import { buildArchitectureReport } from "./architecture.ts";

/** How much scrutiny the change's reach justifies. */
export type ReviewLevel = "light" | "standard" | "senior";

export interface ReviewRouting {
  /** Changed files that were found in the import graph. */
  changed: string[];
  /** Changed files the graph does not contain — unknown reach, not zero reach. */
  unresolved: string[];
  /** Distinct files a change to `changed` can reach. */
  reachedCount: number;
  /**
   * Dependents containing request-handler-shaped functions. Named for what it
   * actually measures: `collectRequestHandlers` recognizes the `(req, res)`
   * SHAPE, which is broader than "registers a route" — a middleware factory or
   * a handler-shaped callback counts. It is a good attention signal and a poor
   * census, so it informs the level but never drives a senior escalation alone.
   */
  handlerBearingFiles: string[];
  /** @deprecated Use `handlerBearingFiles` — kept so existing JSON consumers
   *  do not break. Same value, honest name. */
  routesAtRisk: string[];
  /** Changed files that are hub modules (very high fan-in). */
  hubsTouched: string[];
  /** Everyone who owns a changed file OR anything downstream of it, sorted. */
  reviewers: string[];
  /** Owners of the changed files themselves — the minimum set. */
  directOwners: string[];
  level: ReviewLevel;
  /** The counted facts behind `level`, so the escalation is auditable. */
  rationale: string[];
}

/** Reach at which a change stops being routine. Stated in the output. */
const STANDARD_REACH = 5;
const SENIOR_REACH = 25;
/**
 * Handler-bearing dependents alone no longer escalate to senior: the underlying
 * detection matches a SHAPE, so a large count can be middleware factories rather
 * than routes. Reach and hub status — both exact graph facts — remain the
 * escalation triggers; handler files raise a light review to standard, which is
 * the level this signal can actually support.
 */
const STANDARD_HANDLER_FILES = 1;

export const buildReviewRouting = async (
  rootDirectory: string,
  changedFiles: readonly string[],
  options: { config?: NodeDoctorConfig } = {},
): Promise<ReviewRouting> => {
  const graph = await buildImpactGraph(rootDirectory, { config: options.config });
  const impact = computeImpact(graph, changedFiles);

  const rules: OwnerRule[] = await loadCodeowners(rootDirectory);
  const architecture = await buildArchitectureReport(rootDirectory, { config: options.config });
  const hubPaths = new Set(architecture.hubs.map((h) => h.file));

  // Owners of the changed files, and of everything downstream: a change that
  // breaks someone else's module should reach that someone, not just its author.
  const directOwners = new Set<string>();
  for (const file of impact.changed) for (const o of ownersFor(file, rules)) directOwners.add(o);

  const reviewers = new Set<string>(directOwners);
  for (const dependent of impact.dependents) {
    for (const o of ownersFor(dependent.normalizedFilePath, rules)) reviewers.add(o);
  }

  const hubsTouched = impact.changed.filter((f) => hubPaths.has(f)).sort();
  const handlerBearingFiles = [...impact.routeBearingFiles].sort();

  // The level is a function of counted facts; every input to it is reported.
  const rationale: string[] = [];
  let level: ReviewLevel = "light";
  if (impact.reachedCount >= SENIOR_REACH) {
    level = "senior";
    rationale.push(`reaches ${impact.reachedCount} files (≥ ${SENIOR_REACH})`);
  } else if (impact.reachedCount >= STANDARD_REACH) {
    level = "standard";
    rationale.push(`reaches ${impact.reachedCount} files (≥ ${STANDARD_REACH})`);
  } else {
    rationale.push(`reaches ${impact.reachedCount} file(s)`);
  }
  if (handlerBearingFiles.length >= STANDARD_HANDLER_FILES) {
    if (level === "light") level = "standard";
    rationale.push(
      `${handlerBearingFiles.length} file(s) with request-handler-shaped code affected` +
        " (shape-matched, so this raises the level but never escalates to senior on its own)",
    );
  }
  if (hubsTouched.length > 0) {
    level = "senior";
    rationale.push(`touches ${hubsTouched.length} hub module(s): ${hubsTouched.join(", ")}`);
  }
  if (impact.unresolved.length > 0) {
    // Unknown reach is not safe reach — say so rather than scoring it zero.
    rationale.push(`${impact.unresolved.length} changed file(s) not in the import graph — reach unknown`);
  }

  return {
    changed: impact.changed,
    unresolved: impact.unresolved,
    reachedCount: impact.reachedCount,
    handlerBearingFiles,
    routesAtRisk: handlerBearingFiles,
    hubsTouched,
    reviewers: [...reviewers].sort(),
    directOwners: [...directOwners].sort(),
    level,
    rationale,
  };
};
