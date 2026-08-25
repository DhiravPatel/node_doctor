import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { unwrapChain } from "../../core/ast.ts";
import type { Binding } from "../../core/scope.ts";

/**
 * A `toFixed` result used as a number. It is a **string**, so `+` concatenates.
 *
 *   ❌ const total = subtotal.toFixed(2) + tax.toFixed(2);   // "100.0018.00"
 *   ❌ let sum = 0; for (…) sum += price.toFixed(2);          // "018.0025.50"
 *   ❌ items.reduce((a, i) => a + i.price.toFixed(2), 0)      // "018.0025.50"
 *   ❌ if (balance.toFixed(2) === 0) { … }                    // NEVER true
 *   ✅ const total = Number(subtotal.toFixed(2)) + Number(tax.toFixed(2));
 *   ✅ const total = Math.round((subtotal + tax) * 100) / 100;
 *   ✅ `Total: ${subtotal.toFixed(2)}`                        // display, correct
 *
 * `Number.prototype.toFixed` returns a string — that is its entire purpose, and
 * it is the half everyone forgets. VERIFIED by running each form:
 *
 *   (100).toFixed(2) + (18).toFixed(2)   → "100.0018.00"
 *   (1.5).toFixed(2) + 5                 → "1.505"
 *   let sum = 0; sum += (1.5).toFixed(2) → "01.50"
 *   (1.5).toFixed(2) + (2 * 3)           → "1.506"
 *   [1,2].reduce((a,b) => a + b.toFixed(2), 0)  → "01.002.00"
 *   (100).toFixed(2) === 100             → false, always
 *
 * Nothing throws. The value keeps flowing — into a database column, a payment
 * amount, a webhook payload, an invoice line — and MySQL will happily coerce
 * `"100.0018.00"` on the way into a DECIMAL column, so the corruption surfaces
 * later as a total that does not add up rather than as an error anyone can trace.
 * The leading-zero form (`"018.00"` from a `sum` seeded at `0`) is the tell.
 *
 * PRECISION MODEL. Every firing shape was executed, and the claim at each is a
 * fact about the language rather than an inference about the data: this operand
 * is a string, the other is provably a number, and `+` on that pair concatenates.
 * Where the analysis cannot PROVE the other operand is numeric, it stays silent —
 * uncertainty resolves to silence, never to a report.
 *
 * Two clauses, and only two:
 *
 *   - **Concatenation where addition was meant.** A `+` (or `+=`) with a
 *     formatted-string operand and an operand that is provably numeric: a numeric
 *     literal, an arithmetic expression, a `Number`/`parseInt`/`parseFloat` call,
 *     a unary `+`/`-`, a binding initialized to a numeric literal
 *     (`let sum = 0`), or a `reduce` accumulator whose seed is a numeric literal.
 *     Two formatted operands also count: `x.toFixed(2) + y.toFixed(2)` produces
 *     digits jammed together with no separator, which is meaningless as display
 *     and can only have been meant as addition.
 *   - **A comparison that can never hold.** `===`/`!==` between a formatted
 *     string and a numeric literal. `==`/`!=` are EXCLUDED because they coerce
 *     and therefore work — verified: `(100).toFixed(2) == 100` is `true`. So are
 *     `<`/`>`/`<=`/`>=`, which coerce too: `(100).toFixed(2) > 99` is `true`.
 *     Reporting either would be reporting correct code.
 *
 * Silent, each for a reason that is structural rather than a guess:
 *
 *   - **A string literal or template operand.** `"Total: " + x.toFixed(2)` and
 *     `x.toFixed(2) + "%"` are display formatting and are correct. So is any
 *     template interpolation, which is not a `+` at all.
 *   - **The standard unwraps.** `Number(x.toFixed(2))`, `parseFloat(...)`,
 *     `parseInt(...)` and unary `+x.toFixed(2)` all yield a number before the
 *     operator sees them — verified to give 6.5 where the raw form gives "1.505".
 *   - **An operand that is merely unknown** — a bare identifier with no numeric
 *     initializer, a member expression, a call. It could be a string label, and a
 *     string label makes the concatenation correct.
 *   - **`toString()`**, deliberately. It is excluded because the name says what it
 *     returns, so `a.toString() + b.toString()` is a plausible deliberate
 *     concatenation. `toFixed` is the trap precisely because its name says
 *     "fixed decimals" and not "string".
 *
 * One hop of indirection is followed, because that is how the shape is actually
 * written — nobody composes two `toFixed` calls on one line, they assign each and
 * then combine the names:
 *
 *   const t = tax.toFixed(2);
 *   const total = subtotal.toFixed(2) + t;      // still "100.0018.00"
 *
 * The hop is keyed by BINDING, not by name, so a `t` in one function cannot make
 * a `t` in another read as a string; and it requires `const`, because a `let`
 * reassigned elsewhere is not provably a string at this use site.
 *
 * `toPrecision` and `toLocaleString` are included: both return strings by the
 * same contract, and `toLocaleString` is worse, because it also inserts group
 * separators — verified, `(1234.5).toLocaleString() + 1` is `"1,234.51"`.
 */

