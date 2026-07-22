import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getCalleeName, getStaticStringValue } from "../../core/ast.ts";

/**
 * A regex literal with a catastrophic-backtracking shape (ReDoS).
 *
 * Why it matters: a group whose body already contains a quantifier and which is
 * itself quantified — `(a+)+`, `(.*)*`, `(\d+)*` — has exponentially many ways to
 * split the same input. On a crafted, non-matching string the regex engine runs
 * for seconds to minutes, and because matching is synchronous it blocks the whole
 * event loop. A caller who controls the tested string can wedge the process.
 *
 * We only flag the nested-quantifier shape; ordinary regexes stay silent.
 *
 * ❌ const re = /^(\w+)*$/;                 // nested quantifier
 * ❌ new RegExp("(a+)+");
 * ✅ const re = /^\w+$/;                    // anchored, single quantifier
 * ✅ const re = /^\d{4}-\d{2}-\d{2}$/;      // bounded
 */

/**
 * A group `(...)` whose body contains a `+`/`*` quantifier and which is itself
 * repeated by a `+` or `*` — the classic ReDoS trigger. An *optional* group
 * (`(?:x+)?`) is deliberately excluded: it matches at most once, so there is no
 * exponential search space, and flagging it is a false positive.
 */
const REDOS_SHAPE = /\([^)]*[+*][^)]*\)[+*]/;

/** Pull a regex source string from a Literal or a `RegExp(...)` constructor. */
const regexSourceOf = (node: AstNode): string | null => {
  if (node.type === "Literal" && node.regex && typeof node.regex.pattern === "string") {
    return node.regex.pattern;
  }
  if (node.type === "NewExpression" || node.type === "CallExpression") {
    if (getCalleeName(node) !== "RegExp") return null;
    const arg0 = (node.arguments as AstNode[])?.[0];
    return arg0 ? getStaticStringValue(arg0) : null;
  }
  return null;
};

export const noRedosProneRegex = defineDiagnostic({
  id: "no-redos-prone-regex",
  title: "Regex with catastrophic-backtracking shape",
  severity: "warn",
  category: "Security",
  tags: ["event-loop", "security"],
  recommendation:
    "Rewrite to remove the nested quantifier (`(\\w+)*` → `\\w*`), anchor the pattern, or bound the tested input length. For untrusted input use a linear-time matcher (RE2) instead of the backtracking engine.",
  create: (ctx) => {
    const check = (node: AstNode): void => {
      const src = regexSourceOf(node);
      if (src === null) return;
      if (!REDOS_SHAPE.test(src)) return;
      ctx.report(
        node,
        "This regex nests a quantified group inside another quantifier — a crafted input triggers catastrophic backtracking that blocks the event loop.",
      );
    };
    return {
      Literal: check,
      NewExpression: check,
      CallExpression: check,
    };
  },
});
