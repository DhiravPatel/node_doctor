import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, unwrapChain, isFunctionLike } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";

/**
 * OPT-IN (defaultEnabled: false). An identity string — username, email, tenant
 * slug, handle — that is compared (or gated on) after the author folded case or
 * trimmed whitespace, but WITHOUT Unicode normalization. Case-folding and
 * trimming collapse only a tiny slice of "looks the same" collisions; Unicode
 * has many more. `admin` and `аdmin` (Cyrillic `а`, U+0430) render identically
 * yet compare as distinct byte sequences, as do the `ﬁ` ligature vs `fi`, and
 * NFC vs NFD forms of the same accented letter. An attacker registers the
 * homoglyph twin of an existing identity, or two "different" strings collapse to
 * one after a downstream NFKC pass — enabling account spoofing and duplicate
 * identities.
 *
 * WHY THIS SHAPE, AND WHY OPT-IN. `toLowerCase()`, `trim()` and `===` are
 * everywhere, so any broad reading of this class is a false-positive machine.
 * The one high-signal shape is *demonstrated canonicalization intent on an
 * identity value with the Unicode step omitted*: the author reached for
 * `.toLowerCase()` / `.toLocaleLowerCase()` / `.trim()` on a value whose name
 * says "identity" — they clearly meant "canonicalize before comparing" — yet
 * left out `.normalize()`. That co-occurrence is what makes the omission a real
 * bug rather than an incidental string compare, and it still ships disabled so
 * a team turns it on deliberately for the files where identity comparisons live.
 *
 * FIRES ONLY WHEN all hold on an equality BinaryExpression (`===`/`!==`/`==`/`!=`):
 *   1. at least one operand is IDENTITY-shaped (an identifier or member-tail
 *      whose lowercased name is username/email/login/handle/slug/tenant/… ), AND
 *   2. at least one operand shows CANONICALIZATION intent — its outermost call is
 *      `.toLowerCase()` / `.toLocaleLowerCase()` / `.trim()`, AND
 *   3. NEITHER operand already calls `.normalize(` anywhere in its subtree.
 *
 * ❌ if (username.toLowerCase() === input.toLowerCase()) grant();
 * ❌ if (email.trim() === stored) merge();
 * ✅ if (username.normalize("NFKC").toLowerCase() === input.normalize("NFKC").toLowerCase()) grant();
 * ✅ if (user.canonicalEmail === stored) merge();   // compare a stored canonical form
 *
 * DELIBERATE SILENCE (this rule's entire value is being quiet):
 *   - `a === b` — no identity name and no canonicalization: far too broad.
 *   - `role === "admin"` — identity-ish maybe, but no canonicalization intent.
 *   - a comparison to a LITERAL constant — `slug.toLowerCase() === "admin"` (a
 *     reserved-name / allowlist check) or `email.trim() === ""` (an emptiness
 *     check). A homoglyph twin cannot equal a fixed literal, so the collision this
 *     rule is about cannot arise; normalization is irrelevant there. The bug needs
 *     two DYNAMIC identity values (`input.toLowerCase() === stored.toLowerCase()`).
 *   - anything that already `.normalize(`s either side (the author handled it).
 *   - numeric/boolean/`.length` comparisons (`count === 0`, `name.length === 3`):
 *     no identity name, no canonicalization — never in scope.
 *   - the "compare by code-unit length" and "bare toLowerCase, no compare"
 *     sub-cases: too noisy to carry, intentionally NOT attempted.
 */

const EQUALITY_OPS = new Set(["===", "!==", "==", "!="]);

/** String methods that fold case or whitespace but NOT Unicode form. */
const CANON_METHODS = new Set(["toLowerCase", "toLocaleLowerCase", "trim"]);

/**
 * An operand's name is "identity-shaped" when its lowercased identifier or
 * member-tail is one of these tokens (with `_`/word boundaries so `user_name`
 * and `userId` match but `useremail`/`emailAddress` — no boundary once
 * lowercased — do not; keeping it narrow is the point).
 */
const IDENTITY_RE =
  /(^|_|\b)(username|user_?name|email|e_?mail|login|handle|slug|tenant|account|userid|nickname)($|_|\b)/;

/** The identifier name or member-tail of a node, or null (computed string keys included). */
const nameOf = (node: AstNode | null | undefined): string | null => {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression") {
    if (!node.computed && node.property?.type === "Identifier") return node.property.name;
    if (node.computed && node.property?.type === "Literal" && typeof node.property.value === "string") {
      return node.property.value;
    }
  }
  return null;
};

