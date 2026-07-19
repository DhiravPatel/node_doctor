import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { collectDescendants } from "../../core/walk.ts";

/**
 * OPT-IN (defaultEnabled: false).
 *
 * A `for` / `for...of` loop whose entire body is a single discarded
 * `await someCall(loopVar)`, where the awaited call's arguments reference *only*
 * the loop variable. Because the body does nothing but await one call keyed on
 * the current element, the iterations are independent — each `await` needlessly
 * serializes work that could run concurrently, turning N round trips into N×
 * latency.
 *
 * The diagnostic is intentionally strict to avoid false positives: it fires only when
 * there is exactly one statement, its result is thrown away (so no value feeds a
 * later iteration), and every reference in the arguments is the loop variable (so
 * no accumulator or prior result is read). Anything read across iterations makes
 * the awaits dependent and keeps the diagnostic silent.
 *
 * ❌ for (const user of users) { await sendWelcome(user); }
 * ✅ await Promise.all(users.map((user) => sendWelcome(user)));  // parallel
 * ✅ let acc = 0; for (const n of nums) { acc = await fold(acc, n); }  // dependent, silent
 */

const singleAwaitedCall = (body: AstNode | null | undefined): AstNode | null => {
  if (!body) return null;
  let stmt: AstNode | null = null;
  if (body.type === "BlockStatement") {
    const stmts = (body.body as AstNode[]) ?? [];
    if (stmts.length !== 1) return null;
    stmt = stmts[0];
  } else if (body.type === "ExpressionStatement") {
    stmt = body;
  } else {
    return null;
  }
  if (!stmt || stmt.type !== "ExpressionStatement") return null;
  const expr = stmt.expression as AstNode;
  if (!expr || expr.type !== "AwaitExpression") return null;
  const call = expr.argument as AstNode;
  if (!call || call.type !== "CallExpression") return null;
  return call;
};

const loopVarName = (node: AstNode): string | null => {
  const source = node.type === "ForOfStatement" ? node.left : node.init;
  if (!source) return null;
  if (source.type === "VariableDeclaration") {
    const decl = (source.declarations as AstNode[])?.[0];
    if (decl?.id?.type === "Identifier") return decl.id.name;
    return null;
  }
  if (source.type === "Identifier") return source.name;
  return null;
};

/** Is this Identifier a non-computed property key (a name, not a reference)? */
const isPropertyKey = (n: AstNode): boolean => {
  const p = n.parent;
  if (p?.type === "MemberExpression" && !p.computed && p.property === n) return true;
  if (p?.type === "Property" && !p.computed && p.key === n) return true;
  return false;
};

/**
 * Every reference identifier in the call's arguments must be `loopVar`, and at
 * least one must actually be it (so the call genuinely depends on the loop var).
 */
const argsOnlyReferenceLoopVar = (call: AstNode, loopVar: string): boolean => {
  const args = (call.arguments as AstNode[]) ?? [];
  if (args.length === 0) return false;
  let sawLoopVar = false;
  for (const arg of args) {
    const idents = collectDescendants(arg, (n) => n.type === "Identifier", undefined, true);
    for (const id of idents) {
      if (isPropertyKey(id)) continue;
      if (id.name !== loopVar) return false;
      sawLoopVar = true;
    }
  }
  return sawLoopVar;
};

export const noAwaitInLoopOverIndependentWork = defineDiagnostic({
  id: "no-await-in-loop-over-independent-work",
  title: "Sequential await over independent work in a loop",
  severity: "warn",
  category: "Performance",
  tags: ["async", "performance"],
  defaultEnabled: false,
  recommendation:
    "Collect the promises and `await Promise.all(items.map((x) => work(x)))` instead of awaiting inside the loop. If the collection is caller-sized, bound the fan-out with `p-limit`.",
  create: (ctx) => {
    const check = (node: AstNode): void => {
      const loopVar = loopVarName(node);
      if (!loopVar) return;
      const call = singleAwaitedCall(node.body as AstNode);
      if (!call) return;
      if (!argsOnlyReferenceLoopVar(call, loopVar)) return;
      ctx.report(
        node,
        "Each iteration only awaits one call keyed on the loop variable — the iterations are independent and are being run sequentially instead of with `Promise.all`.",
      );
    };
    return {
      ForOfStatement: check,
      ForStatement: check,
    };
  },
});
