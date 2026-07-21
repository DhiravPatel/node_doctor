/**
 * Classify a source file by role so the engine can relax noise diagnostics that
 * are legitimate in some contexts. A `console.log` is a smell in a request
 * handler but perfectly normal in a test or a CLI script.
 */

export type FileContext = "test" | "script" | "source";

const TEST_PATH =
  /(^|\/)(__tests__|__mocks__)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)tests?\//i;
const SCRIPT_PATH = /(^|\/)(bin|cli|scripts?)\//i;
const CLI_FILE = /(^|\/)cli\.[cm]?[jt]s$/i;

/** Classify a file from its (forward-slash) path and its source. */
export const classifyFileContext = (normalizedPath: string, sourceText: string): FileContext => {
  if (TEST_PATH.test(normalizedPath)) return "test";
  if (sourceText.startsWith("#!") || SCRIPT_PATH.test(normalizedPath) || CLI_FILE.test(normalizedPath)) {
    return "script";
  }
  return "source";
};

/**
 * Diagnostics auto-relaxed (dropped) in a given file context. Kept small and
 * explicit — only diagnostics that are genuinely noise-not-defect in that role.
 */
const RELAXED_IN_CONTEXT: Record<FileContext, ReadonlySet<string>> = {
  test: new Set(["no-console-log-in-committed-code"]),
  script: new Set(["no-console-log-in-committed-code"]),
  source: new Set<string>(),
};

/** Is `ruleId` treated as noise (auto-dropped) in `context`? */
export const isRelaxedInContext = (ruleId: string, context: FileContext): boolean =>
  RELAXED_IN_CONTEXT[context].has(ruleId);
