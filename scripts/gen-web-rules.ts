/**
 * Emit web/src/data/diagnostics.json from the live registry, so the landing site's
 * diagnostic catalog is always in sync with the actual ruleset.
 *
 *   node scripts/gen-web-diagnostics.ts
 */

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { DIAGNOSTICS } from "../src/core/registry.ts";
import { CATEGORY_WEIGHTS } from "../src/core/score.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "..", "web", "src", "data");
const outFile = resolve(outDir, "diagnostics.json");

const diagnostics = DIAGNOSTICS.slice()
  .sort((a, b) => (a.id < b.id ? -1 : 1))
  .map((r) => ({
    id: r.id,
    title: r.title,
    category: r.category,
    severity: r.severity,
    scope: r.scope ?? "file",
    tags: (r.tags ?? []).slice().sort(),
    requires: r.requires ?? [],
    disabledWhen: r.disabledWhen ?? [],
    optIn: r.defaultEnabled === false,
    recommendation: r.recommendation,
  }));

const byCategory: Record<string, number> = {};
for (const r of diagnostics) byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;

const payload = {
  generatedFrom: "node.doctor registry",
  total: diagnostics.length,
  defaultOn: diagnostics.filter((r) => !r.optIn).length,
  optIn: diagnostics.filter((r) => r.optIn).length,
  byCategory,
  categoryWeights: CATEGORY_WEIGHTS,
  diagnostics,
};

const main = async (): Promise<void> => {
  await mkdir(outDir, { recursive: true });
  await writeFile(outFile, JSON.stringify(payload, null, 2) + "\n");
  process.stdout.write(`Wrote ${diagnostics.length} diagnostics to web/src/data/diagnostics.json\n`);
};

main().catch((err) => {
  process.stderr.write(`gen-web-diagnostics: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
