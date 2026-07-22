import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { findDescendant } from "../../core/walk.ts";

/**
 * A branch whose test can never vary: the condition is a literal or a
 * structurally-constant expression, so the guard is dead — the branch always
 * runs, or never does. In practice this is a leftover debug edit (`if (true)`)
 * or a typo'd comparison (`if (x = 1)`).
 *
 * WHAT COUNTS AS CONSTANT
 *   - a `Literal` (`true`, `false`, `0`, `1`, `"str"`, `null`, `/re/`, `0n`),
 *   - an object / array / function / arrow literal (always truthy by construction),
 *   - `!` or `void` applied to any of the above,
 *   - a plain `=` assignment of one of the above (`if (x = 1)`) — the classic
 *     `=` vs `===` typo, which also pins the test to a constant.
 *
 * DELIBERATE SILENCE — each of these is idiomatic, not a defect:
 *   - `while (true)`, `while (1)`, `for (;;)`, `for (; true;)`, `do … while (true)`.
 *     A *truthy* constant loop test is how you spell an infinite loop; firing on
 *     it would be this rule's single most annoying false positive. `while (1)` is
 *     the same idiom in a C-influenced codebase, so it is exempt too. Only a
 *     *falsy* loop test (`while (0)`, `for (; false;)`) is reported, because the
 *     body then provably never runs.
 *   - `do { … break; … } while (false)` — the "breakable block" / goto-emulation
 *     idiom. A `do`/`while (false)` loop is reported only when its body contains
 *     no early exit at all (`break`/`continue`/`return`/`throw`), i.e. when the
 *     wrapper genuinely does nothing.
 *   - `while (m = re.exec(s))`, `while (r = stack.pop())`, `do … while (s = s.parent)`,
 *     `if (_ = accept(x))` — an assignment of a *runtime* value. A sweep of real
 *     code (babel, terser, tslib, xmlbuilder, source-map-support …) found this
 *     shape in the hundreds and every single one was deliberate, so an assignment
 *     is reported only when what it assigns is a constant (`if (x = 1)`).
 *   - `while ((m = 1))` — an assignment wrapped in *extra* parentheses is the
 *     conventional "yes, I meant to assign" marker (the escape hatch ESLint's
 *     `no-cond-assign` uses), and so is anything the paren scan does not
 *     recognise, e.g. a comment sitting between the parens.
 *   - destructuring conditions (`while ([a, b] = pop())`) — never a `===` typo.
 *   - compound assignments (`if (x += 1)`) — they cannot be a `==` typo.
 *   - anything whose value is not statically known: identifiers, member
 *     expressions, calls, comparisons (`process.env.NODE_ENV === "production"`),
 *     `typeof`, logical operators, and template literals — including
 *     zero-interpolation ones, where the literal source is more likely a
 *     placeholder than a bug.
 */

