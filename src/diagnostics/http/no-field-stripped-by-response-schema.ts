import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, getObjectProperty, getPropertyValue, isFunctionLike, isLiteralTrue } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";

/**
 * A Fastify handler that returns a field its response schema does not declare.
 * Fastify's serializer drops it, so the caller gets a 200 with data missing.
 *
 *   ❌ fastify.get("/me", {
 *        schema: { response: { 200: { type: "object", properties: { id: { type: "string" } } } } },
 *      }, async () => ({ id, email, role }));      // email and role are DROPPED
 *   ✅ …properties: { id: {…}, email: {…}, role: {…} }
 *   ✅ …response: { 200: { type: "object", additionalProperties: true, properties: { id: {…} } } }
 *
 * The response schema is not a validator, it is a SERIALIZER: Fastify compiles it
 * with fast-json-stringify and emits exactly the declared properties. MEASURED
 * against Fastify 5.12.1, one handler returning
 * `{ id, email, role, createdAt }` under four schemas:
 *
 *   properties: { id }                            → {"id":"u1"}                      ← three fields gone
 *   properties: { id, email, role, createdAt }    → all four present
 *   no response schema at all                     → all four present
 *   properties: { id }, additionalProperties: true → all four present
 *
 * Nothing warns. The status is 200, the body is well-formed JSON, and the field
 * is simply not there — so the failure surfaces in the client as an undefined
 * property, or as a column that silently stops being populated downstream. It is
 * the specific cost of Fastify's headline performance feature, and it bites
 * exactly when someone adds a field to a handler and does not think to also add
 * it to the schema, which is the normal way that edit happens.
 *
 * PRECISION MODEL. The rule reports a key only when it can enumerate BOTH sides
 * statically, so anything it cannot read exactly is silent:
 *
 *   - The route's options carry `schema.response.<status>` as an object literal
 *     with a literal `properties` object. A schema built by a helper, a `$ref`,
 *     or a variable is unreadable and never reported.
 *   - `additionalProperties: true` is the documented escape hatch and is
 *     verified to keep every field — it silences the route outright.
 *   - The handler returns an OBJECT LITERAL whose keys are all static. A returned
 *     identifier, call, or a literal containing a spread cannot be enumerated, so
 *     it is left alone — `{ ...user, token }` proves nothing about `user`'s keys.
 *   - A key must be missing from **every** declared response status, not just
 *     one. A handler with a 200 shape and a 404 shape returns literals matching
 *     different schemas, and demanding a match against all of them at once would
 *     report both.
 *
 * Deliberately not claimed: `reply.send({ … })`, where the same stripping applies
 * but the value reaches the serializer by a different path; and a shortfall in
 * the other direction (a schema declaring a property the handler never returns),
 * which is harmless — fast-json-stringify simply omits it.
 *
 * Gated on the `fastify` capability. Complements `fastify-missing-schema`, which
 * is about routes with NO schema; this one is about a schema that is present and
 * quietly wrong.
 */

const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "all", "route"]);

/** The static key of an object property, or null if computed/dynamic. */
const propertyKey = (property: AstNode): string | null => {
  if (property.type !== "Property" || property.computed) return null;
  const key = property.key as AstNode | undefined;
  if (key?.type === "Identifier") return String(key.name);
  if (key?.type === "Literal" && (typeof key.value === "string" || typeof key.value === "number")) {
    return String(key.value);
  }
  return null;
};

/** Every statically-readable key of an object literal, or null if any is not. */
const literalKeys = (node: AstNode | null | undefined): string[] | null => {
  if (!node || node.type !== "ObjectExpression") return null;
  const keys: string[] = [];
  for (const property of ((node.properties as AstNode[] | undefined) ?? [])) {
    // A spread hides keys we cannot enumerate, so the literal proves nothing.
    if (property.type === "SpreadElement") return null;
    const key = propertyKey(property);
    if (key === null) return null;
    keys.push(key);
  }
  return keys;
};

/**
 * The set of property names every declared response status allows, or null when
 * any status is unreadable or opts out with `additionalProperties: true`.
 */
