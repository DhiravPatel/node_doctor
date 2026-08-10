/**
 * §3 — GraphQL resolvers are request handlers.
 *
 * Before this, `collectRequestHandlers` knew method-call registrations, the
 * Fastify object form, HTTP decorators and convention exports — and nothing
 * about a resolver. A GraphQL-only backend therefore got no request-path
 * analysis at all. Recognizing the two resolver shapes costs one extension
 * point and covers every request-path rule at once.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noQueryInLoop } from "../../src/diagnostics/db/no-query-in-loop.ts";
import { noSyncIoInRequestPath } from "../../src/diagnostics/event-loop/no-sync-io-in-request-path.ts";

const CAPS = new Set(["node", "esm", "typescript", "prisma"]);
const RULES = [noQueryInLoop, noSyncIoInRequestPath] as never;
const findings = (source: string) =>
  lintSource({ filePath: "/repo/src/resolvers.ts", sourceText: source, diagnostics: RULES, capabilities: CAPS }).findings;

const fires = (source: string) => assert.ok(findings(source).length > 0, `expected a FIRE on:\n${source}`);
const silent = (source: string) =>
  assert.equal(findings(source).length, 0, `expected SILENCE on:\n${source}`);

describe("GraphQL resolvers are on the request path", () => {
  test("a resolver map's Query field", () => {
    fires(
      `export const resolvers = {\n  Query: {\n    async users(_p, args) {\n      const out = [];\n      for (const id of args.ids) { out.push(await prisma.user.findMany({ where: { id } })); }\n      return out;\n    },\n  },\n};`,
    );
  });

  test("a resolver map's Mutation field", () => {
    fires(
      `import { readFileSync } from "node:fs";\nexport const resolvers = {\n  Mutation: {\n    upload(_p, a) { return readFileSync(a.path, "utf8"); },\n  },\n};`,
    );
  });

  test("the decorator form, including `@ResolveField`", () => {
    // `@ResolveField` runs per PARENT ROW, which makes an N+1 there worse than
    // in a REST handler, not better.
    fires(
      `class R {\n  @Query(() => [User])\n  async users(ids) { for (const id of ids) { await prisma.user.findMany({ where: { id } }); } }\n}`,
    );
    fires(
      `class R {\n  @ResolveField()\n  async posts(u) { for (const id of u.ids) { await prisma.post.findMany({ where: { id } }); } }\n}`,
    );
  });
});

describe("GraphQL recognition stays narrow", () => {
  test("a capitalized namespace object is not a resolver map", () => {
    // Guessing that any capitalized key is a GraphQL type would sweep in every
    // ordinary namespace object in the file.
    silent(`export const Helpers = {\n  Format: {\n    money(v) { return v; },\n  },\n};`);
  });

  test("a root key whose value is not an object of functions", () => {
    silent(`export const config = { Query: "SELECT 1", Mutation: null };`);
  });

  test("a clean resolver reports nothing", () => {
    silent(
      `export const resolvers = {\n  Query: {\n    async users(_p, a) { return prisma.user.findMany({ where: { id: { in: a.ids } } }); },\n  },\n};`,
    );
  });
});
