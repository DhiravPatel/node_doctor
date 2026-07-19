import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import {
  getCalleeName,
  getMethodName,
  getReceiverName,
  findEnclosingFunction,
  looksCallerControlled,
} from "../../core/ast.ts";
import { findDescendant } from "../../core/walk.ts";

/**
 * OPT-IN (defaultEnabled: false). An outbound request whose destination is
 * caller-controlled, with no host allowlist in the enclosing function. SSRF lets
 * an attacker point your server at `http://169.254.169.254/` (cloud metadata),
 * internal admin panels, or `file://` — using your network position as a proxy.
 *
 * Higher false-positive risk than the core set (a request URL is often legitimately
 * dynamic), so it ships disabled and is enabled deliberately.
 *
 * ❌ app.get("/fetch", (req, res) => fetch(req.query.url).then(...));
 * ✅ if (ALLOW_HOSTS.has(new URL(target).host)) await fetch(target); // host allowlist
 * ✅ await fetch("https://api.internal/health"); // static destination
 */

// Outbound-request receivers for `.get`/`.request`.
const REQUEST_RECEIVERS = new Set(["http", "https", "axios"]);
const REQUEST_METHODS = new Set(["get", "request", "post", "put", "patch", "delete", "head"]);

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

/** Does the enclosing function validate the destination host/URL? */
const hasValidationGuard = (fn: AstNode): boolean =>
  findDescendant(fn, (n) => {
    if (n.type === "NewExpression" && getCalleeName(n) === "URL") return true;
    if (n.type === "CallExpression") {
      const m = getMethodName(n);
      if (m && GUARD_METHODS.has(m)) return true;
    }
    return false;
  }) !== null;

/** The URL argument of a recognized outbound-request call, or null if not one. */
const outboundUrlArg = (node: AstNode): AstNode | null => {
  const callee = getCalleeName(node);
  const args = (node.arguments as AstNode[]) ?? [];
  // Bare `fetch(url)` / `axios(url)`.
  if (callee === "fetch" || callee === "axios") return args[0] ?? null;
  // `http.get(url)`, `https.request(url)`, `axios.post(url, ...)`.
  const receiver = getReceiverName(node);
  const method = getMethodName(node);
  if (receiver && REQUEST_RECEIVERS.has(receiver) && method && REQUEST_METHODS.has(method)) {
    return args[0] ?? null;
  }
  return null;
};

export const noSsrfUnvalidatedUrl = defineDiagnostic({
  id: "no-ssrf-unvalidated-url",
  title: "Outbound request to a caller-controlled URL (SSRF)",
  severity: "error",
  category: "Security",
  tags: ["injection", "network"],
  defaultEnabled: false,
  recommendation:
    "Validate the destination before the request: parse it with `new URL(target)` and assert its host is in an explicit allowlist, rejecting internal/link-local ranges and non-http(s) schemes.",
  create: (ctx) => ({
    CallExpression: (node) => {
      const url = outboundUrlArg(node);
      if (!url) return;
      if (!looksCallerControlled(url, ctx.taintedBindings)) return;

      const fn = findEnclosingFunction(node);
      if (fn && hasValidationGuard(fn)) return; // host/URL check present — back off

      ctx.report(
        url,
        "Outbound request to a caller-controlled URL with no host allowlist — this is SSRF (cloud metadata, internal services, or file:// access).",
      );
    },
  }),
});
