import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { unwrapChain, staticMemberPath } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";
import type { Binding } from "../../core/scope.ts";

/**
 * An AdonisJS request validation that is never awaited. The request is not
 * validated, every field reads `undefined`, and the validation error escapes.
 *
 *   ❌ const payload = request.validateUsing(createUserValidator);
 *      await User.create(payload);              // a Promise, not the payload
 *   ❌ const { email } = request.validateUsing(createUserValidator);
 *   ✅ const payload = await request.validateUsing(createUserValidator);
 *
 * `request.validateUsing()` returns `Promise<Infer<Schema>>` — read from
 * `@adonisjs/core`'s own declaration of `RequestValidator.validateUsing`. MEASURED
 * by running the same VineJS validator Adonis uses, against invalid input:
 *
 *   awaited      → throws ValidationError, which the framework turns into a 422
 *   NOT awaited  → typeof data.email is "undefined"
 *                  data is a Promise
 *                  the ValidationError arrives as an UNHANDLED REJECTION
 *
 * All three consequences land at once, and none of them is a validation failure
 * the caller can see:
 *
 *   - **The request is never rejected.** The 422 the framework would have sent
 *     does not happen, because the exception is inside a promise nobody awaited.
 *     Invalid input is accepted.
 *   - **Every field is `undefined`.** The handler proceeds with a Promise where
 *     it expected the validated object, so `payload.email` is `undefined` and a
 *     row is written with empty columns — or a `NOT NULL` violation fires three
 *     layers away from the cause.
 *   - **The rejection is unhandled**, which on Node ≥ 15 terminates the process
 *     by default.
 *
 * It survives review because the line is one keyword away from the correct one
 * and reads as the validated-input pattern the framework documents. It survives
 * tests because a test that posts VALID input never produces the rejection, and
 * the undefined fields only show up if the assertion looks at them.
 *
 * PRECISION MODEL. The claim is that a Promise is being used as the validated
 * payload — no inference about what the data means:
 *
 *   - The call is `<…>.validateUsing(…)` whose receiver's last segment is
 *     `request`, so `request.validateUsing(v)` and `ctx.request.validateUsing(v)`
 *     match and an unrelated `schema.validateUsing(…)` cannot.
 *   - The Promise is consumed SYNCHRONOUSLY: a member read on the call, a
 *     destructure of it, or a binding that is used somewhere without ever being
 *     awaited. That last form is what catches the expensive spelling —
 *     `const payload = request.validateUsing(v); await User.create(payload)` —
 *     where nothing reads a field, so a member-only check would miss it.
 *
 * Silent wherever the Promise is treated as one: `await request.validateUsing(…)`,
 * `return request.validateUsing(…)`, `.then`/`.catch`, `Promise.all([…])`, and a
 * binding that IS awaited later (`const p = request.validateUsing(v); const data =
 * await p`). A binding that is created and never used at all is also silent —
 * pointless, but it is `no-floating-promise`'s business, not this rule's.
 *
 * Gated on the `adonis` capability. Complements
 * `no-unawaited-adonis-auth-check`, which owns the same mistake in a CONDITION
 * position, where the consequence is an auth bypass rather than skipped
 * validation.
 */

/** Members that treat the value AS a promise, which is correct. */
const PROMISE_METHODS = new Set(["then", "catch", "finally"]);

/** Is this `<…>.request.validateUsing(…)` / `request.validateUsing(…)`? */
const isValidateUsingCall = (node: AstNode | null | undefined): boolean => {
  const call = unwrapChain(node);
  if (!call || call.type !== "CallExpression") return false;
  const callee = unwrapChain(call.callee as AstNode);
  if (!callee || callee.type !== "MemberExpression" || callee.computed) return false;
  const method = callee.property as AstNode | undefined;
  if (method?.type !== "Identifier" || String(method.name) !== "validateUsing") return false;
  const receiver = staticMemberPath(callee.object as AstNode);
  if (receiver === null) return false;
  return (receiver.split(".").pop() ?? "") === "request";
};

export const noUnawaitedAdonisValidation = defineDiagnostic({
  id: "no-unawaited-adonis-validation",
  title: "AdonisJS request validation not awaited, so the request is never validated",
  severity: "error",
  category: "Security",
  confidence: "high",
  requires: ["adonis"],
  tags: ["adonis", "validation", "async"],
  recommendation:
    "Await it: `const payload = await request.validateUsing(createUserValidator)`. `validateUsing` returns `Promise<Infer<Schema>>`, so without the `await` the handler holds a Promise instead of the payload — every field reads `undefined`, the 422 the framework would have sent never happens because the ValidationError is inside a promise nobody awaited, and that rejection is unhandled (which terminates the process by default on Node 15+).",
  create: (ctx) => {
    const report = (node: AstNode): void => {
      ctx.report(
        node,
        "`request.validateUsing()` returns a **Promise** (`Promise<Infer<Schema>>`, per `@adonisjs/core`'s own declaration), so without `await` this is not the validated payload. Measured by running Adonis's VineJS validator against invalid input: awaited it throws a `ValidationError` the framework turns into a **422**; un-awaited, `typeof data.email` is `\"undefined\"`, the request is **accepted unvalidated**, and the `ValidationError` arrives as an **unhandled rejection**. Add the `await`.",
      );
    };

    return {
      MemberExpression: (node) => {
        if (node.computed) return;
        if (!isValidateUsingCall(node.object as AstNode)) return;
        const property = node.property as AstNode | undefined;
        if (property?.type === "Identifier" && PROMISE_METHODS.has(String(property.name))) return;
        report(node);
      },

      VariableDeclarator: (node) => {
        if (!isValidateUsingCall(node.init as AstNode)) return;

        const id = node.id as AstNode | undefined;
        // `const { email } = request.validateUsing(v)` — destructuring a Promise.
        if (id?.type === "ObjectPattern" || id?.type === "ArrayPattern") {
          report(node);
          return;
        }
        if (id?.type !== "Identifier") return;

        const binding: Binding | null = ctx.scope.resolveIdentifier(id);
        if (!binding) return;

        // Every later reference to the binding. If ANY of them is awaited the
        // payload is resolved before use and there is nothing to report; if none
        // is, the Promise is being used as the payload — including when it is
        // simply passed to a write, which a member-only check would miss.
        const references = collectDescendants(ctx.program, (n) => {
          if (n.type !== "Identifier" || String(n.name) !== String(id.name)) return false;
          if (n === id) return false;
          return ctx.scope.resolveIdentifier(n) === binding;
        });
        if (references.length === 0) return; // never used — a floating promise, not this rule

        const everAwaited = references.some((reference) => {
          let current: AstNode | undefined = reference;
          for (let depth = 0; current && depth < 4; depth++) {
            const parent = current.parent as AstNode | undefined;
            if (parent?.type === "AwaitExpression") return true;
            // `await p.something` still resolves `p` first only if the await is
            // outside; a member read under an await counts as awaited.
            if (parent?.type === "MemberExpression" || parent?.type === "ChainExpression") {
              current = parent;
              continue;
            }
            return false;
          }
          return false;
        });
        if (everAwaited) return;
        report(node);
      },
    };
  },
});
