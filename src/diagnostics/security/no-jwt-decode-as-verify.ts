import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, rootObjectName, findEnclosingFunction } from "../../core/ast.ts";
import { findDescendant } from "../../core/walk.ts";

/**
 * `jwt.decode()` used where the result steers an authorization decision.
 * `decode` parses the payload *without checking the signature* — anyone can mint
 * `{"role":"admin"}`. Decoding to read `exp` for a refresh heuristic is fine and
 * not flagged.
 *
 * ❌ const claims = jwt.decode(token); if (claims.role !== "admin") ...
 * ✅ const claims = jwt.verify(token, secret, { algorithms: ["RS256"] });
 * ✅ const { exp } = jwt.decode(token); if (exp * 1000 < Date.now()) refresh();
 */

const AUTHZ_FIELDS = new Set([
  "role",
  "roles",
  "admin",
  "isadmin",
  "scope",
  "scopes",
  "permission",
  "permissions",
  "sub",
  "userid",
  "uid",
  "tenant",
  "tenantid",
  "org",
  "orgid",
  "groups",
]);

const isAuthzMember = (node: AstNode): boolean => {
  if (node.type !== "MemberExpression") return false;
  const prop =
    !node.computed && node.property?.type === "Identifier"
      ? node.property.name
      : node.property?.type === "Literal" && typeof node.property.value === "string"
        ? node.property.value
        : null;
  return !!prop && AUTHZ_FIELDS.has(prop.toLowerCase());
};

export const noJwtDecodeAsVerify = defineDiagnostic({
  id: "no-jwt-decode-as-verify",
  title: "jwt.decode() result used for authorization",
  severity: "error",
  category: "Security",
  requires: ["jsonwebtoken"],
  tags: ["auth", "secrets"],
  recommendation:
    "Use `jwt.verify(token, key, { algorithms: [...] })` for any decision that trusts the claims. `jwt.decode` skips the signature check, so its claims are attacker-controlled.",
  create: (ctx) => ({
    CallExpression: (node) => {
      if (getMethodName(node) !== "decode") return;
      const root = rootObjectName(node.callee);
      if (!root || !/jwt|jsonwebtoken/i.test(root)) return;

      const parent = node.parent as AstNode | undefined;

      // Direct: jwt.decode(token).role
      if (parent?.type === "MemberExpression" && parent.object === node && isAuthzMember(parent)) {
        ctx.report(node, "`jwt.decode()` result is read for an authorization field without verifying the signature.");
        return;
      }

      if (parent?.type === "VariableDeclarator") {
        // Destructured: const { role } = jwt.decode(token)
        if (parent.id?.type === "ObjectPattern") {
          const destructuresAuthz = (parent.id.properties as AstNode[]).some((p) => {
            const key = p.key;
            const name = key?.type === "Identifier" ? key.name : key?.type === "Literal" ? String(key.value) : "";
            return AUTHZ_FIELDS.has(name.toLowerCase());
          });
          if (destructuresAuthz) {
            ctx.report(node, "`jwt.decode()` claims are destructured into authorization fields without verifying the signature.");
          }
          return;
        }
        // Assigned: const claims = jwt.decode(token); … claims.role …
        if (parent.id?.type === "Identifier") {
          const name = parent.id.name;
          const scope = findEnclosingFunction(node) ?? ctx.program;
          const used = findDescendant(
            scope,
            (n) => n.type === "MemberExpression" && n.object?.type === "Identifier" && n.object.name === name && isAuthzMember(n),
          );
          if (used) {
            ctx.report(node, "`jwt.decode()` result drives an authorization decision without verifying the signature.");
          }
        }
      }
    },
  }),
});
