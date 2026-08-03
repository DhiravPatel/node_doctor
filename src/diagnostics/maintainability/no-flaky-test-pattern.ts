import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getCalleeName, staticMemberPath } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";
import { isTestFile, collectTestCases } from "../../core/test-file.ts";

/**
 * §174 — a test that is non-deterministic by construction.
 *
 * THE BUG. A flaky test fails once in fifty runs, so the team learns to re-run
 * CI instead of reading it. That habit is the real damage: once "just retry" is
 * the reflex, a genuine regression gets retried away too, and the suite stops
 * being a signal at all. The patterns that cause it are mechanical and visible
 * long before the first intermittent failure.
 *
 *   ❌ await new Promise((r) => setTimeout(r, 500));   // hope 500ms is enough
 *   ❌ expect(user.createdAt).toBe(Date.now());        // races the clock
 *   ❌ const id = Math.random();                       // different every run
 *
 *   ✅ await waitFor(() => expect(el).toBeVisible());  // wait for the condition
 *   ✅ vi.setSystemTime(new Date("2026-01-01"));       // freeze the clock
 *
 * PRECISION MODEL — only the mechanically-provable shapes fire, inside a proven
 * test case:
 *
 *   - A HARD-CODED SLEEP: `setTimeout` with a numeric literal delay used as a
 *     delay (wrapped in a Promise, or awaited). A `setTimeout` that schedules
 *     real work is not a sleep and is silent.
 *   - A CLOCK READ INSIDE AN ASSERTION: `Date.now()` / `new Date()` used as an
 *     operand of an assertion. Reading the clock to *build* a fixture is fine —
 *     only comparing against it races.
 *   - `Math.random()` anywhere in the case body: a value that differs every run
 *     cannot be asserted on, and if it is only used as a fixture it still makes
 *     failures unreproducible.
 *
 * Deliberately NOT covered (they need dataflow this rule does not have, and a
 * false positive would be worse than the miss): assumptions about iteration
 * order, cross-test shared-state coupling, and real network/filesystem calls —
 * which are legitimate in an integration test and indistinguishable from a unit
 * test statically.
 *
 * A test that FREEZES the clock (`useFakeTimers`, `setSystemTime`, `sinon`'s
 * clock) is silent for the clock and sleep cases: with time under control, both
 * shapes are deterministic.
 */

/** Calls that put the test's clock under deterministic control. */
const CLOCK_CONTROL = /\b(useFakeTimers|setSystemTime|install|tick|advanceTimersBy|runAllTimers|mockdate|MockDate)\b/;

/** An assertion entry point whose ARGUMENTS must be deterministic. */
const ASSERTION_CALL = /^(expect|assert)$/;

export const noFlakyTestPattern = defineDiagnostic({
  id: "no-flaky-test-pattern",
  title: "Test is non-deterministic by construction",
  severity: "warn",
  category: "Maintainability",
  confidence: "high",
  tags: ["testing", "maintainability", "flaky"],
  defaultEnabled: false,
  recommendation:
    "Make the test deterministic: wait for a condition rather than a fixed duration (`await waitFor(() => …)`), freeze the clock (`vi.useFakeTimers()` / `jest.useFakeTimers()`) instead of comparing against `Date.now()`, and use a fixed seed or a literal instead of `Math.random()`. A test that fails once in fifty runs teaches the team to re-run CI, which is how a real regression gets retried away.",
  create: (ctx) => ({
    Program: (program) => {
      if (!isTestFile(program, ctx.normalizedFilePath)) return;

      // Clock control is usually installed in a `beforeEach`, i.e. outside the
      // case — so this is a FILE-level question, not a per-case one.
      const clockIsControlled = CLOCK_CONTROL.test(ctx.sourceText);

      for (const testCase of collectTestCases(program)) {
        if (testCase.skipped || !testCase.fn) continue;
        const body = (testCase.fn.body as AstNode) ?? testCase.fn;
        const label = testCase.name ? ` ("${testCase.name}")` : "";

        // (1) A hard-coded sleep: setTimeout(fn, <literal ms>) used as a delay.
        if (!clockIsControlled) {
          for (const call of collectDescendants(
            body,
            (n) => n.type === "CallExpression" && getCalleeName(n.callee as AstNode) === "setTimeout",
            undefined,
            true,
          )) {
            const args = (call.arguments as AstNode[] | undefined) ?? [];
            const delay = args[1];
            if (delay?.type !== "Literal" || typeof delay.value !== "number" || delay.value <= 0) continue;
            // A sleep resolves a promise and does nothing else; a `setTimeout`
            // that schedules real work is not what this rule is about.
            const callback = args[0];
            const isSleep =
              !callback ||
              callback.type === "Identifier" || // setTimeout(resolve, 500)
              ((callback.type === "ArrowFunctionExpression" || callback.type === "FunctionExpression") &&
                collectDescendants(callback, (n) => n.type === "CallExpression", undefined, true).length <= 1);
            if (!isSleep) continue;
            ctx.report(
              call,
              `This test${label} sleeps for a fixed ${delay.value}ms instead of waiting for the condition it needs. On a slower CI machine the wait is too short and the test fails intermittently — which teaches the team to re-run CI rather than read it.`,
            );
            break;
          }
        }

        // (2) A clock read used as an assertion operand.
        if (!clockIsControlled) {
          let reported = false;
          for (const call of collectDescendants(
            body,
            (n) => n.type === "CallExpression",
            undefined,
            true,
          )) {
            if (reported) break;
            const name = getCalleeName(call.callee as AstNode);
            const path = staticMemberPath(call.callee as AstNode);
            if (!name || !ASSERTION_CALL.test(name)) continue;
            // Look for a clock read anywhere in the assertion's arguments, and in
            // the matcher call that follows it (`expect(a).toBe(Date.now())`).
            const parent = (call as { parent?: AstNode }).parent;
            const scope = parent?.type === "MemberExpression" ? ((parent as { parent?: AstNode }).parent ?? call) : call;
            for (const clock of collectDescendants(
              scope as AstNode,
              (n) =>
                (n.type === "CallExpression" && staticMemberPath(n.callee as AstNode) === "Date.now") ||
                (n.type === "NewExpression" &&
                  getCalleeName(n.callee as AstNode) === "Date" &&
                  ((n.arguments as AstNode[] | undefined) ?? []).length === 0),
              undefined,
              true,
            )) {
              ctx.report(
                clock,
                `This test${label} asserts against the live clock. The value moves between the code running and the assertion running, so the test fails whenever that gap crosses a millisecond boundary. Freeze time instead (\`vi.useFakeTimers()\` / \`jest.useFakeTimers()\`).`,
              );
              reported = true;
              break;
            }
            void path;
          }
        }

        // (3) Math.random() — unreproducible by definition.
        for (const call of collectDescendants(
          body,
          (n) => n.type === "CallExpression" && staticMemberPath(n.callee as AstNode) === "Math.random",
          undefined,
          true,
        )) {
          ctx.report(
            call,
            `This test${label} uses \`Math.random()\`, so each run exercises different input. When it fails you cannot reproduce the failure — use a fixed value, or a seeded generator.`,
          );
          break;
        }
      }
    },
  }),
});
