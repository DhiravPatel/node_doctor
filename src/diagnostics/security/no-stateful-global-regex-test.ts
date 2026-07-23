import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode, Visitors } from "../../core/types.ts";
import { getMethodName, unwrapChain, findAncestor } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";

/**
 * `.test()`/`.exec()` on a STORED regex that carries the `g` (global) or `y`
 * (sticky) flag is a genuinely evil intermittent bug. Those flags make the regex
 * stateful: each call advances its `lastIndex`, and matching resumes from there
 * next time. So the SAME input returns `true`, then `false`, then `true` … :
 *
 *   const RE = /id/g;
 *   RE.test("id");   // true  (lastIndex → 2)
 *   RE.test("id");   // false (searches from index 2, finds nothing, lastIndex → 0)
 *   RE.test("id");   // true  again
 *
 * A validator built on this passes in tests, then rejects a valid value one
 * request in two in production — the hardest kind of bug to reproduce.
 *
 * WHEN THIS FIRES (precision-first, `error`/high):
 *   - the receiver is a NAMED binding (`const`/`let`/`var`) the scope resolver
 *     follows back to a regex literal whose flags include `g` or `y`;
 *   - the `.test()`/`.exec()` call is OUTSIDE any loop — a stored global regex
 *     reused as a one-shot check across calls (a validator), not walked in a loop.
 *
 * DELIBERATE SILENCE:
 *   - A regex WITHOUT `g`/`y` — stateless, so repeated `.test()` is correct.
 *   - An inline literal (`/foo/g.test(x)`) — a single fresh literal has no
 *     persisted state; only a *stored* regex reused across calls carries the bug,
 *     and requiring a binding keeps this rule high-confidence.
 *   - `.match()`/`.matchAll()`/`.replace()` — these do not consult `lastIndex`
 *     for a boolean the way `.test()`/`.exec()` do.
 *   - `.exec()`/`.test()` inside a loop — `while ((m = RE.exec(str)))` and the
 *     symmetric `while (RE.test(str)) count++` are the CORRECT, idiomatic way to
 *     walk every match of a global regex (advancing `lastIndex` is the point, and
 *     it resets when exhausted); firing on either would be this rule's worst FP.
 *   - Any regex whose name the code reassigns, or whose `.lastIndex` the code
 *     assigns — the author is managing the state deliberately, so we back off.
 *   - `new RegExp(p, "g")` initializers — not a regex *literal*; the flags may be
 *     dynamic, so we stay silent.
 *
 * ❌ const RE = /^[a-z]+$/g; export const valid = (s) => RE.test(s); // flips per call
 * ✅ const RE = /^[a-z]+$/;  export const valid = (s) => RE.test(s); // stateless
 * ✅ const RE = /\w+/g; let m; while ((m = RE.exec(text))) collect(m); // iteration idiom
 */

const LOOP_TYPES = new Set([
  "ForStatement",
  "ForOfStatement",
  "ForInStatement",
  "WhileStatement",
  "DoWhileStatement",
]);

const isRegexLiteral = (node: AstNode | null | undefined): node is AstNode =>
  !!node && node.type === "Literal" && !!node.regex && typeof node.regex.pattern === "string";

export const noStatefulGlobalRegexTest = defineDiagnostic({
  id: "no-stateful-global-regex-test",
  title: "Stateful global/sticky regex reused with `.test()`/`.exec()`",
  severity: "error",
  category: "Bugs",
  scope: "file",
  tags: ["correctness"],
  defaultEnabled: true,
  confidence: "high",
  recommendation:
    "Drop the `g`/`y` flag for a membership check (`/^\\d+$/` instead of `/^\\d+$/g`) — a stateless regex gives the same answer every call. If you truly need the flag, reset `re.lastIndex = 0` before each `.test()`, or match against a fresh literal.",
  create: (ctx): Visitors => {
    // One pass over the file: names the author reassigns, and names whose
    // `.lastIndex` the author touches. Either is a sign the state is being
    // managed on purpose (or the initializer no longer reflects the value), so we
    // back off — keeping the rule silent on deliberate, careful uses.
    const managed = new Set<string>();
    for (const n of collectDescendants(
      ctx.program,
      (x) =>
        (x.type === "AssignmentExpression" && x.left?.type === "Identifier") ||
        (x.type === "MemberExpression" &&
          !x.computed &&
          x.property?.type === "Identifier" &&
          x.property.name === "lastIndex" &&
          x.object?.type === "Identifier"),
    )) {
      if (n.type === "AssignmentExpression") managed.add(n.left.name);
      else managed.add(n.object.name);
    }

    return {
      CallExpression: (node) => {
        const method = getMethodName(node);
        if (method !== "test" && method !== "exec") return;

        const callee = unwrapChain(node.callee);
        if (!callee || callee.type !== "MemberExpression") return;
        const receiver = unwrapChain(callee.object);
        if (!receiver || receiver.type !== "Identifier") return;
        if (managed.has(receiver.name)) return;

        const binding = ctx.scope.getBinding(receiver.name, receiver);
        if (!binding) return;
        if (binding.kind !== "const" && binding.kind !== "let" && binding.kind !== "var") return;
        if (!isRegexLiteral(binding.initNode)) return;

        const flags = binding.initNode.regex.flags;
        if (typeof flags !== "string" || (!flags.includes("g") && !flags.includes("y"))) return;

        // `.exec()`/`.test()` inside a loop is the correct match-iteration idiom —
        // `while ((m = RE.exec(str)))` and the symmetric `while (RE.test(str)) count++`
        // both rely on `lastIndex` advancing to walk every occurrence and reset at the
        // end. Only a stored global regex reused as a one-shot check ACROSS calls (a
        // validator, not a loop) exhibits the flip-flop bug, so we back off in a loop.
        if (findAncestor(node, (a) => LOOP_TYPES.has(a.type))) return;

        const flag = flags.includes("g") ? "g" : "y";
        ctx.report(
          node,
          `\`${receiver.name}.${method}()\` on a regex with the \`${flag}\` flag is stateful — \`lastIndex\` advances between calls, so the same input returns true, then false, then true. Remove the \`${flag}\` flag for a membership test, or reset \`${receiver.name}.lastIndex = 0\` before each call.`,
        );
      },
    };
  },
});
