#!/usr/bin/env node
/**
 * node-doctor CLI launcher.
 *
 * This shim is shipped verbatim (never compiled). It runs the built `dist/`
 * entry in a published install, and falls back to the TypeScript source in a
 * dev checkout (Node >= 22.6 strips types at runtime). Keeping the launcher in
 * plain JS means `npx node-doctor` has zero transpile cost on the hot path.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distEntry = join(here, "..", "dist", "cli", "run.js");
const srcEntry = join(here, "..", "src", "cli", "run.ts");
const entry = existsSync(distEntry) ? distEntry : srcEntry;

try {
  const mod = await import(pathToFileURL(entry).href);
  const code = await mod.main(process.argv.slice(2));
  // Drain before exiting: stdout is async on a pipe, so a bare process.exit()
  // discards whatever is still buffered and truncates a large --json report.
  await mod.exitAfterFlush(typeof code === "number" ? code : 0);
} catch (err) {
  if (err && err.code === "ERR_UNKNOWN_FILE_EXTENSION") {
    process.stderr.write(
      "node-doctor: this Node build cannot run the TypeScript source directly.\n" +
        "Run `npm run build` first, or use Node >= 20.19 with the published package.\n",
    );
    process.exit(2);
  }
  process.stderr.write(`node-doctor: fatal: ${err && err.stack ? err.stack : String(err)}\n`);
  process.exit(2);
}
