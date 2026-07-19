import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";

/**
 * A secret compared with `===` instead of a constant-time comparison. `===`
 * short-circuits at the first differing byte, so response time leaks a prefix
 * oracle: an attacker recovers the secret one byte at a time.
 *
 * ❌ if (signature === expectedSignature) { ... }
 * ✅ if (a.length === b.length && crypto.timingSafeEqual(a, b)) { ... }
 */

const EQUALITY_OPS = new Set(["===", "!==", "==", "!="]);
const SECRET_RE = /(secret|token|signature|hmac|apikey|api[_-]?key|seckey|password|passwd|pwd|otp|nonce|digest)/i;

/** Extract a comparable "name" from an operand (identifier or member tail). */
const operandName = (node: AstNode): string | null => {
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression") {
    if (!node.computed && node.property?.type === "Identifier") return node.property.name;
    if (node.computed && node.property?.type === "Literal" && typeof node.property.value === "string") {
      return node.property.value;
    }
  }
  return null;
};

const isSecretShaped = (node: AstNode): boolean => {
  const name = operandName(node);
  if (!name) return false;
  return SECRET_RE.test(name.replace(/[-_]/g, ""));
};

export const noTimingUnsafeSecretCompare = defineDiagnostic({
  id: "no-timing-unsafe-secret-compare",
  title: "Secret compared with a non-constant-time operator",
  severity: "warn",
  category: "Security",
  tags: ["crypto", "secrets", "auth"],
  recommendation:
    "Compare secrets in constant time: `crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))` after a length check. `===` leaks a prefix oracle through its early exit.",
  create: (ctx) => ({
    BinaryExpression: (node) => {
      if (!EQUALITY_OPS.has(node.operator)) return;
      const l = node.left as AstNode;
      const r = node.right as AstNode;
      if (l.type === "Literal" || r.type === "Literal") return; // sentinel check, not a secret compare
      if (isSecretShaped(l) && isSecretShaped(r)) {
        ctx.report(
          node,
          "Two secret-shaped values are compared with `===` — its early exit on the first differing byte leaks a timing oracle. Use `crypto.timingSafeEqual`.",
        );
      }
    },
  }),
});
