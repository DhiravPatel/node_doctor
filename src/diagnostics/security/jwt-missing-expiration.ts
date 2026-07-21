import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, rootObjectName, getObjectProperty } from "../../core/ast.ts";

/**
 * `jwt.sign(...)` that mints a token with no expiration — a leaked or stolen
 * token then works forever. A token needs either `expiresIn` in the options or
 * an `exp` claim in the payload.
 *
 * We only flag the cases we can *prove* are unbounded (payload is an object
 * literal with no `exp`, and options are absent or an object literal with no
 * `expiresIn`), so a token built from a variable payload is never a false positive.
 *
 * ❌ jwt.sign({ sub: id }, secret);
 * ❌ jwt.sign({ sub: id }, secret, { issuer: "api" });   // options, but no expiresIn
 * ✅ jwt.sign({ sub: id }, secret, { expiresIn: "15m" });
 * ✅ jwt.sign({ sub: id, exp: nowPlus15m }, secret);
 */

/** Does an object-literal payload carry an `exp` claim? */
const payloadHasExp = (payload: AstNode | undefined): boolean => {
  if (!payload || payload.type !== "ObjectExpression") return false;
  return getObjectProperty(payload, "exp") !== null;
};

export const jwtMissingExpiration = defineDiagnostic({
  id: "jwt-missing-expiration",
  title: "JWT signed without an expiration",
  severity: "warn",
  category: "Security",
  requires: ["jsonwebtoken"],
  tags: ["auth", "jwt"],
  recommendation:
    "Give every token a lifetime: `jwt.sign(payload, key, { expiresIn: '15m' })`, or set an `exp` claim in the payload. A token with no expiry stays valid forever if leaked.",
  create: (ctx) => ({
    CallExpression: (node) => {
      if (getMethodName(node) !== "sign") return;
      const root = rootObjectName(node.callee);
      if (!root || !/jwt|jsonwebtoken/i.test(root)) return;

      const args = (node.arguments as AstNode[] | undefined) ?? [];
      const payload = args[0];
      const options = args[2];

      // If the payload isn't an object literal we can't see whether it sets `exp`;
      // stay silent to avoid a false positive.
      if (payload && payload.type !== "ObjectExpression") return;
      if (payloadHasExp(payload)) return;

      if (options === undefined) {
        // 2-arg form, object-literal payload with no `exp` → definitely unbounded.
        ctx.report(node, "`jwt.sign` mints a token with no `expiresIn` option and no `exp` claim — it never expires.");
        return;
      }
      // Options present: only flag an object literal that provably lacks expiresIn.
      if (options.type === "ObjectExpression" && getObjectProperty(options, "expiresIn") === null) {
        ctx.report(node, "`jwt.sign` options set no `expiresIn` and the payload has no `exp` claim — the token never expires.");
      }
    },
  }),
});
