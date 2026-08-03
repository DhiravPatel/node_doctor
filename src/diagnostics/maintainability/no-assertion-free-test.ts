import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getCalleeName, staticMemberPath } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";
import { isTestFile, collectTestCases, containsAssertion } from "../../core/test-file.ts";

/**
 * §173 — a test that asserts nothing.
 *
 * THE BUG. A test with no assertion passes forever and proves nothing. It calls
 * the code under test, the code does not throw, the test goes green — and the
 * coverage number counts every line it touched. That is worse than having no
 * test at all, because the coverage report now says the code is verified when the
 * only thing verified is that it *runs*. Every refactor that silently breaks the
 * return value ships green.
 *
 *   ❌ it("creates a user", async () => {
 *        await createUser({ email: "a@b.c" });      // did it work? nobody knows
 *      });
 *
 *   ✅ it("creates a user", async () => {
 *        const user = await createUser({ email: "a@b.c" });
 *        expect(user.email).toBe("a@b.c");
 *      });
 *
 * PRECISION MODEL. A false "this test asserts nothing" claim lands on code the
 * author believes is correct, so the assertion recognizer (see `test-file.ts`) is
 * deliberately generous and this rule adds four more escape hatches on top:
 *
 *   - The file must be a PROVEN test file (runner import, or a test path plus
 *     real `it`/`test` calls).
 *   - A SKIPPED or todo case (`it.skip`, `it.todo`, `xit`) asserts nothing by
 *     design — silent.
 *   - A case that DELEGATES its assertion is silent. See the provenance note
 *     below: this is the guard that matters, and getting it wrong produced 674
 *     false positives on this project's own suite before it was fixed.
 *   - A case that awaits a rejection, or declares an expected-assertion count
 *     (`expect.assertions(n)`), is silent.
 *
 * What is left is the shape that is unambiguously vacuous: a test body that
 * exercises imported production code, never asserts, and never hands the
 * asserting to anything local.
 */

/**
 * THE DELEGATION LINE — the whole precision of this rule.
 *
 * A first attempt matched helper NAMES (`expectFires`, `assertShape`). Run
 * against this project's own 99 test files it produced 674 false positives,
 * because a suite's assertion helpers are named for the domain, not the act:
 * `cron.fires(src)`, `ws.silent(src)`, `ok(result)`. Names are arbitrary; the
 * line has to be somewhere provable.
 *
 * The provable discriminator is PROVENANCE. In a test file:
 *   - a callee that is LOCAL to the file (declared here, or reached through a
 *     local binding like `cron.fires`) is almost always a test-support helper,
 *     and its assertion lives one frame down where this rule cannot see it;
 *   - a callee IMPORTED from the module under test is the subject of the test,
 *     not its assertion.
 *
 * So: anything local, or imported from a helper-ish module, buys silence.
 * Anything imported from elsewhere is code under test. That is a structural
 * fact, not a guess about naming.
 */
const HELPER_MODULE = /(helper|util|support|fixture|matcher|assertion|harness|setup)/i;

/** A name that announces it asserts — kept as an ADDITIONAL silence signal for
 *  imported helpers (`import { expectValid } from "../shared"`). */
const ASSERTION_HELPER_NAME = /^(expect|assert|should|check|verify|ensure|validate|must|confirm)/i;

/** Helpers whose presence proves the case delegates or expects a failure. */
const DELEGATION_MARKERS = /\b(assertions|hasAssertions|rejects|resolves|toThrow|snapshot)\b/;

