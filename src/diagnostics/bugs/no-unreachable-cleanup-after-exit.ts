import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { staticMemberPath } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";
import { isTestFile } from "../../core/test-file.ts";
import { isHoistedOrErased } from "./no-unreachable-code.ts";

/**
 * §166 — cleanup written after `process.exit()`, which never runs.
 *
 * THE BUG. `process.exit()` does not return. It terminates the process
 * immediately, and — this is the part people are surprised by — it does NOT wait
 * for pending I/O. So the shutdown code written underneath it is not merely dead,
 * it is the code that was supposed to make the shutdown safe:
 *
 *   ❌ process.on("SIGTERM", () => {
 *        process.exit(0);
 *        server.close();          // never runs — connections cut mid-response
 *        await db.end();          // never runs — pool never drained
 *        logger.flush();          // never runs — the last logs are lost
 *      });
 *
 *   ✅ process.on("SIGTERM", async () => {
 *        server.close();
 *        await db.end();
 *        await logger.flush();
 *        process.exit(0);
 *      });
 *
 * The failure is invisible in development, where there is nothing to drain, and
 * shows up in production as truncated responses on every deploy and log lines
 * that stop a few seconds before every incident.
 *
 * WHY THIS IS A SEPARATE RULE FROM `no-unreachable-code`. That rule's terminator
 * table is keyed on statement TYPE — `return`, `throw`, `break`, `continue`. A
 * call is an `ExpressionStatement`, so it structurally cannot express
 * `process.exit()`, and adding it there would shift a default-on rule's findings
 * and evidence keys for every existing user. This rule is opt-in and says
 * something more specific: the dead statements are usually cleanup, and the
 * consequence is data loss rather than tidiness.
 *
 * PRECISION MODEL — every clause below was bought by a false positive an
 * adversarial hunt produced against the first version:
 *
 *   - The exit must be `process.exit(…)` or `process.abort()` as a bare
 *     expression statement DIRECTLY in the statement list. A call inside an
 *     `if`, a callback, or an expression is conditional, and a conditional
 *     terminator is not a terminator.
 *   - `process` must be THE GLOBAL. A local binding named `process` — a
 *     dependency-injected `{ process, logger }` parameter, a test double — is a
 *     different object whose `exit` may return normally.
 *   - The file must not REASSIGN `process.exit`. A test that stubs it
 *     (`process.exit = () => {}`) makes every statement below it run, and test
 *     files are skipped outright for the same reason.
 *   - The exit itself must be reachable. If a `return`/`throw` precedes it in
 *     the same list, the whole tail is dead and `no-unreachable-code` owns it —
 *     blaming `process.exit()` there would name the wrong cause.
 *   - `break`/`continue` after the exit are not cleanup. They are dead, but
 *     "move this above the exit" is wrong advice for them, and `no-unreachable-
 *     code` already covers the shape.
 *   - Every exemption `no-unreachable-code` learned is reused verbatim from the
 *     same function: hoisted `function`/`var` declarations, `import`/`export`
 *     linkage, ambient `declare`, and erased TypeScript forms are never dead.
 *   - Only the first live statement of the dead run is reported — one actionable
 *     finding, not a running commentary. The message quotes the call that is
 *     actually there, `exit` or `abort`.
 */

/** Calls that never return control to the next statement. */
const HARD_EXITS = new Set(["process.exit", "process.abort"]);

/** Statement types that end control flow, so the exit below them never runs. */
const PRECEDING_TERMINATORS = new Set([
  "ReturnStatement",
  "ThrowStatement",
  "BreakStatement",
  "ContinueStatement",
]);

/**
 * `break`/`continue` after an exit are dead but are not cleanup — telling their
 * author to "move it above the exit" is wrong advice, and `no-unreachable-code`
 * already reports the shape.
 */
const NOT_CLEANUP = new Set(["BreakStatement", "ContinueStatement"]);

/**
 * The termination call this statement is, or null. Returns the member path so
 * the message can quote what is actually written rather than assuming `exit`.
 */
const hardExitCall = (stmt: AstNode): string | null => {
  if (stmt.type !== "ExpressionStatement") return null;
  const expression = stmt.expression as AstNode | undefined;
  if (expression?.type !== "CallExpression") return null;
  const callee = staticMemberPath(expression.callee as AstNode);
  return callee !== null && HARD_EXITS.has(callee) ? callee : null;
};

/**
 * Does the file reassign `process.exit` / `process.abort`? A stub makes the
 * statements below it run, which is the opposite of what this rule would say.
 */
const stubsProcessExit = (program: AstNode): boolean =>
  collectDescendants(
    program,
    (n) => {
      if (n.type !== "AssignmentExpression") return false;
      const path = staticMemberPath(n.left as AstNode);
      return path !== null && HARD_EXITS.has(path);
    },
    undefined,
    true,
  ).length > 0;

export const noUnreachableCleanupAfterExit = defineDiagnostic({
  id: "no-unreachable-cleanup-after-exit",
  title: "Cleanup after process.exit() never runs",
  severity: "warn",
  category: "Bugs",
  scope: "file",
  confidence: "high",
  tags: ["control-flow", "lifecycle", "reliability"],
  defaultEnabled: false,
  recommendation:
    "Move the cleanup above the exit and await it: `server.close(); await db.end(); await logger.flush(); process.exit(0);`. `process.exit()` terminates immediately without waiting for pending I/O, so anything written below it never runs — and the things written below it are usually the drain, the flush and the close.",
  create: (ctx) => {
    // A test that stubs the exit makes the statements below the call run
    // normally, so a test file is never judged.
    const inert = isTestFile(ctx.program, ctx.normalizedFilePath) || stubsProcessExit(ctx.program);

    const checkList = (body: unknown): void => {
      if (inert) return;
      if (!Array.isArray(body) || body.length < 2) return;
      const statements = body as AstNode[];

      for (let i = 0; i < statements.length - 1; i++) {
        // A terminator above the exit means the exit itself never runs; the
        // dead tail belongs to `no-unreachable-code`, not to this claim.
        if (PRECEDING_TERMINATORS.has(statements[i]!.type)) return;

        const call = hardExitCall(statements[i]!);
        if (call === null) continue;

        // `process` must be the global, not an injected or shadowed binding.
        const expression = statements[i]!.expression as AstNode;
        const root = ((expression.callee as AstNode).object as AstNode | undefined) ?? undefined;
        if (root?.type === "Identifier" && ctx.scope.getBinding(root.name as string, root)) return;

        for (let j = i + 1; j < statements.length; j++) {
          const candidate = statements[j]!;
          if (isHoistedOrErased(candidate) || NOT_CLEANUP.has(candidate.type)) continue;
          ctx.report(
            candidate,
            `This never runs: \`${call}()\` above terminates the process immediately, without waiting for pending I/O. Move the cleanup above the exit and await it — otherwise connections are cut mid-response, the pool is never drained, and the last log lines are lost.`,
          );
          return;
        }
        return;
      }
    };

    return {
      BlockStatement: (node) => checkList(node.body),
      Program: (node) => checkList(node.body),
      SwitchCase: (node) => checkList(node.consequent),
      StaticBlock: (node) => checkList(node.body),
    };
  },
});
