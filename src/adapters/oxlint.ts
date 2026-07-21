/**
 * An oxlint JS-plugin host that re-exposes node.doctor's file-scope diagnostics.
 * oxlint's plugin API is ESLint-compatible (`{ meta, rules }`, each rule a
 * `create(context)` returning AST visitors), so — like the ESLint adapter — this
 * runs the exact same engine (`lintSource`); there is one implementation.
 *
 * Usage (.oxlintrc.json → plugins, or the JS plugin loader):
 *
 *   import nodeDoctor from "node-doctor/oxlint";
 *   // plugin object: { meta: { name: "node-doctor" }, rules }
 *
 * Constraint: project-scope (Phase B, cross-file) and text-scan (secrets)
 * diagnostics cannot run under oxlint's per-file model, so only `scope: "file"`
 * diagnostics are exposed — mirroring the ESLint adapter.
 */

import { lintSource } from "../core/scan.ts";
import { DIAGNOSTICS } from "../core/registry.ts";
import { detectCapabilities } from "../core/project.ts";
import type { Finding, Severity } from "../core/types.ts";

interface OxlintContext {
  filename?: string;
  physicalFilename?: string;
  getFilename?: () => string;
  sourceCode?: { getText: () => string };
  getSourceCode?: () => { getText: () => string };
  report: (descriptor: { loc: { line: number; column: number }; message: string }) => void;
}

interface OxlintRule {
  meta: {
    type: "problem" | "suggestion";
    docs: { description: string; recommended: boolean };
  };
  create: (context: OxlintContext) => Record<string, (node: unknown) => void>;
}

/** Only file-scope diagnostics can run under a per-file linter. */
const FILE_DIAGNOSTICS = DIAGNOSTICS.filter((d) => (d.scope ?? "file") === "file");

let cachedCaps: Set<string> | null = null;
const capabilities = (): Set<string> => {
  if (cachedCaps) return cachedCaps;
  cachedCaps = detectCapabilities(
    { type: "module", dependencies: { express: "^4", "@prisma/client": "^5", jsonwebtoken: "^9", fastify: "^4" } },
    { hasTsconfig: true },
  );
  return cachedCaps;
};

const analysisCache = new Map<string, Finding[]>();
const analyze = (filename: string, text: string): Finding[] => {
  const key = `${filename} ${text.length} ${text}`;
  const cached = analysisCache.get(key);
  if (cached) return cached;
  if (analysisCache.size > 64) analysisCache.clear();
  const { findings } = lintSource({
    filePath: filename,
    sourceText: text,
    diagnostics: FILE_DIAGNOSTICS,
    capabilities: capabilities(),
  });
  analysisCache.set(key, findings);
  return findings;
};

const filenameOf = (context: OxlintContext): string =>
  context.filename ?? context.physicalFilename ?? context.getFilename?.() ?? "file.ts";
const textOf = (context: OxlintContext): string =>
  context.sourceCode?.getText?.() ?? context.getSourceCode?.().getText() ?? "";

const oxlintRuleFor = (ruleId: string, title: string, severity: Severity): OxlintRule => ({
  meta: {
    type: severity === "error" ? "problem" : "suggestion",
    docs: { description: title, recommended: true },
  },
  create: (context) => ({
    Program: () => {
      const filename = filenameOf(context);
      for (const d of analyze(filename, textOf(context)).filter((f) => f.diagnostic === ruleId)) {
        context.report({
          loc: { line: d.line, column: Math.max(0, d.column - 1) },
          message: `${d.message}\n${d.recommendation}`,
        });
      }
    },
  }),
});

/** Every file-scope node.doctor diagnostic as an oxlint rule, keyed by id. */
export const rules: Record<string, OxlintRule> = Object.fromEntries(
  FILE_DIAGNOSTICS.map((d) => [d.id, oxlintRuleFor(d.id, d.title, d.severity)]),
);

/** The oxlint plugin object. */
const plugin = {
  meta: { name: "node-doctor" },
  rules,
};

export default plugin;
