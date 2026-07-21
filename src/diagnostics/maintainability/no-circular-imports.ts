import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";

/**
 * A circular import between modules (A imports B, and B imports A directly or
 * transitively). Cycles are a frequent source of `undefined`-at-module-eval bugs
 * (a value import read before the other module finished evaluating is `undefined`)
 * and of TDZ `ReferenceError`s under ESM. They also signal a layering problem.
 *
 * Anchored at the exact `import` statement that closes the cycle, in each file
 * that participates, so the fix is obvious: break one edge (extract the shared
 * piece into a third module, or switch to a type-only / lazy import).
 *
 * ❌ a.ts: import { b } from "./b";   b.ts: import { a } from "./a";
 * ✅ a.ts, b.ts both import shared symbols from "./shared".
 */
export const noCircularImports = defineDiagnostic({
  id: "no-circular-imports",
  title: "Circular import between modules",
  severity: "warn",
  category: "Maintainability",
  scope: "project",
  tags: ["architecture", "imports"],
  recommendation:
    "Break the cycle: extract the shared symbols into a third module both import, use a type-only import (`import type`) if it's only for types, or defer the import to call time. Cyclic value imports evaluate to `undefined` at load and cause TDZ errors under ESM.",
  create: (ctx) => ({
    Program: () => {
      if (!ctx.graph || !ctx.graph.hasCycles()) return;

      for (const stmt of (ctx.program.body as AstNode[]) ?? []) {
        // Only ESM `import ... from "..."` with in-project specifiers form edges here.
        if (stmt.type !== "ImportDeclaration") continue;
        // Type-only imports are erased at runtime — never a runtime cycle.
        if (stmt.importKind === "type") continue;
        const source = stmt.source?.value;
        if (typeof source !== "string" || !source.startsWith(".")) continue;
        const target = ctx.graph.resolveImport(source, ctx.filePath);
        if (!target) continue;
        if (ctx.graph.isCycleEdge(ctx.filePath, target)) {
          ctx.report(
            stmt.source ?? stmt,
            `Importing "${source}" closes an import cycle — the two modules depend on each other, so a value read here can be \`undefined\` during module evaluation.`,
          );
        }
      }
    },
  }),
});