/** Number formatters that return a STRING. `toString` is deliberately absent. */
const FORMATTERS = new Set(["toFixed", "toPrecision", "toLocaleString"]);

/** Calls that turn a numeric string back into a number. */
const NUMERIC_COERCIONS = new Set(["Number", "parseInt", "parseFloat"]);

/** Arithmetic operators whose result is always a number. */
const ARITHMETIC_OPERATORS = new Set(["-", "*", "/", "%", "**"]);

const isNumericLiteral = (node: AstNode | null | undefined): boolean =>
  node?.type === "Literal" && typeof node.value === "number";

/** The non-computed method name of a member call, or null. */
const memberMethod = (node: AstNode | null | undefined): string | null => {
  const call = unwrapChain(node);
  if (!call || call.type !== "CallExpression") return null;
  const callee = unwrapChain(call.callee as AstNode);
  if (!callee || callee.type !== "MemberExpression" || callee.computed) return null;
  const property = callee.property as AstNode | undefined;
  return property?.type === "Identifier" ? String(property.name) : null;
};

/** A `x.toFixed(…)` / `.toPrecision(…)` / `.toLocaleString(…)` call. */
const isFormattedCall = (node: AstNode | null | undefined): boolean => {
  const method = memberMethod(node);
  return method !== null && FORMATTERS.has(method);
};

/** A plain identifier callee name (`Number`, `parseFloat`), or null. */
const calleeIdentifier = (node: AstNode | null | undefined): string | null => {
  const call = unwrapChain(node);
  if (!call || call.type !== "CallExpression") return null;
  const callee = unwrapChain(call.callee as AstNode);
  return callee?.type === "Identifier" ? String(callee.name) : null;
};

/** A string literal or template — proof the author is building display text. */
const isStringish = (node: AstNode | null | undefined): boolean => {
  const n = unwrapChain(node);
  if (!n) return false;
  if (n.type === "Literal" && typeof n.value === "string") return true;
  if (n.type === "TemplateLiteral") return true;
  return calleeIdentifier(n) === "String";
};

