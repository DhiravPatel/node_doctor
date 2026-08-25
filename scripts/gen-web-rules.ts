/**
 * Emit web/src/data/diagnostics.json from the live registry, so the landing site's
 * diagnostic catalog is always in sync with the actual ruleset.
 *
 *   node scripts/gen-web-diagnostics.ts
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { DIAGNOSTICS } from "../src/core/registry.ts";
import { ALL_TEXT_DIAGNOSTICS } from "../src/diagnostics/text-diagnostics.ts";
import { CATEGORY_WEIGHTS } from "../src/core/score.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "..", "web", "src", "data");
const outFile = resolve(outDir, "diagnostics.json");

// The whole catalog, not just the AST rules: the text (Phase C) diagnostics —
// secrets, IaC, container, k8s, CI, migrations, the AI pack — are half the story
// and the landing site under-reported the count by omitting them.
const diagnostics = [...DIAGNOSTICS, ...ALL_TEXT_DIAGNOSTICS]
  .slice()
  .sort((a, b) => (a.id < b.id ? -1 : 1))
  .map((r) => ({
    id: r.id,
    title: r.title,
    category: r.category,
    severity: r.severity,
    // A text diagnostic reads whole non-source files; it has `files` but no `scope`.
    scope: "files" in r ? "text" : (r.scope ?? "file"),
    tags: (r.tags ?? []).slice().sort(),
    requires: r.requires ?? [],
    requiresAny: r.requiresAny ?? [],
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

const rendered = JSON.stringify(payload, null, 2) + "\n";

const main = async (): Promise<void> => {
  // `--check` (CI): fail if the committed data has drifted from the live registry.
  // Without this guard the landing-site data silently fell 18 diagnostics behind.
  if (process.argv.includes("--check")) {
    try {
      const existing = await readFile(outFile, "utf8");
      if (existing !== rendered) {
        process.stderr.write("web diagnostics data is stale — run `npm run gen:web`.\n");
        process.exit(1);
      }
      process.stdout.write(`web diagnostics data is up to date (${diagnostics.length}).\n`);
    } catch {
      process.stderr.write("web diagnostics data missing — run `npm run gen:web`.\n");
      process.exit(1);
    }
    return;
  }
  await mkdir(outDir, { recursive: true });
  await writeFile(outFile, rendered);
  process.stdout.write(`Wrote ${diagnostics.length} diagnostics to web/src/data/diagnostics.json\n`);
};

main().catch((err) => {
  process.stderr.write(`gen-web-diagnostics: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
