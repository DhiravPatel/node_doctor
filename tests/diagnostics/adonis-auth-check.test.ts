/**
 * `no-unawaited-adonis-auth-check`.
 *
 * Read from the SHIPPED type declarations of `@adonisjs/auth` 9.6.0 and
 * `@adonisjs/bouncer` 3.1.6:
 *
 *   check(): Promise<boolean>            allows(...): Promise<boolean>
 *   authenticate(): Promise<User>        denies(...): Promise<boolean>
 *   login(user): Promise<void>           authorize(...): Promise<void>
 *   logout(): Promise<void>
 *
 * And a Promise is truthy whatever it resolves to — verified by running it:
 *
 *   Boolean(Promise.resolve(false))  → true
 *   if (Promise.resolve(false))      → the branch IS taken
 *   !Promise.resolve(true)           → false
 *
 * So `if (!auth.check()) return response.unauthorized()` never returns
 * unauthorized: the guard is skipped for every request and the handler below runs
 * for anonymous callers. `bouncer.allows(…)` without `await` fails the same way —
 * always true, so everyone is authorized. `bouncer.denies(…)` fails CLOSED, which
 * is wrong but survives review for about an hour; the bypass direction is the one
 * that ships.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noUnawaitedAdonisAuthCheck } from "../../src/diagnostics/frameworks/no-unawaited-adonis-auth-check.ts";

const CAPS = new Set(["node", "esm", "typescript", "adonis"]);
const controller = (body: string) =>
  `export default class PostsController {\n  async index(ctx) {\n    const { auth, bouncer, response } = ctx;\n${body}\n  }\n}`;

const findings = (body: string) =>
  lintSource({
    filePath: "/repo/app/controllers/posts_controller.ts",
    sourceText: controller(body),
    diagnostics: [noUnawaitedAdonisAuthCheck],
    capabilities: CAPS,
  }).findings.filter((f) => f.diagnostic === "no-unawaited-adonis-auth-check");

const fires = (body: string) => {
  const found = findings(body);
  assert.ok(found.length > 0, `expected a FIRE on:\n${body}`);
  return found;
};
const silent = (body: string): void =>
  assert.equal(findings(body).length, 0, `expected SILENCE on:\n${body}`);

describe("no-unawaited-adonis-auth-check", () => {
  describe("the defect", () => {
    test("the guard that never rejects — the bypass", () => {
      fires(`    if (!auth.check()) return response.unauthorized();\n    return listPosts();`);
    });

    test("the positive form, which is always taken", () => {
      fires(`    if (auth.check()) return listPosts();\n    return response.unauthorized();`);
    });

    test("bouncer.allows — always authorized", () => {
      fires(`    if (bouncer.allows("edit", post)) return edit();\n    return response.forbidden();`);
    });

    test("bouncer.denies, negated", () => {
      fires(`    if (!bouncer.denies("edit", post)) return edit();\n    return response.forbidden();`);
    });

    test("every async predicate in the set", () => {
      for (const call of ["auth.check()", "auth.authenticate()", "bouncer.allows('e')", "bouncer.denies('e')", "bouncer.authorize('e')"]) {
        fires(`    if (${call}) return 1;\n    return 2;`);
      }
    });

    test("a qualified receiver — ctx.auth, this.bouncer", () => {
      fires(`    if (!ctx.auth.check()) return response.unauthorized();\n    return 1;`);
      fires(`    if (this.bouncer.allows("edit")) return 1;\n    return 2;`);
    });

    test("a ternary test and a logical operand are condition positions too", () => {
      fires(`    return auth.check() ? "yes" : "no";`);
      fires(`    if (auth.check() && ready) return 1;\n    return 2;`);
      fires(`    while (auth.check()) break;\n    return 1;`);
    });

    test("the message names the mechanism and the verified truthiness", () => {
      const [found] = fires(`    if (!auth.check()) return response.unauthorized();\n    return 1;`);
      assert.match(found!.message, /returns a \*\*Promise\*\*/);
      assert.match(found!.message, /Boolean\(Promise\.resolve\(false\)\)/);
      assert.match(found!.message, /never rejects/);
      assert.match(found!.recommendation ?? "", /await auth\.check/);
    });
  });

  describe("silence — awaited, so the value is a boolean", () => {
    test("the correct guard", () => {
      silent(`    if (!(await auth.check())) return response.unauthorized();\n    return 1;`);
      silent(`    if (await bouncer.denies("edit", post)) return response.forbidden();\n    return 1;`);
    });

    test("awaited inside a logical expression", () => {
      silent(`    if ((await auth.check()) && ready) return 1;\n    return 2;`);
    });
  });

  describe("precision guards", () => {
    test("not a condition — a floating promise is a different rule's business", () => {
      silent(`    const p = auth.check();\n    return await p;`);
      silent(`    return auth.check();`);
      silent(`    await auth.check();\n    return 1;`);
    });

    test("the receiver segment must be auth or bouncer", () => {
      silent(`    if (cache.check()) return 1;\n    return 2;`);
      silent(`    if (policy.allows("edit")) return 1;\n    return 2;`);
      silent(`    if (schema.authorize()) return 1;\n    return 2;`);
    });

    test("a computed call is not claimed", () => {
      silent(`    if (auth["check"]()) return 1;\n    return 2;`);
    });

    test("a method not in the async set", () => {
      silent(`    if (auth.user) return 1;\n    return 2;`);
      silent(`    if (bouncer.with("PostPolicy")) return 1;\n    return 2;`);
    });
  });
});
