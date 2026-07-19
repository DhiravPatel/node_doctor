import { defineDiagnostic } from "../../core/types.ts";
import { getCalleeName } from "../../core/ast.ts";

/**
 * A `console.log` / `console.debug` left in committed backend code. Unstructured
 * stdout noise pollutes production logs, can leak data, and is almost always a
 * debugging leftover. `console.error` / `console.warn` are legitimate finding
 * channels and are left alone, as are obvious CLI scripts (a shebang or a
 * bin/cli/scripts path) where stdout IS the interface. OPT-IN: hygiene, off by
 * default.
 *
 * ❌ console.log("user", user);
 * ❌ console.debug(payload);
 * ✅ console.error("failed to charge", err);   // real error channel
 * ✅ logger.info({ userId }, "charged");         // structured logger
 */

/** The stray-debug console methods this diagnostic flags (structured-logger channels stay silent). */
const STRAY_CALLEES = new Set(["console.log", "console.debug"]);

/** Does this file look like a CLI entrypoint where stdout is the interface? */
const looksLikeCliScript = (filePath: string, sourceText: string): boolean => {
  if (sourceText.startsWith("#!")) return true; // shebang
  return /(^|\/)(bin|cli|scripts)\//.test(filePath) || /(^|\/)cli\.[cm]?[jt]s$/.test(filePath);
};

export const noConsoleLogInCommittedCode = defineDiagnostic({
  id: "no-console-log-in-committed-code",
  title: "console.log left in committed code",
  severity: "warn",
  category: "Maintainability",
  tags: ["hygiene"],
  defaultEnabled: false,
  recommendation:
    "Remove the stray `console.log`/`console.debug`, or route it through a structured logger (`logger.info(...)`). Keep `console.error`/`console.warn` for real findings.",
  create: (ctx) => {
    const skipFile = looksLikeCliScript(ctx.filePath, ctx.sourceText);
    return {
      CallExpression: (node) => {
        if (skipFile) return; // CLI script — stdout is the interface
        const callee = getCalleeName(node);
        if (!callee || !STRAY_CALLEES.has(callee)) return;
        ctx.report(node, `\`${callee}\` left in committed code — use a structured logger and remove stray debug output.`);
      },
    };
  },
});