/**
 * Peel trailing method calls off an operand to reach the value being compared —
 * `user.username.toLowerCase()` → `user.username`, `email.trim()` → `email` —
 * so the identity check sees the receiver, not the call result.
 */
const unwrapCalls = (node: AstNode | null | undefined): AstNode | null => {
  let n = unwrapChain(node);
  while (n && n.type === "CallExpression") {
    const callee = unwrapChain(n.callee);
    if (callee && callee.type === "MemberExpression") {
      n = unwrapChain(callee.object);
    } else {
      break;
    }
  }
  return n;
};

/** Does this operand reference an identity-shaped value? */
const isIdentityShaped = (operand: AstNode): boolean => {
  const name = nameOf(unwrapCalls(operand));
  return name !== null && IDENTITY_RE.test(name.toLowerCase());
};

// A CONSTANT_CASE identifier/member-tail (`ADMIN`, `Roles.RESERVED`) — a named
// reserved-value/enum constant.
const CONSTANT_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/**
 * Is this operand a fixed CONSTANT — a string/number literal, a no-substitution
 * template literal (`` `admin` ``), or a CONSTANT_CASE name (`Roles.ADMIN`)? A
 * homoglyph twin can never equal a fixed constant, so a comparison against one is a
 * reserved-name/allowlist/emptiness check, not the identity-vs-identity collision
 * this rule is about. The bug needs two DYNAMIC values.
 */
const isConstantOperand = (node: AstNode | null | undefined): boolean => {
  if (!node) return false;
  if (node.type === "Literal") return true;
  if (node.type === "TemplateLiteral" && ((node.expressions as AstNode[] | undefined)?.length ?? 0) === 0) return true;
  const name = nameOf(node);
  return name !== null && CONSTANT_NAME_RE.test(name);
};

/** Does this operand's outermost call fold case/whitespace (canonicalization intent)? */
const hasCanonIntent = (operand: AstNode): boolean => {
  const n = unwrapChain(operand);
  if (!n || n.type !== "CallExpression") return false;
  return CANON_METHODS.has(getMethodName(n) ?? "");
};

/** Does this operand already normalize Unicode anywhere in its subtree? */
const hasNormalize = (operand: AstNode): boolean =>
  collectDescendants(
    operand,
    (n) => n.type === "CallExpression" && getMethodName(n) === "normalize",
    isFunctionLike,
    true,
  ).length > 0;

export const noUnnormalizedIdentityComparison = defineDiagnostic({
  id: "no-unnormalized-identity-comparison",
  title: "Identity compared after case/whitespace folding but without Unicode normalization",
  severity: "warn",
  category: "Security",
  scope: "file",
  confidence: "high",
  defaultEnabled: false,
  tags: ["identity", "unicode"],
  recommendation:
    'Normalize both sides before comparing: `a.normalize("NFKC").toLowerCase() === b.normalize("NFKC").toLowerCase()` (normalize first, case-fold after), or compare a stored canonical form. Case-folding and trimming do not collapse homoglyphs or compatibility characters, so `admin` and `аdmin` (Cyrillic `а`) stay distinct.',
  create: (ctx) => ({
    BinaryExpression: (node) => {
      if (!EQUALITY_OPS.has(node.operator)) return;
      const left = node.left as AstNode;
      const right = node.right as AstNode;

      // Comparing an identity to a fixed CONSTANT (a literal, a no-substitution
      // template, or a CONSTANT_CASE enum like `Roles.ADMIN`) is a reserved-name /
      // allowlist / emptiness check, not an identity-vs-identity match — a homoglyph
      // twin can never equal a fixed constant, so normalization is beside the point.
      // The bug needs two dynamic values; require both operands to be non-constant.
      if (isConstantOperand(left) || isConstantOperand(right)) return;
      // Condition 1 — at least one identity-shaped operand, else far too broad.
      if (!isIdentityShaped(left) && !isIdentityShaped(right)) return;
      // Condition 2 — at least one operand shows canonicalization intent.
      if (!hasCanonIntent(left) && !hasCanonIntent(right)) return;
      // Condition 3 — the author already normalizes → they handled it; stay silent.
      if (hasNormalize(left) || hasNormalize(right)) return;

      ctx.report(
        node,
        'This comparison folds case/whitespace but not Unicode form, so homoglyphs and compatibility characters compare as distinct (Cyrillic `а` vs Latin `a`, the `ﬁ` ligature vs `fi`) — enabling identity spoofing and duplicate accounts. Normalize both sides with `.normalize("NFKC")` before comparing, or compare a stored canonical form.',
      );
    },
  }),
});
