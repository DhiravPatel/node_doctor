import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, getStaticStringValue, findEnclosingFunction } from "../../core/ast.ts";
import { findDescendant } from "../../core/walk.ts";

/**
 * MD5/SHA-1 used in a password-storage context. Fast hashes are exactly wrong for
 * passwords — a commodity GPU does billions of guesses a second. Password hashing
 * wants a slow, salted, memory-hard KDF (argon2/scrypt/bcrypt). A fast hash for
 * an ETag or cache key is fine and not flagged (context-gated).
 *
 * ❌ function hashPassword(pw) { return crypto.createHash("md5").update(pw).digest("hex"); }
 * ✅ await argon2.hash(password);
 * ✅ function etagFor(body) { return crypto.createHash("md5").update(body).digest("hex"); }
 */

const WEAK_ALG_RE = /^(md5|md4|sha-?1)$/i;
const PASSWORD_RE = /(password|passwd|passphrase|pwd|credential)/i;

export const noWeakHashForPassword = defineDiagnostic({
  id: "no-weak-hash-for-password",
  title: "Weak hash (MD5/SHA-1) for password storage",
  severity: "error",
  category: "Security",
  tags: ["crypto", "secrets"],
  recommendation:
    "Use a slow, salted, memory-hard KDF for passwords: `argon2.hash(pw)`, `scrypt`, or `bcrypt`. MD5/SHA-1 are GPU-crackable at billions of guesses per second.",
  create: (ctx) => ({
    CallExpression: (node) => {
      if (getMethodName(node) !== "createHash") return;
      const algo = getStaticStringValue((node.arguments as AstNode[])[0]);
      if (!algo || !WEAK_ALG_RE.test(algo)) return;

      const scope = findEnclosingFunction(node) ?? ctx.program;
      const fnName = scope.id?.type === "Identifier" ? scope.id.name : "";
      const passwordContext =
        PASSWORD_RE.test(fnName) ||
        findDescendant(scope, (n) => n.type === "Identifier" && PASSWORD_RE.test(n.name)) !== null;
      if (!passwordContext) return;

      ctx.report(
        node,
        `\`createHash("${algo}")\` in a password context is GPU-crackable — use a slow KDF (argon2/scrypt/bcrypt) instead.`,
      );
    },
  }),
});
