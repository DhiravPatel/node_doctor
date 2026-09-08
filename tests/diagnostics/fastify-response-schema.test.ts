/**
 * `no-field-stripped-by-response-schema`.
 *
 * Fastify's response schema is a SERIALIZER, not a validator: it compiles with
 * fast-json-stringify and emits exactly the declared properties. MEASURED against
 * Fastify 5.12.1, one handler returning `{ id, email, role, createdAt }` under
 * four schemas:
 *
 *   properties: { id }                             → {"id":"u1"}      ← three fields gone
 *   properties: { id, email, role, createdAt }     → all four present
 *   no response schema at all                      → all four present
 *   properties: { id }, additionalProperties: true → all four present
 *
 * Nothing warns. The status is 200 and the body is well-formed JSON — the field
 * is simply not there.
 *
 * Also measured and deliberately NOT a rule: an `async` hook that also takes the
 * `done` callback throws `FST_ERR_HOOK_INVALID_ASYNC_HANDLER` at REGISTRATION, so
 * the server never starts and a linter adds nothing.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noFieldStrippedByResponseSchema } from "../../src/diagnostics/http/no-field-stripped-by-response-schema.ts";

const CAPS = new Set(["node", "esm", "typescript", "fastify"]);
const findings = (source: string) =>
  lintSource({
    filePath: "/repo/src/routes.ts",
    sourceText: source,
    diagnostics: [noFieldStrippedByResponseSchema],
    capabilities: CAPS,
  }).findings.filter((f) => f.diagnostic === "no-field-stripped-by-response-schema");

const fires = (source: string) => {
  const found = findings(source);
  assert.ok(found.length > 0, `expected a FIRE on:\n${source}`);
  return found;
};
const silent = (source: string): void =>
  assert.equal(findings(source).length, 0, `expected SILENCE on:\n${source}`);

/** A 200 response schema declaring `props`, with optional extra schema keys. */
const schema = (props: string, extra = "") =>
  `{ schema: { response: { 200: { type: "object", ${extra} properties: { ${props} } } } } }`;
const ID_ONLY = schema(`id: { type: "string" }`);

describe("no-field-stripped-by-response-schema", () => {
  describe("the defect", () => {
    test("a concise arrow returning more than the schema declares", () => {
      fires(`fastify.get("/me", ${ID_ONLY}, async () => ({ id, email, role }));`);
    });

    test("a block body with a return", () => {
      fires(`fastify.get("/me", ${ID_ONLY}, async (req, reply) => { return { id, email }; });`);
    });

    test("the fastify.route({ schema, handler }) form", () => {
      fires(
        `fastify.route({ method: "GET", url: "/me", schema: { response: { 200: { type: "object", properties: { id: { type: "string" } } } } }, handler: async () => ({ id, email }) });`,
      );
    });

    test("the message names the dropped fields and the measured result", () => {
      const [found] = fires(`fastify.get("/me", ${ID_ONLY}, async () => ({ id, email, role }));`);
      assert.match(found!.message, /SERIALIZER, not a validator/);
      assert.match(found!.message, /`email`, `role`/);
      assert.match(found!.message, /\{"id":"u1"\}/);
      assert.match(found!.recommendation ?? "", /additionalProperties: true/);
    });
  });

  describe("silence — the schema keeps the fields", () => {
    test("every returned field is declared", () => {
      silent(`fastify.get("/me", ${schema(`id: { type: "string" }, email: { type: "string" }`)}, async () => ({ id, email }));`);
    });

    test("additionalProperties: true is the documented escape hatch", () => {
      // Measured: all four fields survive with this set.
      silent(`fastify.get("/me", ${schema(`id: { type: "string" }`, "additionalProperties: true,")}, async () => ({ id, email }));`);
    });

    test("no response schema at all — nothing to strip against", () => {
      silent(`fastify.get("/me", {}, async () => ({ id, email }));`);
      silent(`fastify.get("/me", async () => ({ id, email }));`);
    });
  });

  describe("precision guards — both sides must be enumerable", () => {
    test("a returned value that is not an object literal", () => {
      silent(`fastify.get("/me", ${ID_ONLY}, async () => user);`);
      silent(`fastify.get("/me", ${ID_ONLY}, async () => buildUser());`);
    });

    test("a spread hides keys, so the literal proves nothing", () => {
      silent(`fastify.get("/me", ${ID_ONLY}, async () => ({ ...user, id }));`);
    });

    test("a computed key cannot be read", () => {
      silent(`fastify.get("/me", ${ID_ONLY}, async () => ({ [k]: 1, id }));`);
    });

    test("a schema built elsewhere is unreadable", () => {
      silent(`fastify.get("/me", { schema: buildSchema() }, async () => ({ id, email }));`);
      silent(`fastify.get("/me", { schema: { response: { 200: userSchema } } }, async () => ({ id, email }));`);
    });

    test("a literal matching a DIFFERENT declared status is not a partial miss", () => {
      // Every key missing means this answers another status entirely.
      silent(`fastify.get("/me", ${ID_ONLY}, async () => ({ error: "x", code: 1 }));`);
    });

    test("a key is only dropped when missing from EVERY declared status", () => {
      silent(
        `fastify.get("/me", { schema: { response: { 200: { type: "object", properties: { id: { type: "string" } } }, 404: { type: "object", properties: { error: { type: "string" } } } } } }, async () => ({ id, error }));`,
      );
    });
  });
});