const declaredResponseKeys = (options: AstNode | null | undefined): Set<string> | null => {
  const schema = getPropertyValue(options, "schema");
  const response = getPropertyValue(schema, "response");
  if (!response || response.type !== "ObjectExpression") return null;

  const allowed = new Set<string>();
  let sawOne = false;
  for (const status of ((response.properties as AstNode[] | undefined) ?? [])) {
    if (status.type !== "Property") return null;
    const shape = status.value as AstNode | undefined;
    if (!shape || shape.type !== "ObjectExpression") return null;
    // The escape hatch, verified to keep every field.
    if (isLiteralTrue(getPropertyValue(shape, "additionalProperties"))) return null;
    const properties = getPropertyValue(shape, "properties");
    const keys = literalKeys(properties);
    if (keys === null) return null;
    for (const key of keys) allowed.add(key);
    sawOne = true;
  }
  return sawOne ? allowed : null;
};

/** The object literals a function returns, not crossing nested functions. */
const returnedLiterals = (fn: AstNode): AstNode[] => {
  const body = fn.body as AstNode | undefined;
  if (!body) return [];
  // A concise arrow body IS the returned expression.
  if (body.type !== "BlockStatement") return body.type === "ObjectExpression" ? [body] : [];
  const out: AstNode[] = [];
  for (const statement of collectDescendants(body, (n) => n.type === "ReturnStatement", isFunctionLike)) {
    const argument = statement.argument as AstNode | undefined;
    if (argument?.type === "ObjectExpression") out.push(argument);
  }
  return out;
};

export const noFieldStrippedByResponseSchema = defineDiagnostic({
  id: "no-field-stripped-by-response-schema",
  title: "Fastify handler returns a field the response schema does not declare, so it is dropped",
  severity: "error",
  category: "Bugs",
  confidence: "high",
  requires: ["fastify"],
  tags: ["fastify", "http", "correctness"],
  recommendation:
    "Add the field to the response schema's `properties`, or set `additionalProperties: true` on that status if the shape is deliberately open. Fastify's response schema is a SERIALIZER, not a validator — it compiles with fast-json-stringify and emits exactly the declared properties, so anything else is silently dropped with a 200 and a well-formed body. Measured on Fastify 5.12.1: a handler returning `{ id, email, role, createdAt }` under a schema declaring only `id` answers `{\"id\":\"u1\"}`.",
  create: (ctx) => ({
    CallExpression: (node) => {
      const method = getMethodName(node);
      if (method === null || !ROUTE_METHODS.has(method)) return;

      const args = (node.arguments as AstNode[] | undefined) ?? [];
      // `fastify.route({ schema, handler })` vs `fastify.get(path, { schema }, handler)`.
      const isRouteForm = method === "route";
      const options = isRouteForm ? args[0] : args[1];
      if (!options || options.type !== "ObjectExpression") return;

      const allowed = declaredResponseKeys(options);
      if (allowed === null) return;

      const handler = isRouteForm ? getPropertyValue(options, "handler") : args[2];
      if (!isFunctionLike(handler)) return;

      for (const literal of returnedLiterals(handler!)) {
        const keys = literalKeys(literal);
        if (keys === null) continue;
        const dropped = keys.filter((key) => !allowed.has(key));
        // Every key missing would mean this literal answers a different status
        // entirely; a partial overlap is the real "forgot to update the schema".
        if (dropped.length === 0 || dropped.length === keys.length) continue;
        ctx.report(
          literal,
          `Fastify's response schema is a SERIALIZER, not a validator — it emits exactly the declared properties, so ${dropped.map((k) => `\`${k}\``).join(", ")} ${dropped.length === 1 ? "is" : "are"} silently dropped from the response. Measured on Fastify 5.12.1, a handler returning \`{ id, email, role, createdAt }\` under a schema declaring only \`id\` answers \`{"id":"u1"}\` with a 200 and a well-formed body, so nothing warns. Add ${dropped.length === 1 ? "it" : "them"} to \`schema.response\`'s \`properties\`, or set \`additionalProperties: true\`.`,
        );
      }
    },
  }),
});
