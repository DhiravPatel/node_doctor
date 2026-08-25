/**
 * Test helpers. `expectFires` / `expectSilent` lint one source string against a
 * single diagnostic and assert on the finding count. They apply capability gating so
 * gating can be tested too: a diagnostic whose `requires` are unmet returns no
 * findings (as the real selector would filter it out).
 */

import assert from "node:assert/strict";
import { lintSource } from "../src/core/scan.ts";
import { DIAGNOSTICS_BY_ID } from "../src/core/registry.ts";
import { capabilitiesSatisfied } from "../src/core/project.ts";
import type { Finding, Diagnostic } from "../src/core/types.ts";

export interface LintOpts {
  filePath?: string;
  capabilities?: Iterable<string>;
}

/** Default capabilities that satisfy a diagnostic's `requires` (so it runs). */
const defaultCaps = (diagnostic: Diagnostic): Set<string> =>
  new Set<string>(["node", "esm", ...(diagnostic.requires ?? []), ...(diagnostic.requiresAny ?? []).slice(0, 1)]);

export const findingsFor = (ruleId: string, source: string, opts: LintOpts = {}): Finding[] => {
  const diagnostic = DIAGNOSTICS_BY_ID.get(ruleId);
  if (!diagnostic) throw new Error(`unknown diagnostic: ${ruleId}`);
  const capabilities = opts.capabilities ? new Set(opts.capabilities) : defaultCaps(diagnostic);

  // Mirror the real selector: an unsatisfied gate means the diagnostic never runs.
  if (!capabilitiesSatisfied(diagnostic, capabilities)) return [];

  const { findings } = lintSource({
    filePath: opts.filePath ?? "test.ts",
    sourceText: source,
    diagnostics: [diagnostic],
    capabilities,
  });
  return findings.filter((d) => d.diagnostic === ruleId);
};

export const expectFires = (ruleId: string, source: string, opts: LintOpts = {}): Finding[] => {
  const found = findingsFor(ruleId, source, opts);
  assert.ok(
    found.length > 0,
    `expected ${ruleId} to FIRE, but got 0 findings on:\n${source}`,
  );
  return found;
};

export const expectSilent = (ruleId: string, source: string, opts: LintOpts = {}): void => {
  const found = findingsFor(ruleId, source, opts);
  assert.equal(
    found.length,
    0,
    `expected ${ruleId} to STAY SILENT, but got ${found.length}:\n` +
      found.map((d) => `  - ${d.message} @ ${d.line}:${d.column}`).join("\n") +
      `\n--- source ---\n${source}`,
  );
};
