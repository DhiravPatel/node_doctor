import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { unwrapChain, staticMemberPath } from "../../core/ast.ts";

/**
 * An AdonisJS auth or authorization predicate used as a condition without
 * `await`. A Promise is always truthy, so the guard never rejects anything.
 *
 *   ❌ if (!await auth.check()) → written as → if (!auth.check()) { … }
 *   ❌ if (bouncer.allows("edit", post)) { return edit(); }
 *   ✅ if (!(await auth.check())) return response.unauthorized();
 *   ✅ if (await bouncer.denies("edit", post)) return response.forbidden();
 *
 * Every one of these returns a Promise. Read from the SHIPPED type declarations
 * of `@adonisjs/auth` 9.6.0 and `@adonisjs/bouncer` 3.1.6:
 *
 *   check(): Promise<boolean>            allows(...): Promise<boolean>
 *   authenticate(): Promise<User>        denies(...): Promise<boolean>
 *   login(user): Promise<void>           authorize(...): Promise<void>
 *   logout(): Promise<void>
 *
 * And a Promise is truthy whatever it resolves to — verified by running it:
 *
 *   Boolean(Promise.resolve(false))  → true
 *   if (Promise.resolve(false))      → the branch IS taken
 *   !Promise.resolve(true)           → false
 *
 * So `if (!auth.check()) return response.unauthorized()` never returns
 * unauthorized: the negation of a truthy Promise is `false`, the guard is skipped
 * **for every request**, and the handler below runs for anonymous callers. That is
 * an authentication bypass written in one missing keyword, and it is invisible in
 * review because the line reads exactly like the correct one.
 *
 * `bouncer.allows(…)` without `await` fails the same way and in the same
 * direction — always true, so every caller is authorized. `bouncer.denies(…)`
 * without `await` is also always true, which fails CLOSED: nobody gets through,
 * which is wrong but survives review for about an hour. The bypass direction is
 * the one that ships.
 *
 * Tests do not catch it. An authenticated test passes because the branch it
 * expects is the one that runs; an anonymous test passes too, for the wrong
 * reason, unless it asserts the 401 specifically.
 *
 * PRECISION MODEL. The claim is that this expression's VALUE is used as a
 * boolean while being a Promise — no inference about what the code means:
 *
 *   - The callee is one of the async predicates above, on a receiver whose last
 *     segment is `auth` or `bouncer` (`auth.check()`, `ctx.auth.check()`,
 *     `this.bouncer.allows(…)`). Requiring that segment is what keeps the rule
 *     off every other `check()` and `allows()` in the language.
 *   - The call sits in a CONDITION position: the test of an `if`, `while`,
 *     `do…while`, ternary or `for`; an operand of `&&`, `||` or `??`; or the
 *     argument of `!`. A call whose result is awaited, returned, assigned or
 *     passed on is not claimed here — a floating auth promise is a different
 *     defect, and `no-floating-promise` already owns it.
 *
 * `await auth.check()` and `(await bouncer.allows(…))` are silent by
 * construction: the awaited value is a boolean, not a Promise.
 *
 * Gated on the `adonis` capability.
 */

/** Async predicates whose Promise is always truthy in a condition. */
const AUTH_PREDICATES = new Set(["check", "authenticate", "allows", "denies", "authorize"]);

/** The receiver segment that proves this is Adonis's auth or authorization API. */
const AUTH_RECEIVERS = new Set(["auth", "bouncer"]);

/** Is `node` the async auth predicate call? Returns "<receiver>.<method>". */
const authPredicateCall = (node: AstNode | null | undefined): string | null => {
  const call = unwrapChain(node);
  if (!call || call.type !== "CallExpression") return null;
  const callee = unwrapChain(call.callee as AstNode);
  if (!callee || callee.type !== "MemberExpression" || callee.computed) return null;

  const method = callee.property as AstNode | undefined;
  if (method?.type !== "Identifier" || !AUTH_PREDICATES.has(String(method.name))) return null;

  // The receiver's LAST segment must be `auth` or `bouncer`, so `auth.check()`,
  // `ctx.auth.check()` and `this.bouncer.allows(…)` all match while an unrelated
  // `cache.check()` or `policy.allows(…)` cannot.
  const receiverPath = staticMemberPath(callee.object as AstNode);
  if (receiverPath === null) return null;
  const tail = receiverPath.split(".").pop() ?? "";
  if (!AUTH_RECEIVERS.has(tail)) return null;

  return `${tail}.${String(method.name)}`;
};

/**
 * Is this expression being used as a BOOLEAN?
 *
 * Walks out through the negations and logical operators that preserve the
 * condition position, then asks whether the enclosing node tests it.
 */
const isConditionPosition = (node: AstNode): boolean => {
  let current: AstNode = node;
  let parent = current.parent as AstNode | undefined;
  for (let depth = 0; parent && depth < 8; depth++) {
    switch (parent.type) {
      case "UnaryExpression":
        if (parent.operator !== "!") return false;
        break;
      case "LogicalExpression":
        break;
      case "IfStatement":
      case "WhileStatement":
      case "DoWhileStatement":
      case "ConditionalExpression":
        return parent.test === current;
      case "ForStatement":
        return parent.test === current;
      default:
        return false;
    }
    current = parent;
    parent = current.parent as AstNode | undefined;
  }
  return false;
};

export const noUnawaitedAdonisAuthCheck = defineDiagnostic({
  id: "no-unawaited-adonis-auth-check",
  title: "AdonisJS auth check used as a condition without await, so the guard never rejects",
  severity: "error",
  category: "Security",
  confidence: "high",
  requires: ["adonis"],
  tags: ["adonis", "auth", "async"],
  recommendation:
    "Await it: `if (!(await auth.check())) return response.unauthorized()`, `if (await bouncer.denies(\"edit\", post)) …`. AdonisJS's `auth.check()`, `auth.authenticate()`, `bouncer.allows()`, `bouncer.denies()` and `bouncer.authorize()` all return Promises, and a Promise is truthy whatever it resolves to — so without the `await` the guard's condition has a constant answer and the check is not performed at all.",
  create: (ctx) => ({
    CallExpression: (node) => {
      const call = authPredicateCall(node);
      if (call === null) return;
      // An awaited call yields a boolean; only the bare Promise is claimed.
      if ((node.parent as AstNode | undefined)?.type === "AwaitExpression") return;
      if (!isConditionPosition(node)) return;

      const [receiver, method] = call.split(".");
      ctx.report(
        node,
        `\`${receiver}.${method}()\` returns a **Promise** (per \`@adonisjs/${receiver === "auth" ? "auth" : "bouncer"}\`'s own type declarations), and a Promise is truthy whatever it resolves to — verified: \`Boolean(Promise.resolve(false))\` is \`true\`, so \`if (Promise.resolve(false))\` takes the branch and \`!Promise.resolve(true)\` is \`false\`. This condition therefore has a **constant** answer and the check never runs. Written as a guard (\`if (!${receiver}.${method}())\`) it never rejects, so the handler below executes for every caller. Add the \`await\`.`,
      );
    },
  }),
});
