import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode, Visitors, DiagnosticContext } from "../../core/types.ts";
import { getCalleeName } from "../../core/ast.ts";

/**
 * A `BigInt` value coerced to a JS `number`, silently losing precision above
 * 2^53 (`Number.MAX_SAFE_INTEGER`).
 *
 * WHY THIS BITES IN PRODUCTION
 *   64-bit database ids (Postgres `bigint`/`bigserial`, Snowflake ids, Twitter
 *   ids) exceed 2^53, so `Number(row.id)` rounds to the nearest representable
 *   double and corrupts the id — two distinct rows collapse to the same number,
 *   a lookup returns the wrong record, and nothing throws. `+bigint` is worse:
 *   it throws `TypeError: Cannot convert a BigInt value to a number` at runtime.
 *   The lossless conversions are `String(x)` / `x.toString()`.
 *
 * WE FIRE ON three coercions of a value we can PROVE is a BigInt:
 *   - `Number(x)`            — rounds to a double,
 *   - `+x`                   — unary plus, which throws at runtime on a BigInt,
 *   - `parseInt(x)` / `parseFloat(x)` — stringify-then-reparse, still lossy.
 *
 * "PROVABLY A BIGINT" (§3.4 — sound toward silence). Only:
 *   - a BigInt literal (`123n`),
 *   - a `BigInt(...)` call result,
 *   - a `const` binding whose initializer is one of the above (a `let`/`var`
 *     could be reassigned to a plain number, so those stay silent).
 * We NEVER guess from a name (`id`, `bigId`): an unproven operand stays silent.
 *
 * ❌ const id = BigInt(row.id); res.json({ id: Number(id) }); // > 2^53 corrupts
 * ❌ const big = 90071992547409921n; doMath(+big);            // throws at runtime
 * ✅ const id = BigInt(row.id); res.json({ id: String(id) }); // lossless
 * ✅ String(big); big.toString();                             // lossless
 */

/** Coercion calls that turn their first argument into a JS number. */
const NUMERIC_COERCION_CALLS = new Set(["Number", "parseInt", "parseFloat"]);

/**
 * Is `node` provably a BigInt? A BigInt literal, a `BigInt(...)` result, or a
 * `const` alias chain terminating in one of those. Depth-guarded against a
 * pathological self-reference (invalid code, but never crash on it).
 */
const isKnownBigInt = (node: AstNode | null | undefined, ctx: DiagnosticContext, depth = 0): boolean => {
  if (!node || depth > 16) return false;
  // A BigInt literal surfaces as `value: <bigint>` with `bigint: "<digits>"`.
  if (node.type === "Literal" && (typeof node.value === "bigint" || typeof node.bigint === "string")) {
    return true;
  }
  // `BigInt(...)` — the constructor/converter always yields a BigInt.
  if (node.type === "CallExpression" && getCalleeName(node) === "BigInt") return true;
  // A `const` alias: resolve to its initializer and re-check.
  if (node.type === "Identifier") {
    const binding = ctx.scope.getBinding(node.name, node);
    if (!binding || binding.kind !== "const" || !binding.initNode) return false;
    return isKnownBigInt(binding.initNode, ctx, depth + 1);
  }
  return false;
};

export const noBigintPrecisionLoss = defineDiagnostic({
  id: "no-bigint-precision-loss",
  title: "BigInt coerced to a number loses precision",
  severity: "warn",
  category: "Bugs",
  scope: "file",
  tags: ["numeric"],
  defaultEnabled: true,
  confidence: "high",
  recommendation:
    "Keep 64-bit ids as BigInt or convert losslessly with `String(x)` / `x.toString()`. `Number(x)` rounds any value above 2^53 to the nearest double, and `+x` throws `TypeError` on a BigInt.",
  create: (ctx): Visitors => ({
    CallExpression: (node) => {
      const callee = getCalleeName(node);
      if (!callee || !NUMERIC_COERCION_CALLS.has(callee)) return;
      const arg = (node.arguments as AstNode[])?.[0];
      if (!isKnownBigInt(arg, ctx)) return;
      ctx.report(node, `\`${callee}(...)\` coerces a BigInt to a number — values above 2^53 are silently rounded and corrupted. Use \`String(...)\` / \`.toString()\` for a lossless conversion.`);
    },
    UnaryExpression: (node) => {
      // Only unary `+` coerces to number (and throws on a BigInt at runtime);
      // unary `-` on a BigInt stays a BigInt, so it is not a precision loss.
      if (node.operator !== "+") return;
      if (!isKnownBigInt(node.argument, ctx)) return;
      ctx.report(node, "Unary `+` on a BigInt throws `TypeError: Cannot convert a BigInt value to a number` at runtime. Use `Number(...)` only if the value fits in 2^53, or `String(...)` to keep it lossless.");
    },
  }),
});
