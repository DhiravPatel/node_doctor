/**
 * Generate a JSON Schema for node-doctor.config.* so editors can autocomplete
 * and validate the config (diagnostic ids, severities, tags, blocking).
 *
 *   node scripts/gen-config-schema.ts           # write schema/…
 *   node scripts/gen-config-schema.ts --check    # exit 1 if stale (CI)
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { DIAGNOSTICS } from "../src/core/registry.ts";
import { TEXT_DIAGNOSTICS } from "../src/diagnostics/secrets/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = resolve(here, "..", "schema");
const schemaPath = resolve(schemaDir, "node-doctor.config.schema.json");

const allDiagnostics = [...DIAGNOSTICS, ...TEXT_DIAGNOSTICS];
const ids = allDiagnostics.map((d) => d.id).sort();
const tags = [...new Set(allDiagnostics.flatMap((d) => d.tags ?? []))].sort();
const severity = { enum: ["off", "warn", "error"] };

const build = (): unknown => ({
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://node.doctor/schema/node-doctor.config.schema.json",
  title: "node-doctor config",
  description: "Configuration for node.doctor (node-doctor.config.json / package.json#nodeDoctor).",
  type: "object",
  additionalProperties: false,
  properties: {
    $schema: { type: "string" },
    diagnostics: {
      type: "object",
      description: "Per-diagnostic severity override.",
      propertyNames: { enum: ids },
      additionalProperties: severity,
    },
    ignoreTags: {
      type: "array",
      description: "Diagnostic families to disable.",
      items: { enum: tags },
      uniqueItems: true,
    },
    ignore: {
      type: "array",
      description: "Extra path globs to skip.",
      items: { type: "string" },
    },
    blocking: {
      description: "Default exit policy.",
      enum: ["error", "warning", "none"],
    },
    rootDir: {
      type: "string",
      description: "Redirect the scan to another directory (resolved against this file).",
    },
    overrides: {
      type: "array",
      description: "Per-path severity overrides.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["files", "diagnostics"],
        properties: {
          files: {
            oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          },
          diagnostics: {
            type: "object",
            propertyNames: { enum: ids },
            additionalProperties: severity,
          },
        },
      },
    },
  },
});

const rendered = JSON.stringify(build(), null, 2) + "\n";

if (process.argv.includes("--check")) {
  try {
    const existing = await readFile(schemaPath, "utf8");
    if (existing !== rendered) {
      process.stderr.write("config schema is stale — run `npm run gen:schema`.\n");
      process.exit(1);
    }
    process.stdout.write("config schema is up to date.\n");
  } catch {
    process.stderr.write("config schema missing — run `npm run gen:schema`.\n");
    process.exit(1);
  }
} else {
  await mkdir(schemaDir, { recursive: true });
  await writeFile(schemaPath, rendered);
  process.stdout.write(`wrote ${schemaPath} (${ids.length} diagnostics).\n`);
}
