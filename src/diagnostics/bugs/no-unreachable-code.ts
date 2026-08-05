import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";

/**
 * Statements that can never execute because control flow already left the
 * statement list — a stray early `return` left behind by a refactor, or a
 * `throw` sitting above code someone still believes runs.
 *
 *   function f(x) {
 *     return x + 1;
 *     console.log("never runs");   // ❌ dead
 *   }
 *
 * This is structural, not heuristic: within a single statement list (a block, a
 * `Program`, or one `SwitchCase.consequent`), everything after the first
 * `return`/`throw`/`break`/`continue` is dead — *except* the forms that hoist or
 * are erased. Getting that exception right is the whole game:
 *
 *   - `function` declarations hoist to the top of their scope, so they are
 *     callable from above the terminator and are NOT dead.
 *   - `var` declarations hoist their binding too; the declaration itself still
 *     "happens" and flagging it is the classic false positive. (`let`/`const`
 *     do not hoist into use — those genuinely are dead.)
 *   - TypeScript declaration forms (`interface`, `type`, overload signatures)
 *     are erased before anything runs.
 *   - `import` / re-export forms are hoisted module linkage, not statements.
 *
 * Only the FIRST live statement of the dead run is reported: one finding per
 * statement list, so a ten-line dead tail is one actionable message.
 */

/** Statement types that end control flow for the rest of their statement list. */
const TERMINATORS: Record<string, string> = {
  ReturnStatement: "return",
  ThrowStatement: "throw",
  BreakStatement: "break",
  ContinueStatement: "continue",
};

/**
 * TypeScript forms that are erased at compile time (or are pure type space), so
 * they cannot be "unreachable" in any way a developer can act on.
 */
const ERASED_TS_STATEMENTS = new Set([
  "TSInterfaceDeclaration",
  "TSTypeAliasDeclaration",
  "TSDeclareFunction",
  "TSImportEqualsDeclaration",
  "TSExportAssignment",
  // Enums/namespaces do emit code, but their placement is declaration-like and
  // flagging them buys nothing — stay silent rather than risk noise.
  "TSEnumDeclaration",
  "TSModuleDeclaration",
]);

/**
 * Is this statement exempt from the unreachable check — because it hoists, is
 * erased, or is not executable code at all?
 *
 * Exported for `no-unreachable-cleanup-after-exit`, which reports the same class
 * of dead statement after a call-shaped terminator. Every exemption here was
 * paid for by a false positive; the two rules share one copy so they can never
 * drift apart.
 */
export const isHoistedOrErased = (stmt: AstNode | null | undefined): boolean => {
  if (!stmt) return true;
  // Ambient TypeScript: `declare const x`, `declare class C`, `declare let y`.
  // These carry no runtime form at all, so "unreachable" is meaningless for
  // them. oxc marks every ambient declaration with `declare: true`, whatever
  // the underlying node type — check that before the per-type table.
  if (stmt.declare === true) return true;
  switch (stmt.type) {
    // Hoisted to the top of the enclosing scope: reachable from above.
    case "FunctionDeclaration":
    // A lone `;` is not code worth reporting.
    case "EmptyStatement":
    // Module linkage, hoisted before any statement runs.
    case "ImportDeclaration":
    case "ExportAllDeclaration":
      return true;
    // `var` hoists its binding; `let`/`const` are genuinely dead.
    case "VariableDeclaration":
      return stmt.kind === "var";
    // Look through `export …` to the thing actually being declared. A bare
    // `export { a }` / `export * …` has no declaration and is pure linkage, and
    // `export type …` is erased outright.
    case "ExportNamedDeclaration":
    case "ExportDefaultDeclaration":
      if (stmt.exportKind === "type") return true;
      return isHoistedOrErased((stmt.declaration as AstNode | null) ?? null);
    default:
      return ERASED_TS_STATEMENTS.has(stmt.type);
  }
};

export const noUnreachableCode = defineDiagnostic({
  id: "no-unreachable-code",
  title: "Unreachable code after a control-flow exit",
  severity: "warn",
  category: "Bugs",
  scope: "file",
  tags: ["control-flow"],
  defaultEnabled: true,
  confidence: "high",
  recommendation:
    "Delete the dead statements, or move them above the return/throw/break/continue if they were meant to run. Control flow leaves the statement list at the terminator, so nothing after it executes (hoisted `function` and `var` declarations excepted).",
  create: (ctx) => {
    /** Scan one statement list and report at most the first dead statement. */
    const checkList = (body: unknown): void => {
      if (!Array.isArray(body) || body.length < 2) return;
      const statements = body as AstNode[];

      for (let i = 0; i < statements.length - 1; i++) {
        const keyword = TERMINATORS[statements[i]!.type];
        if (!keyword) continue;

        // Everything after the first terminator is one dead run. Find the first
        // statement in it that actually executes there.
        for (let j = i + 1; j < statements.length; j++) {
          const candidate = statements[j]!;
          if (isHoistedOrErased(candidate)) continue;
          ctx.report(
            candidate,
            `Unreachable code — this statement can never run because the enclosing block already exits via \`${keyword}\` above it.`,
          );
          return;
        }
        return; // terminator found, nothing live after it
      }
    };

    return {
      BlockStatement: (node) => checkList(node.body),
      Program: (node) => checkList(node.body),
      SwitchCase: (node) => checkList(node.consequent),
    };
  },
});