/** Node types that evaluate to a fresh object/function — always truthy. */
const ALWAYS_TRUTHY_TYPES = new Set([
  "ObjectExpression",
  "ArrayExpression",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

/**
 * The statically-known truthiness of `node`, or null when it is not a constant
 * this rule recognises. Never throws on odd input.
 */
const staticTruthiness = (node: AstNode | null | undefined, depth = 0): boolean | null => {
  if (!node || depth > 32) return null; // a `!!!!…` chain must never blow the stack
  switch (node.type) {
    case "Literal": {
      // A regex literal is an object → always truthy.
      if (node.regex) return true;
      // BigInt literals surface as `value: null, bigint: "<digits>"` in some parsers.
      if (node.value === null && typeof node.bigint === "string") {
        try {
          return BigInt(node.bigint) !== BigInt(0);
        } catch {
          return null;
        }
      }
      return Boolean(node.value);
    }
    case "UnaryExpression": {
      if (node.operator === "!") {
        const inner = staticTruthiness(node.argument, depth + 1);
        return inner === null ? null : !inner;
      }
      // `void <constant>` is always `undefined` → falsy. `void call()` is left
      // alone: the operand may exist for its side effect.
      if (node.operator === "void") {
        return staticTruthiness(node.argument, depth + 1) === null ? null : false;
      }
      return null;
    }
    default:
      return ALWAYS_TRUTHY_TYPES.has(node.type) ? true : null;
  }
};

/**
 * The left-hand sides that a mistyped `===` could ever have produced. A
 * destructuring target (`while ([a, b] = pop())`, `while (({ a } = next()))`)
 * cannot be a comparison typo — it is always a deliberate idiom — so it is not
 * this rule's business.
 */
const TYPO_CAPABLE_TARGETS = new Set(["Identifier", "MemberExpression"]);

/** Is `node` a plain `=` assignment to a plain target (not `+=`, `&&=`, `[a] = …`)? */
const isPlainAssignment = (node: AstNode | null | undefined): boolean =>
  !!node &&
  node.type === "AssignmentExpression" &&
  node.operator === "=" &&
  !!node.left &&
  TYPO_CAPABLE_TARGETS.has(node.left.type);

const WHITESPACE = new Set([" ", "\t", "\n", "\r", "\f", "\v"]);

const IDENT_CHAR = /[A-Za-z0-9_$]/;

/**
 * Is `node` written as the *bare* condition of its construct — preceded by
 * exactly the parentheses the grammar mandates (`baseParens`: 1 for `if (…)`,
 * `while (…)`, `do … while (…)`; 0 for a `for` test) and then immediately by
 * that construct's own boundary token (`boundary`: the keyword, or `;` for a
 * `for` test)?
 *
 * This is deliberately a *positive* test rather than "are there extra parens":
 * anything the backward scan does not recognise — an extra `(` (the
 * conventional "I meant to assign" marker), an intervening comment between the
 * parentheses, any shape we did not anticipate — fails the check and the rule
 * stays silent. Silence on the unrecognised is the only safe default here.
 */
const isBareCondition = (
  node: AstNode,
  source: string,
  baseParens: number,
  boundary: string,
): boolean => {
  let index = node.start - 1;
  let opens = 0;
  while (index >= 0) {
    const ch = source[index]!;
    if (WHITESPACE.has(ch)) {
      index--;
      continue;
    }
    if (ch === "(") {
      opens++;
      index--;
      continue;
    }
    break;
  }
  if (opens !== baseParens) return false;
  if (boundary === ";") return source[index] === ";";
  const start = index - boundary.length + 1;
  if (start < 0) return false;
  if (source.slice(start, index + 1) !== boundary) return false;
  // Guard against a keyword that is really the tail of an identifier.
  const before = source[start - 1];
  return before === undefined || !IDENT_CHAR.test(before);
};

/**
 * Statements that make a `do … while (false)` wrapper meaningful: the body is
 * being used as an early-exit block (`break`/`continue` — the goto-emulation
 * idiom — or `return`/`throw`). Only a wrapper with no exit at all is reported.
 */
const EARLY_EXIT_TYPES = new Set([
  "BreakStatement",
  "ContinueStatement",
  "ReturnStatement",
  "ThrowStatement",
]);

/** Does this `do … while` body contain an early exit (the block idiom)? */
const hasEarlyExit = (body: AstNode | null | undefined): boolean => {
  if (!body) return false;
  const isExit = (n: AstNode): boolean => EARLY_EXIT_TYPES.has(n.type);
  // findDescendant does not test the root, and `do break; while (false)` has a
  // bare statement body — so test the body node itself as well.
  return isExit(body) || findDescendant(body, isExit) !== null;
};

export const noConstantCondition = defineDiagnostic({
  id: "no-constant-condition",
  title: "Condition can never vary",
  severity: "warn",
  category: "Bugs",
  scope: "file",
  tags: ["control-flow"],
  defaultEnabled: true,
  confidence: "high",
  recommendation:
    "Make the test depend on runtime state, or delete the dead branch. If you meant to compare, use `===` instead of `=`; if assigning a constant in the condition is deliberate, wrap it in extra parentheses: `while ((x = 0))`.",
  create: (ctx) => {
    const source = ctx.sourceText;

    /** The condition's source, whitespace-collapsed and length-capped. */
    const snip = (node: AstNode): string => {
      const raw = source.slice(node.start, node.end).replace(/\s+/g, " ").trim();
      return raw.length > 40 ? `${raw.slice(0, 39)}…` : raw;
    };

    /**
     * Report `cond = value` used as a test. Returns true if it reported.
     * `boundary` is the token the bare condition must sit directly behind
     * (`"if"` / `"while"` / `";"`); `null` means "never report here".
     */
    const reportAssignment = (
      test: AstNode,
      baseParens: number,
      boundary: string | null,
    ): boolean => {
      if (boundary === null) return false;
      if (!isPlainAssignment(test)) return false;
      // THE precision gate. `while (m = re.exec(s))`, `while (r = stack.pop())`,
      // `do … while (scope = scope.parent)`, `if (_ = assertCallable(f))` are
      // everywhere in real code and are always deliberate — a condition whose
      // assigned value is computed at runtime is an idiom, not a typo. Only an
      // assignment of a *constant* is reported: it makes the test unable to
      // vary (which is this rule's whole subject) and no idiom ever does it.
      const assigned = staticTruthiness(test.right);
      if (assigned === null) return false;
      if (!isBareCondition(test, source, baseParens, boundary)) return false;
      ctx.report(
        test,
        `\`=\` in a condition assigns instead of comparing — \`${snip(test)}\` assigns a constant, so the test is always ${assigned ? "truthy" : "falsy"}. Did you mean \`===\`?`,
      );
      return true;
    };

    /**
     * `if` / ternary: any constant test is dead code, truthy or falsy.
     * `outcomes` are the [always-truthy, always-falsy] consequences to report.
     */
    const checkBranch = (
      test: AstNode | null | undefined,
      baseParens: number,
      boundary: string | null,
      outcomes: [string, string],
    ): void => {
      if (!test) return;
      if (reportAssignment(test, baseParens, boundary)) return;
      const truthy = staticTruthiness(test);
      if (truthy === null) return;
      ctx.report(
        test,
        `\`${snip(test)}\` is always ${truthy ? "truthy" : "falsy"} — ${truthy ? outcomes[0] : outcomes[1]}`,
      );
    };

    /**
     * `while` / `for`: a truthy constant is the infinite-loop idiom and stays
     * silent; only a falsy constant (a body that provably never runs) reports.
     */
    const checkLoop = (
      test: AstNode | null | undefined,
      baseParens: number,
      boundary: string,
      keyword: string,
    ): void => {
      if (!test) return; // `for (;;)` — the idiomatic infinite loop.
      if (reportAssignment(test, baseParens, boundary)) return;
      if (staticTruthiness(test) === false) {
        ctx.report(test, `\`${keyword}\` condition \`${snip(test)}\` is always falsy — the loop body never runs.`);
      }
    };

    return {
      IfStatement: (node) =>
        checkBranch(node.test, 1, "if", [
          "the guard is dead and the branch always runs.",
          "the branch never runs.",
        ]),
      // A ternary test can only *be* an assignment when it is already
      // parenthesized (`(x = f()) ? a : b`), i.e. always deliberate — so the
      // assignment check is off here (`null`) and only constants are reported.
      ConditionalExpression: (node) =>
        checkBranch(node.test, 0, null, [
          "this ternary always yields its first arm.",
          "this ternary always yields its second arm.",
        ]),
      WhileStatement: (node) => checkLoop(node.test, 1, "while", "while"),
      ForStatement: (node) => checkLoop(node.test, 0, ";", "for"),
      DoWhileStatement: (node) => {
        const test = node.test as AstNode | null | undefined;
        if (!test) return;
        if (reportAssignment(test, 1, "while")) return;
        // `do … while (true)` is an infinite loop; `do … while (false)` guarding a
        // `break`/`continue` is the breakable-block idiom. Report only the
        // do-nothing wrapper.
        if (staticTruthiness(test) === false && !hasEarlyExit(node.body)) {
          ctx.report(
            test,
            `\`do … while\` condition \`${snip(test)}\` is always falsy — the body runs exactly once, so the loop does nothing.`,
          );
        }
      },
    };
  },
});
