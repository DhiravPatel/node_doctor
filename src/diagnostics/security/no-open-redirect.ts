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

/**
 * Does this URL expression FIX its destination before any interpolation?
 *
 * An open redirect needs the caller to be able to change WHERE the browser goes.
 * A template literal whose first quasi already spells out an absolute origin plus
 * a path — `` `https://accounts.google.com/o/oauth2/v2/auth?${params}` `` — has a
 * host and path that no interpolation can reach: everything dynamic lands in the
 * query or fragment. The browser goes to Google either way.
 *
 * This was a live false positive at `error` severity, on the OAuth start handler
 * of a real API, and it is worth being precise about why the taint check alone
 * could not save it. The interpolated `state` was
 * `crypto.randomBytes(32).toString("hex")` — about as far from caller data as a
 * value gets. It looked tainted only because taint is file-global: the OTHER
 * exported handler in the same file destructures a `state` from `request.query`,
 * and the two locals share a name. Shape is decidable where that provenance is
 * not, so the rule now asks the question it should always have asked.
 *
 * Both accepted shapes leave the caller no room:
 *   - `https://host/path...`  an absolute origin followed by at least one path
 *     character. The `[^/?#]+` before the slash is what stops
 *     `` `https://${host}/x` `` from qualifying — there the host IS dynamic.
 *   - `/path...` a site-root-relative path whose second character is not `/`,
 *     so it cannot be read as a protocol-relative `//evil.com` URL.
 */
const REDIRECT_DESTINATION_FIXED = [
  /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+\//i,
  /^\/[^/]/,
];

const destinationIsFixed = (node: AstNode | null | undefined): boolean => {
  if (!node || node.type !== "TemplateLiteral") return false;
  const first = ((node.quasis as AstNode[] | undefined) ?? [])[0];
  const raw = (first?.value as { cooked?: string; raw?: string } | undefined)?.cooked
    ?? (first?.value as { raw?: string } | undefined)?.raw;
  if (typeof raw !== "string" || raw === "") return false;
  return REDIRECT_DESTINATION_FIXED.some((re) => re.test(raw));
};

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
      // A destination the caller cannot move is not a redirect vulnerability,
      // whatever the taint set says about the values interpolated after it.
      if (destinationIsFixed(url)) return;
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
