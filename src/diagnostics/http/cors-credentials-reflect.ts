import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import {
  getCalleeName,
  getMethodName,
  getPropertyValue,
  isLiteralTrue,
  isFunctionLike,
} from "../../core/ast.ts";
import { findDescendant } from "../../core/walk.ts";

/**
 * CORS configured to reflect any origin while also sending credentials.
 * `origin: true` reflects whatever `Origin` header the caller sent; with
 * `credentials: true` the browser attaches the victim's cookies to a cross-site
 * request from *any* attacker page and lets it read the response.
 *
 * ❌ app.use(cors({ origin: true, credentials: true }));
 * ✅ app.use(cors({ origin: ["https://app.example.com"], credentials: true }));
 */

/** Does an origin *function* unconditionally allow (no validation branch)? */
const originFnAlwaysAllows = (fn: AstNode): boolean => {
  // A validating function has a branch or a membership check.
  const hasValidation =
    findDescendant(fn, (n) => {
      if (n.type === "IfStatement" || n.type === "ConditionalExpression") return true;
      if (n.type === "CallExpression") {
        const m = getMethodName(n);
        if (m && ["includes", "indexOf", "some", "test", "has", "match", "startsWith", "endsWith"].includes(m)) {
          return true;
        }
      }
      if (n.type === "BinaryExpression" && ["===", "==", "!==", "!="].includes(n.operator)) return true;
      return false;
    }) !== null;
  if (hasValidation) return false;

  // And it calls back with a literal `true` (allow).
  return (
    findDescendant(fn, (n) => {
      if (n.type !== "CallExpression") return false;
      const args = n.arguments as AstNode[];
      return args.some((a) => isLiteralTrue(a));
    }) !== null
  );
};

export const corsCredentialsReflect = defineDiagnostic({
  id: "cors-credentials-reflect",
  title: "CORS reflects any origin with credentials enabled",
  severity: "error",
  category: "Security",
  tags: ["cors", "auth"],
  recommendation:
    "Do not combine `credentials: true` with a reflected origin. Use an explicit allowlist (`origin: ['https://app.example.com']`) or a validating function that only calls back `true` for known origins.",
  create: (ctx) => ({
    CallExpression: (node) => {
      if (getCalleeName(node) !== "cors" && getMethodName(node) !== "cors") return;
      const opts = (node.arguments as AstNode[])[0];
      if (!opts || opts.type !== "ObjectExpression") return;

      if (!isLiteralTrue(getPropertyValue(opts, "credentials"))) return;

      const origin = getPropertyValue(opts, "origin");
      if (!origin) return;

      let reflects = false;
      if (isLiteralTrue(origin)) reflects = true;
      else if (origin.type === "Literal" && origin.value === "*") reflects = true;
      else if (isFunctionLike(origin) && originFnAlwaysAllows(origin)) reflects = true;

      if (reflects) {
        ctx.report(
          node,
          "CORS reflects the caller's origin (`origin: true`/`*`/always-allow) while `credentials: true` — any site can send the victim's cookies and read the response.",
        );
      }
    },
  }),
});
