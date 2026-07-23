import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getObjectProperty, getPropertyValue, getStaticStringValue } from "../../core/ast.ts";
import { hapiRouteMethods, hapiRouteObjects, hapiRouteOptions } from "./hapi-route-shape.ts";

/**
 * A hapi route that accepts a request payload but declares no `validate`. Hapi's
 * first-class defence is per-route Joi validation: with `options.validate.payload`
 * hapi rejects a malformed body with a 400 before the handler runs. Without it the
 * handler receives whatever JSON the caller sent — extra fields land in the ORM
 * write, a string arrives where a number was assumed, and `undefined` propagates
 * into the database. This is the production shape behind mass-assignment bugs and
 * the "cannot read properties of undefined" 500s that follow a client change.
 *
 * Scoped to POST/PUT/PATCH — the methods that definitionally carry a payload. GET,
 * HEAD, DELETE, `"*"`, and any non-static method are silent, as is any route whose
 * `validate` is already present under `options` or the legacy `config` key, and any
 * route whose payload is deliberately raw (a signed webhook, a stream upload).
 *
 * ❌ server.route({ method: "POST", path: "/users", handler: create });
 * ✅ server.route({ method: "POST", path: "/users", options: { validate: { payload: schema } }, handler: create });
 * ✅ server.route({ method: "GET", path: "/users", handler: list });   // no payload to validate
 * ✅ server.route({ method: "POST", path: "/hooks", options: { payload: { parse: false } }, handler: hook });
 */

/** Methods that carry a request body — the only ones a missing `validate` endangers. */
const PAYLOAD_METHODS = new Set(["POST", "PUT", "PATCH"]);

/**
 * Is the payload deliberately not a parsed object? Raw-body routes — Stripe-style
 * webhooks (`payload: { parse: false }`, verified by HMAC signature instead) and
 * stream/file uploads (`output: "stream"`) — have no JSON object for Joi to check,
 * so `validate.payload` is not the available control and demanding it is noise.
 */
const payloadIsRaw = (options: AstNode): boolean => {
  const payload = getPropertyValue(options, "payload");
  if (!payload) return false;
  if (payload.type !== "ObjectExpression") return true; // opaque payload config

  const parse = getPropertyValue(payload, "parse");
  // `parse` accepts false or "gunzip"; only an explicit `true` keeps a parsed object.
  if (parse && !(parse.type === "Literal" && parse.value === true)) return true;

  // `output` defaults to "data" (a parsed object); "stream"/"file"/anything
  // unresolvable means there is nothing for a payload schema to describe.
  const output = getPropertyValue(payload, "output");
  if (output && getStaticStringValue(output) !== "data") return true;
  return false;
};

export const hapiRouteMissingValidation = defineDiagnostic({
  id: "hapi-route-missing-validation",
  title: "hapi route accepts a payload without validation",
  severity: "warn",
  category: "Security",
  requires: ["hapi"],
  tags: ["hapi", "validation", "input"],
  recommendation:
    "Add `options: { validate: { payload: Joi.object({ ... }) } }` to the route. Hapi rejects a non-conforming body with a 400 before the handler runs; without it the handler receives arbitrary input.",
  create: (ctx) => ({
    CallExpression: (node) => {
      for (const route of hapiRouteObjects(node)) {
        const methods = hapiRouteMethods(route);
        if (!methods) continue; // unresolvable method — say nothing
        // Every declared method must carry a payload, so a mixed or wildcard
        // declaration (which also serves GET) never fires.
        if (!methods.every((m) => PAYLOAD_METHODS.has(m))) continue;

        const options = hapiRouteOptions(route);
        if (options.kind === "opaque") continue; // options come from elsewhere
        if (options.kind === "object") {
          if (getObjectProperty(options.node, "validate")) continue;
          if (payloadIsRaw(options.node)) continue;
        }

        ctx.report(
          route,
          `This hapi \`${methods.join("/")}\` route declares no \`validate\` — its payload reaches the handler unchecked.`,
        );
      }
    },
  }),
});
