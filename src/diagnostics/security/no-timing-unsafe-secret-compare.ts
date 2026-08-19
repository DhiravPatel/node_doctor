import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { staticMemberPath } from "../../core/ast.ts";

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

/**
 * The COUNTERPART of a secret, in a comparison where only one side is named like
 * one.
 *
 * Requiring BOTH operands to look secret-shaped made the rule quietest on the
 * code it exists for. A webhook HMAC check reads
 * `headerData["x-hub-signature-256"] !== `sha256=${computed}`` — one side is a
 * header string, the other a template literal — and an API-key gate reads
 * `apiKey !== env.get("INTERNAL_API_KEY")`. Neither has two secret-shaped
 * identifiers, so neither fired, while both leak a byte-at-a-time prefix oracle
 * an attacker uses to forge a valid signature. Seventeen such sites were found in
 * the corpus, including three n8n trigger nodes comparing a Meta HMAC and two
 * AdonisJS auth middlewares.
 *
 * These four shapes are the closed set that can only be a secret's counterpart:
 */
const COUNTERPART_NAME_RE = [
  // `pass` as its own word. Written as three alternations rather than one
  // case-insensitive pattern on purpose: `/[a-z]Pass/i` would match `bypass`.
  // `bypass`, `passed`, `compass`, `passenger`, `passthrough` all miss;
  // `ADMIN_PASS`, `providedAuth.pass`, `GOOGLE_LOCAL_PASS` all hit.
  /(?:^|[^a-zA-Z])pass(?:[^a-zA-Z]|$)|[a-z]Pass(?:[^a-z]|$)|(?:^|[^A-Za-z])PASS(?:[^A-Za-z]|$)/,
  // The two words a developer reaches for when holding the value to match.
  /^(expected|provided)/i,
];

/** Getters through which a secret arrives from a header, env var or query. */
const SECRET_ACCESSORS = new Set(["get", "header", "getHeader", "input", "env"]);

const isSecretCounterpart = (node: AstNode): boolean => {
  // (a) the wire format the secret is wrapped in: `` `sha256=${computed}` ``
  if (node.type === "TemplateLiteral") {
    return ((node.expressions as AstNode[] | undefined) ?? []).some((e) => isSecretShaped(e));
  }
  // (b) `env.get("INTERNAL_API_KEY")`, `request.input("secret")`, `headers.get("x-webhook-signature")`
  if (node.type === "CallExpression") {
    const callee = node.callee as AstNode | undefined;
    const method =
      callee?.type === "MemberExpression" && (callee.property as AstNode | undefined)?.type === "Identifier"
        ? String((callee.property as AstNode).name)
        : null;
    if (method === null || !SECRET_ACCESSORS.has(method)) return false;
    const arg = ((node.arguments as AstNode[] | undefined) ?? [])[0];
    const literal = arg?.type === "Literal" && typeof arg.value === "string" ? arg.value : null;
    return literal !== null && (SECRET_RE.test(literal.replace(/[-_]/g, "")) || ABBREVIATED_SIG_RE.test(literal));
  }
  // (c)/(d) a name that can only be the other half of a secret check.
  const name = operandName(node);
  if (name === null) return false;
  return COUNTERPART_NAME_RE.some((re) => re.test(name));
};

/**
 * A password-confirmation check, where there is no oracle to leak.
 *
 * `if (password !== confirmPassword)` compares two values THE SAME SUBMITTER just
 * supplied, in the same request. An attacker learning that their own two strings
 * differ learns nothing, and there is no stored secret to recover byte by byte —
 * so a constant-time compare would be pure ceremony. Fifteen corpus findings were
 * this, all in registration and change-password forms.
 *
 * Both conditions are required. The name test alone would silence
 * `confirmationToken !== token`, which IS a real check against a stored value;
 * demanding an actual password word in BOTH operands closes that, and demanding
 * they be structural siblings (two bare names, or two fields of the same object)
 * keeps `user.passwordHash !== req.body.password` firing.
 */
const PASSWORD_WORD_RE = /(password|passwd|pwd)/i;

const isPasswordConfirmationPair = (left: AstNode, right: AstNode): boolean => {
  const ln = operandName(left);
  const rn = operandName(right);
  if (ln === null || rn === null) return false;
  if (!PASSWORD_WORD_RE.test(ln) || !PASSWORD_WORD_RE.test(rn)) return false;
  if (left.type === "Identifier" && right.type === "Identifier") return true;
  if (left.type === "MemberExpression" && right.type === "MemberExpression" && !left.computed && !right.computed) {
    return staticMemberPath(left.object as AstNode) === staticMemberPath(right.object as AstNode);
  }
  return false;
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

      const leftSecret = isSecretShaped(l);
      const rightSecret = isSecretShaped(r);
      // Either both sides are named like secrets, or one is and the other is a
      // shape that can only be its counterpart — a header, an env lookup, or the
      // wire format it is wrapped in.
      const isSecretCompare =
        (leftSecret && rightSecret) ||
        (leftSecret && isSecretCounterpart(r)) ||
        (rightSecret && isSecretCounterpart(l));
      if (!isSecretCompare) return;

      // Two values the same submitter just supplied leak nothing to that submitter.
      if (isPasswordConfirmationPair(l, r)) return;

      ctx.report(
        node,
        "A secret is compared with `===`, whose early exit on the first differing byte leaks a timing oracle — an attacker recovers the value one byte at a time and forges it. Use `crypto.timingSafeEqual` after a length check.",
      );
    },
  }),
});
