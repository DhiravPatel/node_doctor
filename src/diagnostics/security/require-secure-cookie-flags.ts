import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, getStaticStringValue, getObjectProperty, isLiteralTrue } from "../../core/ast.ts";

/**
 * A session/auth cookie set without the `httpOnly` and `secure` flags. Without
 * `httpOnly` the cookie is readable from JavaScript, so any XSS can steal the
 * session; without `secure` it is sent over plain HTTP, so a network attacker can
 * capture it. Only fires for auth-shaped cookie names to stay precise.
 *
 * ❌ res.cookie("session", id);
 * ❌ res.cookie("jwt", token, { maxAge: 3600000 });   // no httpOnly/secure
 * ✅ res.cookie("session", id, { httpOnly: true, secure: true, sameSite: "lax" });
 *
 * Fires when: the cookie name literal is session/auth-shaped and both flags are
 * not set. Stays silent when both `httpOnly: true` and `secure: true` are present,
 * or the options object is not an inspectable literal.
 */

const AUTH_COOKIE_RE = /session|token|auth|sid|jwt/i;

export const requireSecureCookieFlags = defineDiagnostic({
  id: "require-secure-cookie-flags",
  title: "Cookie set without secure/httpOnly flags",
  severity: "warn",
  category: "Security",
  tags: ["auth"],
  recommendation:
    "Set `{ httpOnly: true, secure: true, sameSite: 'lax' }` on auth cookies. `httpOnly` blocks JavaScript from reading the session (XSS theft) and `secure` keeps it off plaintext HTTP.",
  create: (ctx) => ({
    CallExpression: (node) => {
      if (getMethodName(node) !== "cookie") return;
      const args = (node.arguments as AstNode[]) ?? [];

      // Precision: only auth-shaped cookie names, given as a string literal.
      const name = getStaticStringValue(args[0]);
      if (!name || !AUTH_COOKIE_RE.test(name)) return;

      const options = args[2];

      // No options object → both flags are missing.
      if (!options) {
        ctx.report(node, `Auth cookie \`${name}\` is set with no options — it lacks \`httpOnly\` and \`secure\`, so it is exposed to XSS theft and plaintext capture.`);
        return;
      }

      // Only reason about an inspectable object literal; a variable → stay silent.
      if (options.type !== "ObjectExpression") return;

      const hasHttpOnly = isLiteralTrue(getObjectProperty(options, "httpOnly")?.value);
      const hasSecure = isLiteralTrue(getObjectProperty(options, "secure")?.value);
      if (!hasHttpOnly || !hasSecure) {
        const missing = [!hasHttpOnly && "httpOnly", !hasSecure && "secure"].filter(Boolean).join(" and ");
        ctx.report(node, `Auth cookie \`${name}\` is missing \`${missing}\` — set both to protect it from XSS theft and plaintext capture.`);
      }
    },
  }),
});
