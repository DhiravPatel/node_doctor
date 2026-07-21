/**
 * CLI process-lifecycle hardening.
 *
 * A static-analysis CLI is routinely piped into `head`, interrupted with Ctrl-C,
 * and run on Windows terminals that default to a non-UTF-8 code page. Without
 * this, `node-doctor . | head` prints an EPIPE stack trace, Ctrl-C leaves a
 * partial line, and box-drawing glyphs render as mojibake on Windows.
 */

import { spawnSync } from "node:child_process";

let hardened = false;

/**
 * Install the lifecycle guards. Idempotent — safe to call once at startup.
 * Returns nothing; wiring is done via process-level listeners.
 */
export const hardenProcess = (): void => {
  if (hardened) return;
  hardened = true;

  // Exit cleanly (0) when the reader closes the pipe early, e.g. `… | head`.
  const onStreamError = (err: NodeJS.ErrnoException): void => {
    if (err && err.code === "EPIPE") {
      process.exit(0);
    }
    // Any other stream error is unexpected — surface it as a tool error.
    process.exit(2);
  };
  process.stdout.on("error", onStreamError);
  process.stderr.on("error", onStreamError);

  // Graceful termination with the conventional 128+signal exit codes.
  process.once("SIGINT", () => process.exit(130));
  process.once("SIGTERM", () => process.exit(143));

  // Windows consoles often default to a legacy code page (e.g. 437/1252) that
  // mangles the box-drawing and glyph characters in the terminal report. Switch
  // the active console to UTF-8 (65001). Best-effort; ignored if unavailable.
  if (process.platform === "win32") {
    try {
      spawnSync("chcp", ["65001"], { stdio: "ignore", shell: true });
    } catch {
      /* non-fatal: output may render with replacement characters */
    }
  }
};
