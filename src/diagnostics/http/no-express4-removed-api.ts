import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, rootObjectName, getStaticStringValue } from "../../core/ast.ts";

/**
 * An Express 4 API that Express 5 removed, which fails when the route RUNS
 * rather than when the app boots.
 *
 *   ❌ const id = req.param("id");           // TypeError: req.param is not a function
 *   ❌ res.sendfile("/srv/report.pdf");      // TypeError: res.sendfile is not a function
 *   ❌ if (req.acceptsCharset("utf-8")) {}   // TypeError (the plural survives)
 *   ❌ req.query = sanitize(req.query);      // TypeError: Cannot set property query
 *   ❌ res.redirect("back");                 // 302 to a relative "back" → 404
 *   ✅ const id = req.params.id ?? req.query.id ?? req.body?.id;
 *   ✅ res.sendFile("/srv/report.pdf");
 *   ✅ if (req.acceptsCharsets("utf-8")) {}
 *   ✅ res.redirect(req.get("Referrer") || "/");
 *
 * MEASURED against Express 5.2.1 by enumerating the live objects inside a
 * running handler, rather than reading a changelog:
 *
 *   req.param              → undefined      req.acceptsCharsets   → function
 *   req.acceptsCharset     → undefined      req.acceptsEncodings  → function
 *   req.acceptsEncoding    → undefined      req.acceptsLanguages  → function
 *   req.acceptsLanguage    → undefined      res.sendFile          → function
 *   res.sendfile           → undefined
 *   req.query = {…}        → TypeError      req.params = {…}      → ok
 *   res.redirect("back")   → 302, Location: "back"
 *
 * Note the pattern in the accessors: only the SINGULAR forms went, and the
 * plural ones are still there — so the fix is one letter, and the failure is one
 * letter away from invisible in review. `res.sendfile` versus `res.sendFile` is
 * the same trap in case rather than number.
 *
 * WHY THESE AND NOT THE REST. Express 5 also removed `app.del(…)` and changed the
 * route-pattern syntax so `'/files/*'` and `'/:id?'` no longer parse. Those were
 * measured too — they throw at **boot** (`TypeError`, `PathError`), so the server
 * never starts and nobody needs a linter to find them. Everything in this rule
 * fails only when the route executes, so it survives a deploy and waits for
 * whichever request first takes that branch. That is the difference between a
 * migration you finish in an afternoon and one that pages you at 3am.
 *
 * `res.redirect("back")` is the odd one out and the most dangerous, because it
 * does not throw at all. Express 4 resolved `"back"` to the Referrer header;
 * Express 5 treats it as an ordinary relative path, so the response is a 302 with
 * `Location: back` and the browser lands on a sibling URL that does not exist.
 * The user sees a 404 after a successful login instead of returning where they
 * came from.
 *
 * PRECISION MODEL. Gated on `express:5`, because every one of these WORKS on
 * Express 4 — reporting them there would be reporting working code. The token is
 * granted only alongside `express`.
 *
 * The receiver must root at a request or response identifier (`req`/`request`,
 * `res`/`response`), which is what keeps `param`, `sendfile` and `redirect` —
 * all ordinary words — from matching anything else in the file. `req.query = …`
 * is matched as an assignment whose target is that member, not as a call.
 */

const REQUEST_ROOTS = new Set(["req", "request"]);
const RESPONSE_ROOTS = new Set(["res", "response"]);

/** Removed request methods → the plural/replacement that survived. */
const REMOVED_REQUEST_METHODS: Record<string, string> = {
  param: "req.params.<name>",
  acceptsCharset: "req.acceptsCharsets(…)",
  acceptsEncoding: "req.acceptsEncodings(…)",
  acceptsLanguage: "req.acceptsLanguages(…)",
};

/** Removed response methods → the replacement that survived. */
const REMOVED_RESPONSE_METHODS: Record<string, string> = {
  sendfile: "res.sendFile(…)",
};

/** Request members that are getters in Express 5, so assigning throws. */
const READONLY_REQUEST_MEMBERS = new Set(["query"]);

