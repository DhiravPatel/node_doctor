import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import {
  getMethodName,
  rootObjectName,
  findEnclosingFunction,
  looksCallerControlled,
} from "../../core/ast.ts";
import { getCalleeName } from "../../core/ast.ts";
import { findDescendant } from "../../core/walk.ts";

/**
 * `res.redirect(x)` (or `reply.redirect`/`ctx.redirect`) to a caller-controlled
 * URL with no validation in sight. An open redirect turns your trusted domain
 * into a launch pad: `/login?next=https://evil.example` bounces the user to an
 * attacker site after auth, and OAuth/callback flows can leak tokens.
 *
 * We only fire when the target is caller-controlled AND the enclosing handler
 * contains no allowlist / `startsWith` / `URL`-origin check.
 *
 * ❌ app.get("/go", (req, res) => res.redirect(req.query.url));
 * ✅ res.redirect("/dashboard"); // fixed path
 * ✅ if (ALLOW.includes(target)) res.redirect(target); // validated against allowlist
 */

// Terminal-response receivers that own a `.redirect(url)`.
const REDIRECT_RECEIVERS = new Set(["res", "reply", "ctx", "response"]);

// Validation shapes that, if present in the handler, mean the dev is checking.
const GUARD_METHODS = new Set([
  "startsWith",
  "includes",
  "some",
  "every",
  "has",
  "indexOf",
  "test",
  "match",
]);

/** Does the enclosing function apply any URL/allowlist validation? */
const hasValidationGuard = (fn: AstNode): boolean =>
  findDescendant(fn, (n) => {
    if (n.type === "NewExpression" && getCalleeName(n) === "URL") return true;
    if (n.type === "CallExpression") {
      const m = getMethodName(n);
      if (m && GUARD_METHODS.has(m)) return true;
    }
    return false;
  }) !== null;

export const noOpenRedirect = defineDiagnostic({
  id: "no-open-redirect",
  title: "Redirect to a caller-controlled URL",
  severity: "error",
  category: "Security",
  tags: ["injection"],
  recommendation:
    "Redirect only to a fixed allowlist of paths or origins: compare the target against a known-good set, or resolve it and assert `new URL(target).origin` is one you trust before calling redirect.",
  create: (ctx) => ({
    CallExpression: (node) => {
      if (getMethodName(node) !== "redirect") return;
      const receiver = rootObjectName(node.callee);
      if (!receiver || !REDIRECT_RECEIVERS.has(receiver)) return;

      const args = (node.arguments as AstNode[]) ?? [];
      if (args.length === 0) return;
      // Express allows `redirect([status,] url)` — the URL is the last argument.
      const url = args[args.length - 1];
      if (!looksCallerControlled(url, ctx.taintedBindings)) return;

      const fn = findEnclosingFunction(node);
      if (fn && hasValidationGuard(fn)) return; // dev is validating — back off

      ctx.report(
        url,
        "Redirecting to a caller-controlled URL with no allowlist check — this is an open redirect (phishing / token leakage).",
      );
    },
  }),
});
