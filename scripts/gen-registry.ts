/**
 * Registry codegen. Scans src/diagnostics/<bucket>/*.ts, imports each diagnostic export, and
 * emits src/core/registry.ts. Adding a diagnostic becomes: create one file, re-run
 * `npm run gen:registry`.
 *
 *   node scripts/gen-registry.ts           # write registry.ts
 *   node scripts/gen-registry.ts --check   # exit 1 if registry.ts is stale (CI)
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const rulesDir = resolve(here, "..", "src", "diagnostics");
const registryPath = resolve(here, "..", "src", "core", "registry.ts");

interface Discovered {
  bucket: string;
  file: string; // basename without extension
  exportName: string;
  id: string;
}

const isRuleObject = (value: unknown): value is { id: string; create: unknown } =>
  !!value &&
  typeof value === "object" &&
  typeof (value as { id?: unknown }).id === "string" &&
  typeof (value as { create?: unknown }).create === "function";

const discover = async (): Promise<Discovered[]> => {
  const found: Discovered[] = [];
  const buckets = (await readdir(rulesDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  for (const bucket of buckets) {
    const bucketDir = join(rulesDir, bucket);
    const files = (await readdir(bucketDir))
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .sort();

    for (const file of files) {
      const mod = (await import(pathToFileURL(join(bucketDir, file)).href)) as Record<string, unknown>;
      for (const [exportName, value] of Object.entries(mod)) {
        if (isRuleObject(value)) {
          found.push({ bucket, file: file.replace(/\.ts$/, ""), exportName, id: value.id });
        }
      }
    }
  }
  return found;
};

const render = (diagnostics: Discovered[]): string => {
  const byBucket = new Map<string, Discovered[]>();
  for (const diagnostic of diagnostics) {
    const list = byBucket.get(diagnostic.bucket) ?? [];
    list.push(diagnostic);
    byBucket.set(diagnostic.bucket, list);
  }
  for (const list of byBucket.values()) list.sort((a, b) => (a.id < b.id ? -1 : 1));
  const buckets = [...byBucket.keys()].sort();

  const importLines: string[] = [];
  const arrayLines: string[] = [];
  for (const bucket of buckets) {
    importLines.push(`// ${bucket}`);
    arrayLines.push(`  // ${bucket}`);
    for (const diagnostic of byBucket.get(bucket)!) {
      importLines.push(`import { ${diagnostic.exportName} } from "../diagnostics/${bucket}/${diagnostic.file}.ts";`);
      arrayLines.push(`  ${diagnostic.exportName},`);
    }
  }

  return `// ---------------------------------------------------------------------------
// GENERATED FILE — do not edit by hand.
// Regenerate with \`npm run gen:registry\` (scripts/gen-registry.ts).
// The generator scans src/diagnostics/<bucket>/*.ts, imports each diagnostic export, and
// emits this list, sorted by bucket then diagnostic id.
// ---------------------------------------------------------------------------

import type { Diagnostic } from "./types.ts";

${importLines.join("\n")}

/** Every diagnostic known to node.doctor, in a stable declaration order. */
export const DIAGNOSTICS: Diagnostic[] = [
${arrayLines.join("\n")}
];

/** Diagnostic id → diagnostic, for catalogs, config UIs, and lookups. */
export const DIAGNOSTICS_BY_ID: Map<string, Diagnostic> = new Map(DIAGNOSTICS.map((diagnostic) => [diagnostic.id, diagnostic]));
`;
};

const main = async (): Promise<number> => {
  const diagnostics = await discover();
  const content = render(diagnostics);
  const check = process.argv.includes("--check");

  if (check) {
    let current = "";
    try {
      current = await readFile(registryPath, "utf8");
    } catch {
      /* missing → stale */
    }
    if (current !== content) {
      process.stderr.write("registry.ts is stale — run `npm run gen:registry`.\n");
      return 1;
    }
    process.stdout.write(`registry.ts is up to date (${diagnostics.length} diagnostics).\n`);
    return 0;
  }

  await writeFile(registryPath, content);
  process.stdout.write(`Wrote ${diagnostics.length} diagnostics to src/core/registry.ts\n`);
  return 0;
};

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`gen-registry: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(2);
  },
);
