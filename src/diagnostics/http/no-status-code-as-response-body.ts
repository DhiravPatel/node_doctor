import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, rootObjectName } from "../../core/ast.ts";

/**
 * An Express 4 response signature that Express 5 removed. It does not throw — it
 * sends the STATUS CODE as the body, with a 200.
 *
 *   ❌ res.send(404);                    // 200, body "404"
 *   ❌ res.send(500, { error: "..." });  // 200, body "500" — the payload is GONE
 *   ❌ res.json(201, created);           // 200, body "201" — the payload is GONE
 *   ✅ res.status(404).send();
 *   ✅ res.sendStatus(404);
 *   ✅ res.status(201).json(created);
 *
 * `res.send(status)` and the two-argument `res.send(status, body)` /
 * `res.json(status, body)` were deprecated through Express 4 and are gone in
 * Express 5, where the first argument is simply the body. MEASURED against
 * Express 5.2.1, each case served over a real socket:
 *
 *   res.send(404)              → 200  body "404"   content-type application/json
 *   res.send(204)              → 200  body "204"
 *   res.send(200, { ok: 1 })   → 200  body "200"   ← the payload is discarded
 *   res.json(201, created)     → 200  body "201"   ← the payload is discarded
 *   res.send("404")            → 200  body "404"   content-type text/html   (correct)
 *   res.status(404).send()     → 404  body ""                                (correct)
 *   res.sendStatus(404)        → 404  body "Not Found"                       (correct)
 *
 * This is the worst kind of upgrade break, because the server keeps working. An
 * error path that used to answer 404 now answers **200 with the string "404"**,
 * so every client that checks `response.ok` treats the failure as a success and
 * carries on with a body it cannot parse. The two-argument forms are worse still:
 * the response payload the handler computed is thrown away entirely and replaced
 * by the number. Nothing is logged, no test that only asserts on the payload
 * shape fails, and the deprecation warning that used to appear on Express 4 is
 * gone along with the feature.
 *
 * PRECISION MODEL. Gated on `express:5`, because on Express 4 these signatures
 * WORK — they set the status, with a deprecation warning — and reporting them
 * there would be reporting working code. The token never stands alone; it is
 * granted only alongside `express`.
 *
 * Two shapes, each proving intent from syntax alone:
 *
 *   - **One argument, an integer literal in the HTTP status range (100–599).**
 *     The range is the proof that this was meant as a status rather than as a
 *     numeric body. `res.send(42)` is left alone — it could genuinely be a
 *     number someone wants to send — and so is `res.send("404")`, which is a
 *     string body and correct.
 *   - **Two arguments with a numeric-literal first.** `send`/`json` take one
 *     argument in Express 5, so a numeric first argument followed by a payload
 *     can only be the removed signature. No range test is needed here; the arity
 *     is the proof.
 *
 * The receiver must root at a response identifier (`res`, `response`, `reply`),
 * which is what keeps this off `socket.send(1000, reason)` and every other
 * `send` in the language.
 *
 * Also measured on Express 5.2.1 and deliberately NOT part of this rule, because
 * each is a different mechanism and most fail loudly enough to be caught the
 * moment the server starts: `app.del(…)` and the route patterns `'/files/*'` and
 * `'/:id?'` throw at BOOT (`TypeError`, `PathError`); `req.param(…)` and
 * `res.sendfile(…)` throw a 500 on first request. Two silent ones remain
 * uncovered and are candidates for their own rules: `res.redirect("back")` now
 * redirects to the literal path `/back` (measured: 404), and the default query
 * parser changed from `extended` to `simple`, so `?a[b]=c` yields
 * `{ "a[b]": "c" }` and `req.query.a.b` is undefined.
 */

/** Identifiers that root a response object. */
const RESPONSE_ROOTS = new Set(["res", "response", "reply"]);

/** The response methods whose Express 4 signatures took a leading status. */
const SIGNATURE_METHODS = new Set(["send", "json", "jsonp"]);

const integerLiteral = (node: AstNode | null | undefined): number | null => {
  if (node?.type !== "Literal" || typeof node.value !== "number") return null;
  return Number.isInteger(node.value) ? node.value : null;
};

/** Is this number in the HTTP status range — the proof it was meant as one? */
const isHttpStatus = (value: number): boolean => value >= 100 && value <= 599;

export const noStatusCodeAsResponseBody = defineDiagnostic({
  id: "no-status-code-as-response-body",
  title: "Express 4 status-code signature that Express 5 sends as the body instead",
  severity: "error",
  category: "Bugs",
  confidence: "high",
  requires: ["express:5"],
  tags: ["express", "http", "migration"],
  recommendation:
    "Set the status separately: `res.status(404).send()`, `res.sendStatus(404)`, or `res.status(201).json(payload)`. Express 5 removed `res.send(status)` and the two-argument `res.send(status, body)` / `res.json(status, body)`, so the first argument is now just the body — measured on Express 5.2.1, `res.send(404)` answers **200 with the body \"404\"**, and `res.json(201, created)` answers 200 with the body \"201\", discarding the payload entirely.",
  create: (ctx) => ({
    CallExpression: (node) => {
      const method = getMethodName(node);
      if (method === null || !SIGNATURE_METHODS.has(method)) return;

      const root = rootObjectName(node.callee as AstNode);
      if (root === null || !RESPONSE_ROOTS.has(root)) return;

      const args = (node.arguments as AstNode[] | undefined) ?? [];
      const first = integerLiteral(args[0]);
      if (first === null) return;

      if (args.length === 1) {
        // A lone number is only provably a status when it reads as one.
        if (!isHttpStatus(first)) return;
        ctx.report(
          node,
          `Express 5 removed \`res.${method}(status)\`, so this sends the NUMBER as the body — measured on Express 5.2.1, \`res.send(${first})\` answers **200 with the body "${first}"**, not a ${first}. Every client checking \`response.ok\` now reads the failure as a success. Use \`res.status(${first}).${method === "json" ? "json(payload)" : "send()"}\` or \`res.sendStatus(${first})\`.`,
        );
        return;
      }

      // `send`/`json` take ONE argument in Express 5, so a numeric first
      // argument followed by a payload can only be the removed signature.
      ctx.report(
        node,
        `Express 5 removed the two-argument \`res.${method}(status, body)\`, so the first argument is the body and **the payload is discarded** — measured on Express 5.2.1, \`res.json(201, created)\` answers 200 with the body "201" and \`created\` never reaches the client. Use \`res.status(${first}).${method}(payload)\`.`,
      );
    },
  }),
});
