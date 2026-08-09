import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";

/**
 * §205 — a function that says it is unfinished, and ships anyway.
 *
 * The residue an agent leaves is usually plausible enough to survive a skim. The
 * unambiguous form is a function whose body contains **no statements at all**,
 * only a comment admitting it was never written:
 *
 *   ❌ export function applyDiscount(order) {
 *        // TODO: implement discount rules
 *      }
 *   ✅ export function applyDiscount(order) {
 *        return order.total * (1 - rateFor(order));
 *      }
 *   ✅ const noop = () => {};                    // empty on purpose, says nothing
 *   ✅ process.on("SIGPIPE", () => {
 *        // intentionally empty: we handle this in the writer
 *      });
 *
 * It returns `undefined`, silently. Nothing throws, nothing logs, and the caller
 * gets a value that is falsy, or `NaN` once it reaches arithmetic, or a missing
 * field three layers away. A test written against the same misunderstanding
 * passes. The compiler is happy: `undefined` is assignable to a great many
 * things, and to `any` always.
 *
 * PRECISION MODEL. The catalog's own warning for this section is that **a
 * placeholder identifier is naming taste, not a defect** — a rule that judges
 * names is a style linter wearing a correctness badge. So this judges neither
 * names nor bodies that do something. It needs two facts, both syntactic:
 *
 *   - The body has **zero statements**. A function that does one thing is doing
 *     it; whether that thing is enough is not a question syntax answers.
 *   - A comment inside it opens with a **conventional tag** — `TODO`, `FIXME`,
 *     `XXX`, `HACK` — or says `not implemented` outright. The comment is the
 *     author stating the fact; the rule only repeats it.
 *
 * And three silences that matter more than the trigger:
 *
 *   - An empty body with **no comment** is a deliberate no-op — a default
 *     callback, a required-but-unused hook — and is never reported.
 *   - An **inline callback argument** is never reported. An empty listener is a
 *     required idiom, not residue: `req.on("error", (e) => {})` exists precisely
 *     so an unhandled `error` event cannot take the process down, and the empty
 *     body is the whole point. Next.js ships exactly that, with a
 *     `// TODO: log socket errors?` beside it, and it is correct.
 *   - A comment that states the emptiness is **intentional** wins over the tag.
 *
 * The marker test was tightened after a corpus sweep, and the reason is worth
 * recording. It first matched the bare words `implement`, `stub` and
 * `placeholder` anywhere in a comment — which fired on Next's `voidCatch()`,
 * whose comment explains that it expects "the underlying pipe **implementation**
 * to forward errors", and on React Navigation's `removeListener`, whose comment
 * mentions "**placeholder** screens". Both are correct code explaining itself.
 * Matching a domain word in prose is exactly the style-linter failure the
 * catalog warns about for this section, so a tag now has to be written as a tag.
 */

/**
 * A conventional tag, written as a tag: at the start of the comment (past any
 * leading `*` of a block comment) rather than anywhere in prose. Plus the one
 * phrase that is unambiguous wherever it appears.
 */
const UNFINISHED_TAG = /^[\s*]*(todo|fixme|xxx|hack)\b/i;
const UNFINISHED_PHRASE = /\b(not\s+implemented|unimplemented|to\s+be\s+implemented|not\s+yet\s+implemented)\b/i;

const saysUnfinished = (comment: string): boolean =>
  UNFINISHED_TAG.test(comment) || UNFINISHED_PHRASE.test(comment);

/** Phrases in which an empty body is the point. These win over any marker. */
const DELIBERATE = /\b(intentional|intentionally|deliberate|deliberately|on\s+purpose|no[-\s]?op|noop|ignore[ds]?|by\s+design|nothing\s+to\s+do)\b/i;

export const noUnimplementedStub = defineDiagnostic({
  id: "no-unimplemented-stub",
  title: "Function body is empty apart from a comment saying it is unfinished",
  severity: "warn",
  category: "Maintainability",
  confidence: "high",
  tags: ["correctness", "agent-artifact", "maintainability"],
  recommendation:
    "Implement it, or make the gap loud — `throw new Error(\"applyDiscount is not implemented\")` fails on the first call instead of returning `undefined` into arithmetic three layers away. An empty body that a comment admits is unfinished passes type checking, passes a test written against the same misunderstanding, and ships.",
  create: (ctx) => {
    /**
     * Comments are not in the AST, so they arrive separately and are matched by
     * span. `ctx.comments` is in ascending `start` order.
     */
    const commentsWithin = (start: number, end: number): string[] => {
      const found: string[] = [];
      for (const comment of ctx.comments) {
        if (comment.start >= start && comment.end <= end) found.push(comment.value);
        if (comment.start > end) break;
      }
      return found;
    };

    /**
     * Is this function an inline argument to a call? An empty listener is a
     * required idiom — `req.on("error", () => {})` is what stops an unhandled
     * `error` event killing the process — not unfinished work.
     */
    const isInlineCallback = (node: AstNode): boolean => {
      const parent = node.parent as AstNode | undefined;
      if (parent?.type !== "CallExpression" && parent?.type !== "NewExpression") return false;
      return ((parent.arguments as AstNode[] | undefined) ?? []).includes(node);
    };

    const check = (node: AstNode): void => {
      if (isInlineCallback(node)) return;
      const body = node.body as AstNode | undefined;
      // An expression-bodied arrow (`() => x`) does something; only a block can
      // be empty. A body with any statement at all is out of scope.
      if (body?.type !== "BlockStatement") return;
      const statements = (body.body as AstNode[] | undefined) ?? [];
      if (statements.length > 0) return;

      const start = body.start as number | undefined;
      const end = body.end as number | undefined;
      if (typeof start !== "number" || typeof end !== "number") return;

      const comments = commentsWithin(start, end);
      if (comments.length === 0) return; // a bare `{}` is a deliberate no-op

      const text = comments.join("\n");
      // The author saying the emptiness is intended answers the question.
      if (DELIBERATE.test(text)) return;
      if (!comments.some(saysUnfinished)) return;

      const name =
        (node.id as AstNode | undefined)?.name ??
        ((node.parent as AstNode | undefined)?.type === "VariableDeclarator"
          ? ((node.parent as AstNode).id as AstNode | undefined)?.name
          : undefined);

      ctx.report(
        node,
        `${typeof name === "string" ? `\`${name}\`` : "This function"} has no body — only a comment saying it was never written. It returns \`undefined\` silently: nothing throws, nothing logs, and the caller gets a value that is falsy now and \`NaN\` once it reaches arithmetic. Implement it, or \`throw\` so the gap fails on the first call instead of three layers away.`,
      );
    };

    return {
      FunctionDeclaration: check,
      FunctionExpression: check,
      ArrowFunctionExpression: check,
    };
  },
});
