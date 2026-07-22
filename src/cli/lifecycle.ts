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
};

/**
 * Exit only once stdout/stderr have actually drained.
 *
 * `process.stdout.write()` is asynchronous when stdout is a **pipe** (it is
 * synchronous for files and TTYs), so `process.exit()` immediately after writing
 * discards whatever is still buffered. That silently truncated `--json` at a pipe
 * buffer boundary — `node-doctor . --json | jq` on a large repo emitted 64 KB of a
 * 400 KB report and `jq` failed on invalid JSON, while the same run redirected to a
 * file was complete. Draining first keeps the prompt exit without the data loss.
 */
export const exitAfterFlush = async (code: number): Promise<never> => {
  const drain = (stream: NodeJS.WriteStream): Promise<void> =>
    new Promise((done) => {
      if (stream.writableLength === 0 || stream.writableEnded) return done();
      stream.write("", () => done());
    });
  try {
    await Promise.all([drain(process.stdout), drain(process.stderr)]);
  } catch {
    /* a closed pipe (EPIPE) is already handled above — never block the exit */
  }
  process.exit(code);

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