export const noTofixedAsNumber = defineDiagnostic({
  id: "no-tofixed-as-number",
  title: "A toFixed string used as a number, so `+` concatenates instead of adding",
  severity: "error",
  category: "Bugs",
  confidence: "high",
  tags: ["correctness", "money", "types"],
  recommendation:
    "`toFixed` returns a string. Do the arithmetic on numbers and format once at the end — `Math.round((a + b) * 100) / 100`, or `Number(a.toFixed(2)) + Number(b.toFixed(2))` if the rounding has to happen first. For money, prefer integer minor units (cents) or a decimal library over floats entirely. For an equality check, compare numbers (`Number(x.toFixed(2)) === 0`) or compare the string to a string (`x.toFixed(2) === \"0.00\"`).",
  create: (ctx) => {
    /**
     * Is this expression a formatted STRING — the call itself, or a binding
     * holding one?
     *
     * The indirection is how the shape is usually written: nobody composes two
     * `toFixed` calls on one line, they assign each and then combine the names.
     * One hop covers it, keyed by BINDING rather than by name (the same
     * discipline as the taint pass), so a `t` in one function cannot make a `t`
     * in another read as a string. `const` only: a `let` that is reassigned
     * elsewhere is no longer provably a string at this use site.
     */
    const isFormattedString = (node: AstNode | null | undefined): boolean => {
      const n = unwrapChain(node);
      if (!n) return false;
      if (isFormattedCall(n)) return true;
      if (n.type !== "Identifier") return false;
      const binding: Binding | null = ctx.scope.resolveIdentifier(n);
      return binding?.kind === "const" && isFormattedCall(binding.initNode);
    };

    /**
     * Is this expression provably a NUMBER?
     *
     * Only shapes whose numeric type is settled by syntax count. Anything else —
     * a bare identifier, a member read, an arbitrary call — is `unknown`, and
     * unknown means silence: it could be a string label, and then the
     * concatenation is what the author wanted.
     */
    const isProvablyNumeric = (node: AstNode | null | undefined, depth = 0): boolean => {
      const n = unwrapChain(node);
      if (!n || depth > 4) return false;
      if (isNumericLiteral(n)) return true;
      if (n.type === "UnaryExpression" && (n.operator === "+" || n.operator === "-")) return true;
      if (n.type === "BinaryExpression") {
        if (ARITHMETIC_OPERATORS.has(String(n.operator))) return true;
        // `+` is only numeric if BOTH sides are — otherwise it may concatenate.
        if (n.operator === "+") {
          return isProvablyNumeric(n.left as AstNode, depth + 1) && isProvablyNumeric(n.right as AstNode, depth + 1);
        }
        return false;
      }
      const callee = calleeIdentifier(n);
      if (callee !== null && NUMERIC_COERCIONS.has(callee)) return true;
      if (n.type === "Identifier") return bindingIsNumeric(n);
      return false;
    };

    /** A binding whose numeric type is settled where it was introduced. */
    const bindingIsNumeric = (identifier: AstNode): boolean => {
      const binding: Binding | null = ctx.scope.resolveIdentifier(identifier);
      if (!binding) return false;
      // `let sum = 0` / `let total = 0.0`.
      if (isNumericLiteral(binding.initNode)) return true;
      // A `reduce` accumulator seeded with a numeric literal.
      return binding.kind === "param" && isReduceAccumulatorWithNumericSeed(binding.declNode);
    };

    /**
     * Is this parameter the accumulator of a `reduce` whose seed is numeric?
     *
     * `items.reduce((a, i) => a + i.price.toFixed(2), 0)` is the money-summing
     * shape, and the seed makes `a` provably a number on the first iteration —
     * after which the concatenation has already turned it into a string.
     */
    const isReduceAccumulatorWithNumericSeed = (param: AstNode): boolean => {
      const fn = param.parent as AstNode | undefined;
      if (!fn || (fn.type !== "ArrowFunctionExpression" && fn.type !== "FunctionExpression")) return false;
      const params = (fn.params as AstNode[] | undefined) ?? [];
      if (params[0] !== param) return false;
      const call = fn.parent as AstNode | undefined;
      if (!call || call.type !== "CallExpression") return false;
      const method = memberMethod(call);
      if (method !== "reduce" && method !== "reduceRight") return false;
      const args = (call.arguments as AstNode[] | undefined) ?? [];
      return args[0] === fn && isNumericLiteral(args[1]);
    };

    const CONCATENATION =
      "`toFixed` returns a STRING, so this `+` concatenates instead of adding — the digits are jammed together (`(100).toFixed(2) + (18).toFixed(2)` is `\"100.0018.00\"`, and a `sum` seeded at 0 becomes `\"018.00\"`). Nothing throws, and the wrong value keeps flowing into whatever stores or sends it.";
    const IMPOSSIBLE =
      "`toFixed` returns a STRING and `===` does not coerce, so this comparison is ALWAYS false and the branch is dead — verified: `(100).toFixed(2) === 100` is `false`. Compare numbers, or compare the string to a string.";

    return {
      BinaryExpression: (node) => {
        const left = node.left as AstNode;
        const right = node.right as AstNode;

        if (node.operator === "+") {
          const leftFormatted = isFormattedString(left);
          const rightFormatted = isFormattedString(right);
          if (!leftFormatted && !rightFormatted) return;
          // Display formatting — a string literal or template on the other side.
          if (leftFormatted && isStringish(right)) return;
          if (rightFormatted && isStringish(left)) return;

          const bothFormatted = leftFormatted && rightFormatted;
          const otherIsNumeric = leftFormatted
            ? isProvablyNumeric(right)
            : isProvablyNumeric(left);
          if (!bothFormatted && !otherIsNumeric) return;
          ctx.report(node, CONCATENATION);
          return;
        }

        // `==`/`!=` coerce and work; `<`/`>` coerce and work. Only strict
        // equality against a number is unreachable.
        if (node.operator !== "===" && node.operator !== "!==") return;
        if (isFormattedString(left) && isNumericLiteral(right)) ctx.report(node, IMPOSSIBLE);
        else if (isFormattedString(right) && isNumericLiteral(left)) ctx.report(node, IMPOSSIBLE);
      },

      AssignmentExpression: (node) => {
        if (node.operator !== "+=") return;
        const right = node.right as AstNode;
        if (!isFormattedString(right)) return;
        const left = node.left as AstNode;
        if (left.type !== "Identifier" || !bindingIsNumeric(left)) return;
        ctx.report(node, CONCATENATION);
      },
    };
  },
});
