import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getCalleeName } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";

/**
 * §183 — a catch that throws away the error it caught.
 *
 * THE BUG. `catch (err) { throw new Error("failed to load user") }` destroys the
 * only evidence of what actually went wrong. The stack now starts at your
 * re-throw, so the DNS failure, the connection reset, the JSON parse error — the
 * thing you actually need at 3am — is gone. The log says "failed to load user"
 * and nothing else, and the on-call engineer has no thread to pull.
 *
 * This is the difference between an error you can act on and one you can only
 * stare at. `Error` has taken a `cause` option since Node 16.9 precisely for
 * this, and it costs one property.
 *
 *   ❌ catch (err) { throw new Error("failed to load user"); }
 *   ✅ catch (err) { throw new Error("failed to load user", { cause: err }); }
 *   ✅ catch (err) { throw new AppError("failed to load user", { cause: err }); }
 *
 * PRECISION MODEL — the rule fires only where the loss is provable:
 *
 *   - The catch must BIND its error (`catch (err)`). A bare `catch {}` never had
 *     the cause to begin with, so nothing was discarded — that is §12's business
 *     (a swallowed error), not this rule's.
 *   - The thrown value must be a NEW error constructed in that catch block.
 *     Re-throwing the original (`throw err`), throwing something derived from it,
 *     or returning it are all fine.
 *   - The bound name must appear NOWHERE in the throw expression. Passing it as
 *     `cause`, as a constructor argument, in a template, in a `.message` read —
 *     any mention at all means the author kept the thread, and the rule stays
 *     silent. This is deliberately generous: the cost of a false "you lost the
 *     cause" on code that did keep it is higher than the cost of missing one.
 *   - The error must also be otherwise unused in the block: a `logger.error(err)`
 *     before the throw means the evidence was recorded, even if the re-thrown
 *     error does not carry it.
 */

/** `new Error(...)` and the conventional subclasses/factories. */
const isErrorConstruction = (node: AstNode | undefined): boolean => {
  if (!node) return false;
  if (node.type === "NewExpression") {
    const name = getCalleeName(node.callee as AstNode);
    // Any `new XxxError(...)` — the convention is universal enough to rely on.
    return !!name && /Error$|^Error$/.test(name);
  }
  return false;
};

export const noErrorCauseDiscarded = defineDiagnostic({
  id: "no-error-cause-discarded",
  title: "Catch throws a new error and discards the original",
  severity: "warn",
  category: "Reliability",
  confidence: "high",
  tags: ["reliability", "observability", "debuggability"],
  defaultEnabled: false,
  recommendation:
    "Attach the original as the cause: `throw new Error(\"failed to load user\", { cause: err })`. Without it the stack starts at your re-throw and the real failure — the connection reset, the parse error — is gone, leaving whoever is on call at 3am with a message and no thread to pull.",
  create: (ctx) => ({
    CatchClause: (node) => {
      // A bare `catch {}` never had a cause to discard — that is a different bug.
      const param = node.param as AstNode | undefined;
      if (param?.type !== "Identifier") return;
      const errorName = param.name as string;
      const body = node.body as AstNode | undefined;
      if (!body) return;

      // Every mention of the bound error anywhere in the block. If the author
      // touched it at all — logged it, wrapped it, read its message — the thread
      // was not lost, and this rule has nothing to say.
      const mentions = collectDescendants(
        body,
        (n) => n.type === "Identifier" && n.name === errorName,
        undefined,
        true,
      );

      for (const statement of collectDescendants(
        body,
        (n) => n.type === "ThrowStatement",
        // A throw inside a NESTED function has its own error context.
        (n) =>
          n.type === "FunctionDeclaration" ||
          n.type === "FunctionExpression" ||
          n.type === "ArrowFunctionExpression",
        true,
      )) {
        const thrown = statement.argument as AstNode | undefined;
        if (!isErrorConstruction(thrown)) continue;

        // Does the bound error appear anywhere inside the thrown expression?
        const usedInThrow = collectDescendants(
          thrown!,
          (n) => n.type === "Identifier" && n.name === errorName,
          undefined,
          true,
        ).length > 0;
        if (usedInThrow) continue;

        // Used elsewhere in the block (logged, inspected)? Then it was recorded.
        if (mentions.length > 0) continue;

        ctx.report(
          thrown!,
          `This catch binds \`${errorName}\` and then throws a new error without it, so the original failure — its type, message and stack — is discarded. Whoever debugs this sees only the replacement message. Pass \`{ cause: ${errorName} }\`.`,
        );
        break;
      }
    },
  }),
});
