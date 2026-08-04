import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getStaticStringValue, staticMemberPath } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";
import { isTestFile, collectTestCases } from "../../core/test-file.ts";

/**
 * §176 — a test that asserts its own mock's configuration back to itself.
 *
 * THE BUG. The test stubs a collaborator to return X, calls it, and asserts the
 * result is X. Nothing about the code under test is exercised — the assertion
 * re-states the setup two lines above it. It passes forever, contributes to the
 * coverage number, and reads like rigour, which is what makes it durable: it
 * survives review because it *looks* like a real test.
 *
 *   ❌ const getUser = vi.fn().mockReturnValue({ id: 1 });
 *      expect(getUser()).toEqual({ id: 1 });     // asserts the mock, not the code
 *
 *   ✅ const getUser = vi.fn().mockReturnValue({ id: 1 });
 *      expect(renderProfile(getUser())).toBe("User 1");   // asserts OUR code
 *
 * PRECISION MODEL. §176 in the catalog describes a ratio ("the mocked surface
 * dwarfs the real surface"), which is a judgement call and would produce exactly
 * the arguable findings this project refuses to ship. So the rule implements only
 * the sub-case that is *provable*: the asserted expression is a direct call to a
 * binding this test file mocked, with no other computation between the mock and
 * the assertion.
 *
 * Silent whenever the code under test appears anywhere in the assertion — the
 * moment a real function wraps the mock's value, the test is exercising
 * something, and that is not this rule's business. Also silent on behavioural
 * assertions about the mock (`toHaveBeenCalledWith`), which verify how OUR code
 * used the collaborator and are a legitimate, valuable test.
 *
 * Hardened against an adversarial hunt, which showed the binding itself must be
 * proven: only a NAMESPACED factory counts (`vi.fn`, `jest.fn`, `sinon.stub`),
 * because a bare `stub()`/`fn()` is just as likely a fixture builder — or, in a
 * mocking library's own suite, the production code under test. And only a `const`
 * that is never reassigned counts, since a mock swapped for the real
 * implementation between suites makes the same assertion a genuine test.
 */

/** Ways a mock's return value is configured. */
const MOCK_CONFIGURATORS = new Set([
  "mockReturnValue",
  "mockReturnValueOnce",
  "mockResolvedValue",
  "mockResolvedValueOnce",
  "mockImplementation",
  "mockImplementationOnce",
  "returns",
  "resolves",
]);

/**
 * Factories that create a mock function — NAMESPACED ONLY.
 *
 * A bare `fn()` / `stub()` / `spy()` is not proof of a mock: it is also a fixture
 * builder (`stub("user").returns(…)`), and in a mocking library's own test suite
 * those names ARE the production code under test. Requiring the namespace is what
 * keeps this rule from firing on the projects most likely to use those words.
 */
const MOCK_FACTORY = /^(vi|jest|sinon|jasmine|td)\.(fn|mock|stub|spy|createStubInstance)$/;

/** Matchers that assert VALUE equality (the tautological ones). */
const VALUE_MATCHERS = new Set([
  "toBe", "toEqual", "toStrictEqual", "toMatchObject", "toBeCloseTo", "equal", "eql", "deepEqual",
]);

