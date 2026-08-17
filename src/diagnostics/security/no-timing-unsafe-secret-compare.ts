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

/**
 * `sig` as a word of its own — the abbreviation `signature` misses.
 *
 * Webhook verification is where this rule matters most, and it is routinely
 * written `if (signature !== expectedSig)`: one operand spelled out, one
 * abbreviated. Because BOTH operands must look secret-shaped, the abbreviation
 * on either side silences the whole comparison. Measured on the corpus, this
 * token alone recovers 5 real sites the rule was missing — four
 * `signature !== expectedSig` webhook checks in one backend, and cal.com's
 * `hsSignature !== calculatedSig` Help Scout handler.
 *
 * The word boundaries are what make it safe. A bare substring `sig` would match
 * `config`, `design`, `assign`, `signal`, `signIn`, `sigma`, `origSize` and
 * `significant`; none of those match here, verified against the list.
 *
 * NOTE: this is tested against the ORIGINAL name, not the `-`/`_`-stripped one
 * `SECRET_RE` uses. Stripping would turn `expected_sig` into `expectedsig` and
 * destroy the very boundary this pattern depends on.
 */
const ABBREVIATED_SIG_RE = /(?:^|[^a-zA-Z])sig(?:[^a-zA-Z]|$)|[a-z]Sig(?:[^a-z]|$)/;

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
  // `SECRET_RE` reads a separator-free name so `api_key` and `apiKey` agree;
  // `ABBREVIATED_SIG_RE` needs the separators, which are its word boundaries.
  return SECRET_RE.test(name.replace(/[-_]/g, "")) || ABBREVIATED_SIG_RE.test(name);
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
