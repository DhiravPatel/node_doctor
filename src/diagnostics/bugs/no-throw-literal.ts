import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode, Visitors, DiagnosticContext } from "../../core/types.ts";

/**
 * `throw` of a value that is provably NOT an `Error` instance — a string, a
 * number, a boolean, `null`/`undefined`, an object literal, an array, or a
 * template string.
 *
 * WHY THIS BITES IN PRODUCTION
 *   A thrown non-Error carries no `.stack`, so the log line that would have
 *   pointed at the failing frame is gone — you get `throw "boom"` and a bare
 *   "boom" with no trace. It also breaks the near-universal `catch (e) { if (e
 *   instanceof Error) … }` shape (the guard silently takes the wrong branch),
 *   and it serializes uselessly: an object literal logs as `[object Object]`
 *   and a string loses its type. The fix is always `throw new Error(...)` (or a
 *   subclass) so the stack and `instanceof` contract hold.
 *
 * PRECISION — sound toward silence (§3.4). We fire ONLY when we can prove the
 * thrown value is a non-Error:
 *   - a direct Literal / ObjectExpression / ArrayExpression / TemplateLiteral, or
 *   - a `const` identifier whose initializer is one of those (a `let`/`var`
 *     could be reassigned to an Error before the throw, so those stay silent).
 * Everything else is left alone: `throw new X(...)` (any NewExpression — Error
 * or an unknown class we assume is Error-like), `throw factory()` (a call may
 * return an Error), and `throw err` on an unresolved/caught identifier (it could
 * well be a real Error — a re-throw in a `catch` is exactly this shape).
 *
 * ❌ throw "user not found";                 // no stack, breaks instanceof Error
 * ❌ throw { code: "ENOENT", message: "…" }; // serializes as [object Object]
 * ✅ throw new Error("user not found");
 * ✅ catch (err) { throw err; }              // re-throw — left alone
 */

/** Node types that construct a plainly non-Error value inline. */
const NON_ERROR_LITERAL_TYPES = new Set([
  "Literal",
  "ObjectExpression",
  "ArrayExpression",
  "TemplateLiteral",
]);

/** Is this node a syntactic non-Error value (literal/object/array/template)? */
const isNonErrorLiteralNode = (node: AstNode | null | undefined): boolean =>
  !!node && NON_ERROR_LITERAL_TYPES.has(node.type);

/** A short human description of the thrown value, for the message. */
const describeThrown = (node: AstNode): string => {
  switch (node.type) {
    case "ObjectExpression":
      return "an object literal";
    case "ArrayExpression":
      return "an array literal";
    case "TemplateLiteral":
      return "a template string";
    case "Literal": {
      if (node.regex) return "a RegExp literal";
      if (node.value === null) return "null";
      if (typeof node.bigint === "string" || typeof node.value === "bigint") return "a BigInt";
      const kind = typeof node.value;
      if (kind === "string") return "a string";
      if (kind === "number") return "a number";
      if (kind === "boolean") return "a boolean";
      return "a non-Error value";
    }
    default:
      return "a non-Error value";
  }
};

/**
 * Resolve a thrown Identifier to a provably-non-Error initializer, or null.
 * Only `const` bindings are trusted: a reassignable binding may hold an Error by
 * the time the throw runs, so proving its initializer is a literal proves
 * nothing. A bare `undefined` (the global, no binding) is itself non-Error.
 */
const nonErrorInitFor = (arg: AstNode, ctx: DiagnosticContext): AstNode | null => {
  const binding = ctx.scope.getBinding(arg.name, arg);
  if (!binding) {
    // `throw undefined` — the global identifier, no local binding shadows it.
    return arg.name === "undefined" ? arg : null;
  }
  if (binding.kind !== "const") return null;
  const init = binding.initNode;
  return init && isNonErrorLiteralNode(init) ? init : null;
};

export const noThrowLiteral = defineDiagnostic({
  id: "no-throw-literal",
  title: "Thrown value is not an Error",
  severity: "warn",
  category: "Bugs",
  scope: "file",
  tags: ["error-handling"],
  defaultEnabled: true,
  confidence: "high",
  recommendation:
    "Throw an Error instance: `throw new Error(message)` (or a subclass). Only an Error carries a stack trace, satisfies `instanceof Error` handlers, and serializes to a readable message.",
  create: (ctx): Visitors => ({
    ThrowStatement: (node) => {
      const arg = node.argument as AstNode | null | undefined;
      if (!arg) return;

      if (isNonErrorLiteralNode(arg)) {
        ctx.report(arg, `\`throw\` of ${describeThrown(arg)} — throw \`new Error(...)\` instead so the error carries a stack trace and passes \`instanceof Error\`.`);
        return;
      }

      // An identifier: report only when it provably resolves to a non-Error.
      // Unresolved names (including a caught `catch (err)` param, which this
      // scope model does not bind) stay silent — they may be real Errors.
      if (arg.type === "Identifier") {
        const init = nonErrorInitFor(arg, ctx);
        if (init) {
          ctx.report(arg, `\`throw\` of ${describeThrown(init)} value \`${arg.name}\` — throw \`new Error(...)\` instead so the error carries a stack trace and passes \`instanceof Error\`.`);
        }
        return;
      }

      // NewExpression, CallExpression, MemberExpression, etc. — could be an
      // Error (or Error-producing). Sound toward silence.
    },
  }),
});
