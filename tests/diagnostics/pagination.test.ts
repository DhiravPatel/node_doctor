/**
 * §141 Pagination Correctness:
 *   - no-unstable-offset-pagination (Bugs)
 *
 * Self-contained: imports the diagnostic module directly and lints with an
 * explicit diagnostic list, so it does not depend on the generated registry.
 * The rule is opt-in and precision-first — a false positive would falsely flag a
 * correctly-ordered query and block a release, so the SILENT block is the larger
 * one and asserts every deliberate-silence path.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noUnstableOffsetPagination } from "../../src/diagnostics/bugs/no-unstable-offset-pagination.ts";
import type { Diagnostic } from "../../src/core/types.ts";

const CAPS = new Set(["node", "esm", "typescript", "prisma"]);

const findingsFor = (diagnostic: Diagnostic, source: string) => {
  const { findings, parseFailed } = lintSource({
    filePath: "test.ts",
    sourceText: source,
    diagnostics: [diagnostic],
    capabilities: CAPS,
  });
  assert.ok(!parseFailed, `source failed to parse:\n${source}`);
  return findings.filter((f) => f.diagnostic === diagnostic.id);
};

const fires = (diagnostic: Diagnostic, source: string): void =>
  assert.ok(findingsFor(diagnostic, source).length > 0, `expected ${diagnostic.id} to FIRE on:\n${source}`);

const silent = (diagnostic: Diagnostic, source: string): void =>
  assert.equal(findingsFor(diagnostic, source).length, 0, `expected ${diagnostic.id} to STAY SILENT on:\n${source}`);

describe("no-unstable-offset-pagination", () => {
  const D = noUnstableOffsetPagination;

  // FIRES — shape 1: Prisma-style `skip` with no `orderBy` -----------------
  test("fires: findMany with skip and take, no orderBy", () => {
    fires(D, "db.user.findMany({ skip: 20, take: 10 });");
  });
  test("fires: prisma / repository receivers, and MySQL `LIMIT offset, count`", () => {
    fires(D, "prisma.user.findMany({ skip: 20 });");
    fires(D, "userRepo.findMany({ skip: 20 });");
    fires(D, 'db.query("SELECT * FROM t LIMIT 20, 10");');
  });
  test("fires: findFirst with skip, no orderBy", () => {
    fires(D, "db.user.findFirst({ skip: 5, where: { active: true } });");
  });
  test("fires: aggregate with skip, no orderBy", () => {
    fires(D, "db.order.aggregate({ skip: 100, _sum: { total: true } });");
  });
  test("fires: groupBy with skip, no orderBy", () => {
    fires(D, "db.order.groupBy({ by: ['status'], skip: 40 });");
  });
  test("fires: string key `skip` still counts", () => {
    fires(D, 'db.user.findMany({ "skip": 20, take: 10 });');
  });

  // FIRES — shape 2: query-builder `.offset()` chain, no order method ------
  test("fires: offset then limit, no orderBy", () => {
    fires(D, "qb.offset(20).limit(10);");
  });
  test("fires: offset then take (TypeORM), no orderBy", () => {
    fires(D, "qb.where('x = 1').offset(20).take(10).getMany();");
  });
  test("fires: limit before offset — order in the chain does not matter", () => {
    fires(D, "qb.limit(10).offset(20);");
  });

  // FIRES — shape 3: raw SQL with OFFSET, no ORDER BY ----------------------
  test("fires: raw SQL LIMIT/OFFSET, no ORDER BY", () => {
    fires(D, 'db.query("SELECT * FROM t LIMIT 10 OFFSET 20");');
  });
  test("fires: raw SQL, lowercase keywords", () => {
    fires(D, 'conn.execute("select id from orders offset 40 limit 20");');
  });
  test("fires: no-substitution template literal SQL", () => {
    fires(D, "db.query(`SELECT * FROM t OFFSET 20 LIMIT 10`);");
  });

  // MUST BE SILENT --------------------------------------------------------
  test("silent: findMany with skip AND orderBy", () => {
    silent(D, 'db.user.findMany({ skip: 20, take: 10, orderBy: { id: "asc" } });');
  });
  test("silent: a non-offset `skip` — `skip: 0` (page 1) or `skip: true` (a flag, not a Prisma offset)", () => {
    silent(D, "db.user.findMany({ skip: 0, take: 10 });");
    silent(D, "list.findMany({ skip: true, take: 5 });");
  });
  test("silent: a look-alike `findMany`/`aggregate`/`groupBy` on a NON-db receiver", () => {
    silent(D, "list.findMany({ skip: 1 });");
    silent(D, "[1, 2, 3].findMany({ skip: 1 });");
    silent(D, "metrics.aggregate({ skip: 3 });");
    silent(D, "things.groupBy({ skip: 2, take: 4 });");
  });
  test("silent: findMany with take but no skip (first page)", () => {
    silent(D, "db.user.findMany({ take: 10 });");
  });
  test("silent: findMany with no options at all", () => {
    silent(D, "db.user.findMany();");
  });
  test("silent: findMany with orderBy and no skip", () => {
    silent(D, 'db.user.findMany({ take: 10, orderBy: { id: "asc" } });');
  });
  test("silent: spread in options could hide an orderBy (opaque)", () => {
    silent(D, "db.user.findMany({ skip: 20, ...pageOpts });");
  });
  test("silent: `skip` nested inside a callback is not the pagination skip", () => {
    silent(D, "db.user.findMany({ where: { fn: () => { const skip = 1; return skip; } }, take: 10 });");
  });
  test("silent: query-builder chain with orderBy before offset", () => {
    silent(D, 'qb.orderBy("id").offset(20).limit(10);');
  });
  test("silent: query-builder chain with addOrderBy (TypeORM)", () => {
    silent(D, 'qb.offset(20).take(10).addOrderBy("t.id", "ASC");');
  });
  test("silent: query-builder chain with orderByRaw", () => {
    silent(D, 'qb.offset(20).limit(10).orderByRaw("id asc");');
  });
  test("silent: `.offset()` alone with no page size", () => {
    silent(D, "qb.offset(20);");
  });
  test("silent: raw SQL with ORDER BY present", () => {
    silent(D, 'db.query("SELECT * FROM t ORDER BY id LIMIT 10 OFFSET 20");');
  });
  test("silent: raw SQL with ORDER  BY (extra whitespace) present", () => {
    silent(D, 'db.query("SELECT * FROM t ORDER  BY id OFFSET 20");');
  });
  test("silent: dynamic/opaque SQL string", () => {
    silent(D, "db.query(dynamicSql);");
  });
  test("silent: interpolated (non-static) SQL is opaque", () => {
    silent(D, "db.query(`SELECT * FROM t OFFSET ${n}`);");
  });
  test("silent: ordinary string that merely contains the word 'offset'", () => {
    silent(D, 'logger.info("recomputing the scroll offset for the page");');
  });

  // MESSAGE ---------------------------------------------------------------
  test("message names the missing ORDER BY and the fix", () => {
    const [f] = findingsFor(D, "db.user.findMany({ skip: 20, take: 10 });");
    assert.ok(f, "expected a finding");
    assert.match(f.message, /ORDER BY/);
    assert.match(f.message, /drop and duplicate/);
    assert.match(f.message, /keyset\/cursor/);
  });
});
