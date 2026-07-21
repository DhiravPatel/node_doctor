import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { staticMemberPath } from "../../core/ast.ts";
import { SECRET_NAME_RE, KEY_PREFIX_RE, PLACEHOLDER_RE, looksSecretLike } from "../../core/secret-patterns.ts";

/**
 * A credential embedded as a string literal in source. Committed secrets live
 * forever in git history, ship in every clone, and cannot be rotated without a
 * code change. This diagnostic fires two ways: a literal whose *name* is secret-shaped
 * (password, apiKey, private key, …), or a literal whose *shape* matches a known
 * provider key prefix (`sk_live_`, `AKIA`, `ghp_`, `xoxb-`, `AIza`, PEM blocks).
 *
 * ❌ const apiKey = "a1b2c3d4e5f6g7h8i9j0";
 * ❌ const key = "sk_live_51H8x…";
 * ✅ const apiKey = process.env.API_KEY;
 * ✅ const apiKey = "changeme";           // obvious placeholder
 *
 * Stays silent for: placeholders, strings under 8 chars, `process.env` reads,
 * and dictionary-word values with no secret-like entropy.
 */

/** The binding name a string literal is assigned to, via its parent context. */
const assignedName = (node: AstNode): string | null => {
  const parent = node.parent;
  if (!parent) return null;
  if (parent.type === "VariableDeclarator" && parent.init === node && parent.id?.type === "Identifier") {
    return parent.id.name;
  }
  if (parent.type === "AssignmentExpression" && parent.right === node) {
    const path = staticMemberPath(parent.left);
    return path ? path.split(".").pop()! : null;
  }
  if (parent.type === "Property" && parent.value === node && !parent.computed) {
    const key = parent.key;
    if (key?.type === "Identifier") return key.name;
    if (key?.type === "Literal" && typeof key.value === "string") return key.value;
  }
  return null;
};

export const noHardcodedSecretLiteral = defineDiagnostic({
  id: "no-hardcoded-secret-literal",
  title: "Hardcoded credential literal",
  severity: "error",
  category: "Security",
  tags: ["secrets"],
  recommendation:
    "Load secrets from the environment (`process.env.X`) or a secret manager (AWS Secrets Manager, Vault). Never commit a credential — it lives forever in git history and cannot be rotated without a code change.",
  create: (ctx) => ({
    Literal: (node) => {
      if (typeof node.value !== "string") return;
      const value = node.value;
      if (value.length < 8) return;

      // A known provider key shape is unambiguous — fire regardless of name.
      if (KEY_PREFIX_RE.test(value)) {
        ctx.report(node, "A credential with a recognizable provider key prefix is hardcoded in source — move it to the environment or a secret manager.");
        return;
      }

      if (PLACEHOLDER_RE.test(value)) return;
      if (!looksSecretLike(value)) return;

      const name = assignedName(node);
      if (name && SECRET_NAME_RE.test(name)) {
        ctx.report(node, `A secret-shaped binding (\`${name}\`) is assigned a hardcoded string literal — load it from the environment or a secret manager instead.`);
      }
    },
  }),
});