export const noAssertionFreeTest = defineDiagnostic({
  id: "no-assertion-free-test",
  title: "Test has no assertion",
  severity: "warn",
  category: "Maintainability",
  confidence: "high",
  tags: ["testing", "maintainability", "coverage"],
  defaultEnabled: false,
  recommendation:
    "Assert something about the result. A test with no assertion passes forever and proves only that the code did not throw — while still counting toward coverage, which makes the coverage number actively misleading. If the test exists to prove a call does not throw, say so explicitly (`await expect(fn()).resolves.toBeDefined()`); if it is a placeholder, mark it `it.todo(...)`.",
  create: (ctx) => ({
    Program: (program) => {
      if (!isTestFile(program, ctx.normalizedFilePath)) return;

      // Every name that could carry an assertion out of sight:
      //  1. anything DECLARED in this file (a local helper, or a local binding
      //     whose methods assert — `const cron = makeAsserts(rule)`),
      //  2. anything imported from a helper-ish module,
      //  3. an imported name that announces it asserts.
      const opaqueHelpers = new Set<string>();
      for (const decl of collectDescendants(
        program,
        (n) =>
          n.type === "VariableDeclarator" ||
          n.type === "FunctionDeclaration" ||
          n.type === "ClassDeclaration",
        undefined,
        true,
      )) {
        const id = decl.id as AstNode | undefined;
        if (id?.type === "Identifier") opaqueHelpers.add(id.name as string);
        else if (id) {
          for (const bound of collectDescendants(id, (n) => n.type === "Identifier", undefined, true)) {
            opaqueHelpers.add(bound.name as string);
          }
        }
      }
      for (const stmt of (program.body as AstNode[] | undefined) ?? []) {
        if (stmt.type !== "ImportDeclaration" || typeof stmt.source?.value !== "string") continue;
        const fromHelperModule = HELPER_MODULE.test(stmt.source.value);
        for (const spec of (stmt.specifiers as AstNode[] | undefined) ?? []) {
          const local = (spec.local as AstNode | undefined)?.name as string | undefined;
          if (!local) continue;
          if (fromHelperModule || ASSERTION_HELPER_NAME.test(local)) opaqueHelpers.add(local);
        }
      }

      for (const testCase of collectTestCases(program)) {
        // A case with no callback (`it.todo("later")`) or an explicitly skipped
        // one asserts nothing by design.
        if (testCase.skipped || !testCase.fn) continue;

        const body = (testCase.fn.body as AstNode) ?? testCase.fn;
        if (containsAssertion(body)) continue;

        // `expect.assertions(2)` / `expect.hasAssertions()` — the case declares
        // that assertions happen, possibly in a callback we cannot follow.
        const sourceSlice = ctx.sourceText.slice(
          (testCase.fn.start as number) ?? 0,
          (testCase.fn.end as number) ?? 0,
        );
        if (DELEGATION_MARKERS.test(sourceSlice)) continue;

        // THE KEY GUARD: does this case delegate its assertion to a helper?
        // A suite that factors assertions out names the helper for what it does
        // (`expectFires`, `assertShape`) — or imports it from a helpers module.
        // Either buys silence, because the assertion lives one frame down.
        let delegates = false;
        for (const call of collectDescendants(body, (n) => n.type === "CallExpression", undefined, true)) {
          const callee = call.callee as AstNode | undefined;
          // The root identifier of the call: `cron` in `cron.fires(x)`, `f` in `f(x)`.
          let root: string | null = null;
          let node: AstNode | undefined = callee;
          let guard = 0;
          while (node && guard++ < 32) {
            if (node.type === "Identifier") { root = node.name as string; break; }
            if (node.type === "MemberExpression") node = node.object as AstNode | undefined;
            else if (node.type === "CallExpression") node = node.callee as AstNode | undefined;
            else break;
          }
          if (root && opaqueHelpers.has(root)) { delegates = true; break; }
          const leaf = staticMemberPath(callee as AstNode)?.split(".").pop() ?? getCalleeName(callee as AstNode);
          if (leaf && ASSERTION_HELPER_NAME.test(leaf)) { delegates = true; break; }
        }
        if (delegates) continue;

        // A completely empty body is a placeholder, not a false-confidence test;
        // reporting it adds noise without adding information.
        const statements = (body.type === "BlockStatement" ? (body.body as AstNode[]) : [body]) ?? [];
        if (statements.length === 0) continue;

        ctx.report(
          testCase.call,
          `This test${testCase.name ? ` ("${testCase.name}")` : ""} runs code but never asserts anything — it passes as long as nothing throws, while still counting toward coverage. The coverage number therefore reports this code as verified when nothing about its behaviour is checked.`,
        );
      }
    },
  }),
});