export const noExpress4RemovedApi = defineDiagnostic({
  id: "no-express4-removed-api",
  title: "Express 4 API removed in Express 5, failing when the route runs",
  severity: "error",
  category: "Bugs",
  confidence: "high",
  requires: ["express:5"],
  tags: ["express", "http", "migration"],
  recommendation:
    "Use the Express 5 spelling: `req.params.<name>` (or `req.query`/`req.body`) for `req.param(…)`, the PLURAL `req.acceptsCharsets`/`acceptsEncodings`/`acceptsLanguages`, `res.sendFile` with a capital F, and `res.redirect(req.get(\"Referrer\") || \"/\")` for the removed `\"back\"` magic string. For sanitizing, mutate in place or carry a new object — `req.query` is a getter in Express 5 and assigning to it throws. Each of these fails when the route RUNS rather than at boot, so it survives a deploy.",
  create: (ctx) => ({
    CallExpression: (node) => {
      const method = getMethodName(node);
      if (method === null) return;
      const root = rootObjectName(node.callee as AstNode);
      if (root === null) return;

      if (REQUEST_ROOTS.has(root) && method in REMOVED_REQUEST_METHODS) {
        const replacement = REMOVED_REQUEST_METHODS[method]!;
        const plural = method !== "param";
        ctx.report(
          node,
          `Express 5 removed \`req.${method}\` — measured on Express 5.2.1, \`typeof req.${method}\` is \`"undefined"\`, so this throws \`TypeError: req.${method} is not a function\` the first time the route runs. It fails at RUNTIME, not at boot, so it survives a deploy and waits for whichever request takes this branch.${plural ? " Only the singular form went; the plural is still there." : ""} Use \`${replacement}\`.`,
        );
        return;
      }

      if (RESPONSE_ROOTS.has(root) && method in REMOVED_RESPONSE_METHODS) {
        ctx.report(
          node,
          `Express 5 removed \`res.${method}\` — measured on Express 5.2.1, \`typeof res.${method}\` is \`"undefined"\`, while \`res.sendFile\` (capital F) is still a function. This throws \`TypeError\` when the route runs, not at boot. Use \`${REMOVED_RESPONSE_METHODS[method]}\`.`,
        );
        return;
      }

      // `res.redirect("back")` — no longer the Referrer, just a relative path.
      if (RESPONSE_ROOTS.has(root) && method === "redirect") {
        const args = (node.arguments as AstNode[] | undefined) ?? [];
        const target = args.length > 1 ? args[1] : args[0];
        if (getStaticStringValue(target) !== "back") return;
        ctx.report(
          node,
          'Express 5 removed the `"back"` magic string, so this no longer redirects to the Referrer — measured on Express 5.2.1, the response is a **302 with `Location: back`**, an ordinary relative path, and the browser lands on a sibling URL that does not exist. It does not throw, so the only symptom is a 404 after an otherwise successful action. Use `res.redirect(req.get("Referrer") || "/")`.',
        );
      }
    },

    AssignmentExpression: (node) => {
      const left = node.left as AstNode | undefined;
      if (left?.type !== "MemberExpression" || left.computed) return;
      const property = left.property as AstNode | undefined;
      if (property?.type !== "Identifier" || !READONLY_REQUEST_MEMBERS.has(String(property.name))) return;
      const object = left.object as AstNode | undefined;
      if (object?.type !== "Identifier" || !REQUEST_ROOTS.has(String(object.name))) return;

      ctx.report(
        node,
        `\`req.${String(property.name)}\` is a getter in Express 5, so assigning to it throws \`TypeError\` — measured on Express 5.2.1, where \`req.params = {…}\` and \`req.body = {…}\` still work but \`req.query = {…}\` does not. This is the shape sanitizing middleware uses (\`req.query = sanitize(req.query)\`), and it fails on the first request through that middleware rather than at boot. Mutate the existing object in place, or carry the sanitized value forward on \`res.locals\` or your own property.`,
      );
    },
  }),
});