export const noTautologicalMockAssertion = defineDiagnostic({
  id: "no-tautological-mock-assertion",
  title: "Test asserts its own mock's configured value",
  severity: "warn",
  category: "Maintainability",
  confidence: "high",
  tags: ["testing", "maintainability", "coverage"],
  defaultEnabled: false,
  recommendation:
    "Assert on the output of the code under test, not on the mock you configured. Passing the mock's value through your own function and asserting the result is what makes the test meaningful; asserting the mock's return value only re-states the setup. If the intent is to verify how your code *uses* the collaborator, assert that instead: `expect(getUser).toHaveBeenCalledWith(1)`.",
  create: (ctx) => ({
    Program: (program) => {
      if (!isTestFile(program, ctx.normalizedFilePath)) return;

      // Bindings that hold a mock configured with a fixed return value in this
      // file: `const getUser = vi.fn().mockReturnValue({ id: 1 })`.
      const configuredMocks = new Set<string>();
      // A binding that is REASSIGNED later cannot be reasoned about: a mock swapped
      // for the real implementation between suites (`render = realRender`) would
      // make the assertion a genuine test by the time it runs.
      const reassigned = new Set<string>();
      for (const assign of collectDescendants(
        program,
        (n) => n.type === "AssignmentExpression",
        undefined,
        true,
      )) {
        const left = assign.left as AstNode | undefined;
        if (left?.type === "Identifier") reassigned.add(left.name as string);
      }

      for (const decl of collectDescendants(
        program,
        (n) => n.type === "VariableDeclarator",
        undefined,
        true,
      )) {
        const id = decl.id as AstNode | undefined;
        if (id?.type !== "Identifier") continue;
        if (reassigned.has(id.name as string)) continue;
        const init = decl.init as AstNode | undefined;
        if (!init) continue;
        // Walk the chain looking for BOTH a mock factory root and a configurator.
        let sawFactory = false;
        let sawConfigurator = false;
        let node: AstNode | undefined = init;
        let guard = 0;
        while (node && guard++ < 32) {
          if (node.type === "CallExpression") {
            const callee = node.callee as AstNode | undefined;
            // Read the property DIRECTLY: `vi.fn().mockReturnValue` roots at a
            // call, so a static member path cannot resolve it.
            const leaf =
              callee?.type === "MemberExpression" &&
              !callee.computed &&
              (callee.property as AstNode | undefined)?.type === "Identifier"
                ? ((callee.property as AstNode).name as string)
                : null;
            if (leaf && MOCK_CONFIGURATORS.has(leaf)) sawConfigurator = true;
            const path = staticMemberPath(callee as AstNode);
            if (path && MOCK_FACTORY.test(path)) sawFactory = true;
            if (callee?.type === "Identifier" && MOCK_FACTORY.test(callee.name as string)) sawFactory = true;
            node = callee;
            continue;
          }
          if (node.type === "MemberExpression") {
            node = node.object as AstNode | undefined;
            continue;
          }
          break;
        }
        // `const` only: a `let` holding a mock is the reassignable shape above.
        const declaration = (decl as { parent?: AstNode }).parent;
        const isConst = declaration?.type === "VariableDeclaration" && declaration.kind === "const";
        if (sawFactory && sawConfigurator && isConst) configuredMocks.add(id.name as string);
      }
      if (configuredMocks.size === 0) return;

      for (const testCase of collectTestCases(program)) {
        if (testCase.skipped || !testCase.fn) continue;
        const body = (testCase.fn.body as AstNode) ?? testCase.fn;

        for (const call of collectDescendants(body, (n) => n.type === "CallExpression", undefined, true)) {
          // Find `expect(<subject>)`.
          const callee = call.callee as AstNode | undefined;
          if (callee?.type !== "Identifier" || callee.name !== "expect") continue;
          const subject = ((call.arguments as AstNode[] | undefined) ?? [])[0];
          if (!subject) continue;

          // The subject must be EXACTLY a call to a configured mock — nothing of
          // ours may wrap it, because then the test is exercising real code.
          let inner: AstNode | undefined = subject;
          if (inner.type === "AwaitExpression") inner = inner.argument as AstNode | undefined;
          if (inner?.type !== "CallExpression") continue;
          const subjectCallee = inner.callee as AstNode | undefined;
          const subjectName =
            subjectCallee?.type === "Identifier" ? (subjectCallee.name as string) : null;
          if (!subjectName || !configuredMocks.has(subjectName)) continue;

          // The matcher must be a VALUE comparison. `toHaveBeenCalledWith` asserts
          // how our code used the collaborator — a real and useful test.
          const parent = (call as { parent?: AstNode }).parent;
          if (parent?.type !== "MemberExpression") continue;
          const matcherCall = (parent as { parent?: AstNode }).parent;
          const matcher =
            (parent.property as AstNode | undefined)?.type === "Identifier"
              ? ((parent.property as AstNode).name as string)
              : null;
          if (!matcher || !VALUE_MATCHERS.has(matcher)) continue;

          ctx.report(
            matcherCall ?? call,
            `This assertion checks that \`${subjectName}()\` returns the value this test configured it to return — it re-states the mock setup and exercises none of the code under test, while still counting toward coverage.`,
          );
          break;
        }
      }
    },
  }),
});
