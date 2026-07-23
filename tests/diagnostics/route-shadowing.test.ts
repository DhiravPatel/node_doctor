/**
 * no-shadowed-route (§4) — a route made unreachable by an earlier, more general
 * route on the same router. The precision guards are the point: same receiver,
 * same method, a fully-static victim, and a constrained param that is never
 * assumed to match.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noShadowedRoute } from "../../src/diagnostics/bugs/no-shadowed-route.ts";
import { capabilitiesSatisfied } from "../../src/core/project.ts";

const count = (source: string): number =>
  lintSource({
    filePath: "src/routes.ts",
    sourceText: source,
    diagnostics: [noShadowedRoute],
    capabilities: new Set(["node", "esm", "typescript", "express"]),
  }).findings.filter((f) => f.diagnostic === "no-shadowed-route").length;

const fires = (s: string): void => assert.ok(count(s) > 0, `expected FIRE:\n${s}`);
const silent = (s: string): void => assert.equal(count(s), 0, `expected SILENT:\n${s}`);

describe("no-shadowed-route", () => {
  // Order-based matching only. Fastify/hapi resolve by specificity, so the same
  // registration order is NOT a bug there — the rule must not run.
  test("gated to Express, and off when Fastify is present", () => {
    const bug = `const router = express.Router();\nrouter.get("/users/:id", show); router.get("/users/me", me);`;
    const gated = (caps: string[]) =>
      capabilitiesSatisfied(noShadowedRoute, new Set(caps)) &&
      lintSource({ filePath: "r.ts", sourceText: bug, diagnostics: [noShadowedRoute], capabilities: new Set(caps) })
        .findings.length > 0;
    assert.equal(gated(["node", "esm", "express"]), true, "runs on Express");
    assert.equal(gated(["node", "esm", "express", "fastify"]), false, "off when Fastify present");
    assert.equal(gated(["node", "esm", "koa"]), false, "off without Express");
  });

  test("a param route before a static route it covers makes the static route dead", () => {
    fires(`const router = express.Router();\nrouter.get("/users/:id", show); router.get("/users/me", me);`);
    fires(`const app = express();\napp.get("/a/:x/b", h1); app.get("/a/c/b", h2);`);
  });

  test("an earlier .all catch-all shadows a later get", () => {
    fires(`const router = express.Router();\nrouter.all("/users/:id", g); router.get("/users/me", me);`);
  });

  test("a trailing wildcard shadows a deeper static route", () => {
    fires(`const app = express();\napp.get("/files/*", h1); app.get("/files/readme", h2);`);
  });

  // Correct ordering — the whole point is that order is what's wrong.
  test("silent when the specific route is registered first", () => {
    silent(`const router = express.Router();\nrouter.get("/users/me", me); router.get("/users/:id", show);`);
  });

  test("silent across different methods and different receivers", () => {
    silent(`const router = express.Router();\nrouter.get("/users/:id", show); router.post("/users/me", me);`);
    silent(`const router = express.Router();\nconst adminRouter = express.Router();\nrouter.get("/users/:id", show); adminRouter.get("/users/me", me);`);
  });

  // The key false-positive guard: a constrained param cannot be proven to match.
  test("silent when the earlier param carries a regex constraint", () => {
    silent(`const router = express.Router();\nrouter.get("/users/:id(\\\\d+)", show); router.get("/users/me", me);`);
  });

  test("silent on unrelated paths, different lengths, and param victims", () => {
    silent(`const router = express.Router();\nrouter.get("/users/:id", show); router.get("/posts/me", me);`);
    silent(`const router = express.Router();\nrouter.get("/users/:id", show); router.get("/users/me/posts", h);`);
    silent(`const router = express.Router();\nrouter.get("/users/:id", show); router.get("/users/:slug", other);`);
  });

  // An exact duplicate belongs to no-duplicate-route-definition, not here.
  test("silent on an exact duplicate (that is the duplicate rule's job)", () => {
    silent(`const router = express.Router();\nrouter.get("/users", a); router.get("/users", b);`);
  });

  // Two express.Router() built in two factory functions are both named `router`
  // but are DIFFERENT instances — a verified false positive caught in review.
  test("silent when two same-named routers are distinct instances (router factory)", () => {
    silent(
      `export function makeA(){ const router = express.Router(); router.get("/:id", show); return router; }
` +
        `export function makeB(){ const router = express.Router(); router.get("/me", me); return router; }`,
    );
  });

  test("silent when the receiver is reassigned to a fresh router between registrations", () => {
    silent(`let router = express.Router(); router.get("/:id", show); router = express.Router(); router.get("/me", me);`);
  });

  test("silent when the receiver cannot be resolved to a binding (bare global / this.x)", () => {
    silent(`router.get("/users/:id", show); router.get("/users/me", me);`); // no declaration → unresolvable
  });

  test("silent on a bare (non-member) call and a dynamic path", () => {
    silent(`get("/users/:id", show); get("/users/me", me);`);
    silent(`const router = express.Router();\nrouter.get(buildPath(), show); router.get("/users/me", me);`);
  });
});
