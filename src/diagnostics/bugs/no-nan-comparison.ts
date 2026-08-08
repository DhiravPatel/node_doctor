import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { staticMemberPath } from "../../core/ast.ts";
import { isTestFile } from "../../core/test-file.ts";

/**
 * §201 — a comparison against `NaN`, which never means what it reads as.
 *
 * `NaN` is the only value in JavaScript that is not equal to itself, so **every**
 * comparison against it has a constant answer that has nothing to do with the
 * operand:
 *
 *   ❌ if (total === NaN) return 0;          // ALWAYS false — the guard is dead
 *   ❌ if (total !== NaN) send(total);       // ALWAYS true  — the guard is a no-op
 *   ❌ if (score > NaN) …                    // ALWAYS false
 *   ✅ if (Number.isNaN(total)) return 0;
 *
 * The two shapes fail in opposite directions and both are silent. `=== NaN` is a
 * validation branch that never runs, so the `NaN` flows onward and surfaces as a
 * `null` in JSON, a `0` in a total, or an `Invalid Date` three layers away.
 * `!== NaN` is a guard that always passes, which reads as "I checked this" in
 * every review it ever gets.
 *
 * PRECISION MODEL. This is a fact about the language, not a judgement about the
 * code, so the only thing to establish is that the operand really is the global
 * `NaN`:
 *
 *   - `NaN` and `Number.NaN` both count; a `NaN` that some scope has REBOUND
 *     does not, because then it is an ordinary variable that could hold
 *     anything. The same applies one level up: a file that declares its own
 *     `Number` — a namespace, a value class, a schema object — is comparing
 *     object identity, and `Number.NaN` there is not the float. Applying this
 *     rule's advice inside such a file is a `TypeError`, not a fix.
 *   - Only comparison operators. `x + NaN` is arithmetic, not a dead branch.
 *   - `Object.is(x, NaN)` and `Number.isNaN(x)` are the correct forms and are
 *     never reported.
 *   - A TEST FILE is inert. The harm is a validation branch that never runs in
 *     production; a spec that writes `expect(NaN === NaN).toBe(false)` is
 *     pinning the constant down on purpose, and there is no branch at all.
 */

/** Operators whose result against `NaN` is a constant, whatever the operand. */
const COMPARISONS = new Set(["===", "!==", "==", "!=", "<", ">", "<=", ">="]);

/**
 * Is this node the global `NaN` — `NaN` itself or `Number.NaN`?
 *
 * `isShadowed` is asked about the ROOT identifier in both shapes. `Number.NaN`
 * is only the float when `Number` is the global one, and a file is free to
 * declare its own.
 */
const isGlobalNaN = (node: AstNode | null | undefined, isShadowed: (name: string, at: AstNode) => boolean): boolean => {
  if (!node) return false;
  if (node.type === "Identifier" && node.name === "NaN") return !isShadowed("NaN", node);
  if (staticMemberPath(node) !== "Number.NaN") return false;
  const root = (node as AstNode).object as AstNode | undefined;
  return root?.type === "Identifier" ? !isShadowed("Number", root) : false;
};

export const noNanComparison = defineDiagnostic({
  id: "no-nan-comparison",
  title: "Comparison against NaN, whose result is constant",
  severity: "error",
  category: "Bugs",
  confidence: "high",
  tags: ["correctness", "numeric"],
  recommendation:
    "Use `Number.isNaN(value)` — or `Object.is(value, NaN)`. `NaN` is not equal to itself, so `=== NaN` is always false and `!== NaN` is always true: one guard never runs and the other never stops anything.",
  create: (ctx) => {
    /** A local `NaN` — or a local `Number` — is an ordinary value, not the float. */
    const isShadowed = (name: string, at: AstNode): boolean => ctx.scope.getBinding(name, at) !== null;

    /**
     * A TypeScript `namespace Number {}` or `enum Number {}` declares a value
     * binding that the scope resolver does not record, so match it by syntax.
     */
    const declaredNames = new Set<string>();
    for (const stmt of (ctx.program.body as AstNode[] | undefined) ?? []) {
      const target = stmt.type === "ExportNamedDeclaration" ? ((stmt.declaration as AstNode | undefined) ?? stmt) : stmt;
      if (!/^TS(Module|Enum)Declaration$/.test(target.type as string)) continue;
      const id = target.id as AstNode | undefined;
      if (id?.type === "Identifier" && typeof id.name === "string") declaredNames.add(id.name as string);
    }

    let inert: boolean | null = null;

    return {
      BinaryExpression: (node) => {
        if (inert === null) inert = isTestFile(ctx.program, ctx.normalizedFilePath);
        if (inert) return;
        const operator = node.operator as string | undefined;
        if (typeof operator !== "string" || !COMPARISONS.has(operator)) return;

        const left = node.left as AstNode | undefined;
        const right = node.right as AstNode | undefined;
        const shadowed = (name: string, at: AstNode): boolean => declaredNames.has(name) || isShadowed(name, at);
        const leftIsNaN = isGlobalNaN(left, shadowed);
        const rightIsNaN = isGlobalNaN(right, shadowed);
        if (!leftIsNaN && !rightIsNaN) return;

        // `NaN === NaN` is a constant on both sides; still exactly one finding.
        const always = operator === "!==" || operator === "!=" ? "true" : "false";
        ctx.report(
          node,
          `\`${operator} NaN\` is always ${always} — \`NaN\` is not equal to itself, and is not ordered against anything. ${
            always === "false"
              ? "This branch can never run, so the NaN flows onward and surfaces somewhere else as `null`, `0`, or `Invalid Date`."
              : "This guard can never reject anything, while reading like a check that was performed."
          } Use \`Number.isNaN(…)\`.`,
        );
      },
    };
  },
});
