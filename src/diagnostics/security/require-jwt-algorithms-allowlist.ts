import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, getReceiverName, getObjectProperty } from "../../core/ast.ts";

/**
 * `jwt.verify(token, key)` called without an `algorithms` allowlist. When the
 * verifier does not pin the accepted algorithms, an RS256 verifier can be
 * tricked into treating the RSA *public* key as an HMAC secret: the attacker
 * signs an `HS256` token with the well-known public key and it verifies. Pinning
 * the algorithm closes this algorithm-confusion attack.
 *
 * Only fires for a `jwt`/`jsonwebtoken`-shaped receiver so unrelated `.verify`
 * methods (argon2.verify, crypto.verify) are never touched.
 *
 * ❌ jwt.verify(token, secret);
 * ❌ jwt.verify(token, secret, { issuer: "me" });   // no algorithms
 * ✅ jwt.verify(token, secret, { algorithms: ["RS256"] });
 */

const JWT_RECEIVER_RE = /(^|\.)(jwt|jsonwebtoken)$/i;

export const requireJwtAlgorithmsAllowlist = defineDiagnostic({
  id: "require-jwt-algorithms-allowlist",
  title: "jwt.verify without an algorithms allowlist",
  severity: "warn",
  category: "Security",
  tags: ["auth", "crypto"],
  requires: ["jsonwebtoken"],
  recommendation:
    "Always pass an explicit allowlist, e.g. `jwt.verify(token, key, { algorithms: ['RS256'] })`. Without it, an RS256 verifier can be confused into accepting an HS256 token signed with the public key.",
  create: (ctx) => ({
    CallExpression: (node) => {
      if (getMethodName(node) !== "verify") return;
      const receiver = getReceiverName(node);
      if (!receiver || !JWT_RECEIVER_RE.test(receiver)) return;

      const args = (node.arguments as AstNode[]) ?? [];
      const options = args[2];

      // No options object at all → no allowlist.
      if (!options) {
        ctx.report(node, "`jwt.verify` is called without an `algorithms` allowlist — this permits algorithm-confusion attacks.");
        return;
      }

      // An options object that is a literal we can inspect: require `algorithms`.
      // If options is a variable/spread we cannot see, stay silent (precision).
      if (options.type === "ObjectExpression") {
        if (!getObjectProperty(options, "algorithms")) {
          ctx.report(node, "`jwt.verify` options omit the `algorithms` allowlist — pin the accepted algorithms to prevent algorithm confusion.");
        }
      }
    },
  }),
});
