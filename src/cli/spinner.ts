/**
 * A minimal, dependency-free progress spinner. Writes only to stderr and clears
 * itself, so stdout (the JSON/report contract) stays pristine. It no-ops on a
 * non-interactive stderr or under CI, keeping captured output deterministic.
 */

const ESC = String.fromCharCode(27);
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const CLEAR_LINE = `\r${ESC}[K`;

export interface Spinner {
  /** Stop the animation and clear the line; optionally print a final status. */
  stop: (finalLine?: string) => void;
}

const NOOP: Spinner = { stop: () => {} };

export const startSpinner = (text: string): Spinner => {
  if (!process.stderr.isTTY || process.env.CI) return NOOP;

  let i = 0;
  const render = (): void => {
    process.stderr.write(`${CLEAR_LINE}${FRAMES[i % FRAMES.length]} ${text}`);
    i += 1;
  };
  render();
  const timer = setInterval(render, 80);
  // Don't keep the event loop alive just for the spinner.
  timer.unref?.();

  return {
    stop: (finalLine?: string) => {
      clearInterval(timer);
      process.stderr.write(CLEAR_LINE);
      if (finalLine) process.stderr.write(`${finalLine}\n`);
    },
  };
};
