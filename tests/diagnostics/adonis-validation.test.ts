/**
 * `no-unawaited-adonis-validation`.
 *
 * `request.validateUsing()` returns `Promise<Infer<Schema>>` — read from
 * `@adonisjs/core`'s own declaration of `RequestValidator.validateUsing`.
 *
 * MEASURED by running the same VineJS validator Adonis uses, against invalid
 * input:
 *
 *   awaited      → throws ValidationError, which the framework turns into a 422
 *   NOT awaited  → typeof data.email is "undefined"
 *                  data is a Promise
 *                  the ValidationError arrives as an UNHANDLED REJECTION
 *
 * Three consequences at once, none of them visible as a validation failure: the
 * request is accepted unvalidated, every field reads `undefined`, and the
 * rejection is unhandled (which terminates the process by default on Node 15+).
 *
 * A test that posts VALID input never produces the rejection, which is part of
 * why this survives.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noUnawaitedAdonisValidation } from "../../src/diagnostics/frameworks/no-unawaited-adonis-validation.ts";

const CAPS = new Set(["node", "esm", "typescript", "adonis"]);
const controller = (body: string) =>
  `export default class UsersController {\n  async store(ctx) {\n    const { request, response } = ctx;\n${body}\n  }\n}`;

const findings = (body: string) =>
  lintSource({
    filePath: "/repo/app/controllers/users_controller.ts",
    sourceText: controller(body),
    diagnostics: [noUnawaitedAdonisValidation],
    capabilities: CAPS,
  }).findings.filter((f) => f.diagnostic === "no-unawaited-adonis-validation");

const fires = (body: string) => {
  const found = findings(body);
  assert.ok(found.length > 0, `expected a FIRE on:\n${body}`);
  return found;
};
const silent = (body: string): void =>
  assert.equal(findings(body).length, 0, `expected SILENCE on:\n${body}`);

describe("no-unawaited-adonis-validation", () => {
  describe("the defect", () => {
    test("the payload handed straight to a write — the expensive spelling", () => {
      // Nothing reads a field here, so a member-only check would miss it while
      // a Promise gets written to the database.
      fires(`    const payload = request.validateUsing(createUserValidator);\n    await User.create(payload);`);
    });

    test("a field read off the binding", () => {
      fires(`    const payload = request.validateUsing(v);\n    return payload.email;`);
    });

    test("destructuring the Promise", () => {
      fires(`    const { email } = request.validateUsing(v);\n    return email;`);
    });

    test("a member read directly on the call", () => {
      fires(`    return request.validateUsing(v).email;`);
    });

    test("a qualified receiver", () => {
      fires(`    const p = ctx.request.validateUsing(v);\n    await User.create(p);`);
    });

    test("the message names all three consequences", () => {
      const [found] = fires(`    const payload = request.validateUsing(v);\n    await User.create(payload);`);
      assert.match(found!.message, /returns a \*\*Promise\*\*/);
      assert.match(found!.message, /accepted unvalidated/);
      assert.match(found!.message, /unhandled rejection/);
      assert.match(found!.recommendation ?? "", /await request\.validateUsing/);
    });
  });

  describe("silence — the Promise is resolved before use", () => {
    test("awaited inline", () => {
      silent(`    const payload = await request.validateUsing(v);\n    await User.create(payload);`);
      silent(`    const { email } = await request.validateUsing(v);\n    return email;`);
    });

    test("awaited later through the binding", () => {
      silent(`    const p = request.validateUsing(v);\n    const payload = await p;\n    await User.create(payload);`);
    });

    test("returned or chained", () => {
      silent(`    return request.validateUsing(v);`);
      silent(`    return request.validateUsing(v).then((p) => User.create(p));`);
      silent(`    return request.validateUsing(v).catch(handle);`);
    });

    test("collected into Promise.all", () => {
      silent(`    const [p] = await Promise.all([request.validateUsing(v)]);\n    await User.create(p);`);
    });
  });

  describe("precision guards", () => {
    test("a binding that is never used is a floating promise, not this rule", () => {
      silent(`    const p = request.validateUsing(v);\n    return response.ok({});`);
    });

    test("validateUsing on something that is not the request", () => {
      silent(`    const p = schema.validateUsing(v);\n    await User.create(p);`);
      silent(`    const p = form.validateUsing(v);\n    await User.create(p);`);
    });

    test("a computed call is not claimed", () => {
      silent(`    const p = request["validateUsing"](v);\n    await User.create(p);`);
    });
  });
});
