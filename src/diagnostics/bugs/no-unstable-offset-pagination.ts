import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode, Visitors } from "../../core/types.ts";
import { getMethodName, getObjectProperty, getReceiverName, getStaticStringValue, unwrapChain } from "../../core/ast.ts";
import { DB_RECEIVER_HINTS } from "../../core/signals.ts";

/**
 * §141 Pagination Correctness — OFFSET/`skip` pagination WITHOUT a stable,
 * deterministic sort order.
 *
 * WHY THIS BITES IN PRODUCTION
 *   OFFSET/`skip` pagination asks the database to "skip the first N rows and
 *   return the next page". But *which* N rows get skipped is only well-defined
 *   if the query has a total, stable ordering. With no `ORDER BY`, the engine is
 *   free to return rows in any order it likes, and — crucially — that order can
 *   CHANGE between the two round trips that fetch page 1 and page 2. Any row
 *   inserted or deleted (or re-sorted by a heap read) between fetches shifts the
 *   window: a row that was the last of page 1 slides to the top of page 2 and is
 *   returned TWICE, while another row falls into the gap between the pages and is
 *   never returned at all. The classic symptom is "the export is missing three
 *   orders and nobody knows why" — no error, no log, just silently dropped and
 *   duplicated rows that only appear under concurrent writes.
 *
 *   A stable `ORDER BY` (ideally on a unique key) makes paging deterministic:
 *   `OFFSET 20` always means the same 20 rows, so page boundaries line up. The
 *   robust fix is keyset/cursor pagination (`WHERE id > :last ORDER BY id`),
 *   which does not drift even under writes; a stable `ORDER BY` on a unique
 *   column is the minimum.
 *
 * WHAT FIRES — three query shapes, each anchored on the offending call:
 *   (1) Prisma-style options object: `.findMany` / `.findFirst` / `.aggregate` /
 *       `.groupBy` whose first argument is an object literal that HAS a `skip`
 *       property but NO `orderBy` property. `skip` is what makes it offset
 *       pagination — a `take`-only first-page query is fine and stays silent.
 *   (2) Query-builder chain (knex / objection / TypeORM query builder): a
 *       member-call chain that contains `.offset(...)` and a page size
 *       (`.limit(...)` or `.take(...)`) but NO order method
 *       (`.orderBy` / `.orderByRaw` / `.addOrderBy`, or any `orderBy*`) anywhere
 *       in the SAME chain. The chain is collected by walking both directions
 *       from the `.offset()` call (receiver-ward via `callee.object`, and
 *       result-ward via the enclosing member-calls).
 *   (3) Raw SQL: a call whose first argument is a fully-static string / no-
 *       substitution template literal that reads as a SELECT with an `OFFSET`
 *       clause but no `ORDER BY`.
 *
 * PRECISION — sound toward silence (a false positive here is a release blocker):
 *   - ANY order clause silences the finding. We do NOT try to prove the sort key
 *     is UNIQUE (unstable-because-non-unique needs schema knowledge and is out of
 *     scope) — the presence of `orderBy` / `.orderBy()` / `ORDER BY` is treated as
 *     "deterministic enough". This is a deliberate recall gap, not an oversight.
 *   - No `skip` / `.offset()` / `OFFSET` at all → nothing to page unstably; a
 *     first-page `take`/`limit` query is correct and stays silent.
 *   - Shape (1) bails when the options object contains a spread (`...opts`): a
 *     hidden `orderBy` could live inside it, so we cannot prove it absent. A
 *     `skip` nested inside a callback/child object is not a direct property and
 *     is never read as the pagination `skip` (getObjectProperty is top-level).
 *   - Shape (3) requires the literal to actually look like SQL (`\bSELECT\b`)
 *     before matching `OFFSET`, so an ordinary string that merely contains the
 *     word "offset" (a log line, a UI label) never fires. A dynamic/concatenated
 *     query is opaque (getStaticStringValue → null) and stays silent — we only
 *     flag a query we can fully read.
 *
 * ❌ db.user.findMany({ skip: 20, take: 10 });                       // shape 1
 * ❌ qb.offset(20).limit(10);                                        // shape 2
 * ❌ db.query("SELECT * FROM t LIMIT 10 OFFSET 20");                 // shape 3
 * ✅ db.user.findMany({ skip: 20, take: 10, orderBy: { id: "asc" } });
 * ✅ db.user.findMany({ take: 10 });                                 // no skip
 * ✅ qb.orderBy("id").offset(20).limit(10);
 * ✅ db.query("SELECT * FROM t ORDER BY id LIMIT 10 OFFSET 20");
 */

const MESSAGE =
  "offset pagination (`skip`/`OFFSET`) without a stable `ORDER BY` — rows shift as data is inserted/deleted between page fetches, so pages silently drop and duplicate rows. Add a stable, unique sort key (e.g. `orderBy: { id: 'asc' }`), or use keyset/cursor pagination.";

/** Prisma-style read methods whose options object may carry `skip`/`orderBy`. */
const PRISMA_METHODS = new Set(["findMany", "findFirst", "aggregate", "groupBy"]);

/**
 * Segment-aware db-receiver test (the shared shape used by the other db rules). It
 * is what keeps shape 1 from firing on a look-alike `.findMany`/`.groupBy`/
 * `.aggregate` method on a NON-database object — an array helper, a stream operator,
 * a lodash-style collection — which name-only matching would wrongly flag.
 */
const isDbReceiver = (receiver: string | null): boolean => {
  if (!receiver) return false;
  const segments = receiver.split(".").map((s) => s.toLowerCase());
  for (const seg of segments) {
    for (const hint of DB_RECEIVER_HINTS) {
      if (hint.length < 4) {
        if (seg === hint) return true;
      } else if (seg.includes(hint)) {
        return true;
      }
    }
  }
  return false;
};

/**
 * Is this `skip` value a genuine OFFSET into page 2+ (where row drift bites)?
 * A positive numeric literal (`skip: 20`), or any dynamic expression (`skip: offset`
 * — could be any page at runtime). NOT `skip: 0` (page 1, deterministic), and NOT a
 * boolean/null/string (`skip: true` is a flag on some non-Prisma `.findMany`, not an
 * offset) — those keep the rule from firing on a look-alike that never paginates.
 */
const isOffsetSkip = (value: AstNode | null | undefined): boolean => {
  if (!value) return false;
  if (value.type === "Literal") return typeof value.value === "number" && value.value > 0;
  if (value.type === "UnaryExpression" || value.type === "TemplateLiteral") return false;
  return true; // an identifier / member / call / binary → could be page 2+
};

/** Query-builder page-size methods that mark a chain as paginating. */
const LIMIT_METHODS = new Set(["limit", "take"]);

/** Is `m` a query-builder order method (`orderBy`, `orderByRaw`, `addOrderBy`, …)? */
const isOrderMethod = (m: string): boolean => m === "addOrderBy" || m.startsWith("orderBy");

/** Does the object literal contain a spread element (making its keys opaque)? */
const hasSpread = (obj: AstNode): boolean =>
  ((obj.properties as AstNode[]) ?? []).some((p) => p.type === "SpreadElement");

// Static-SQL heuristics (no `g` flag → no lastIndex state → deterministic).
const SQL_SELECT_RE = /\bSELECT\b/i;
const OFFSET_RE = /\bOFFSET\b/i;
// MySQL's `LIMIT <offset>, <count>` — the two-argument form IS offset pagination.
const LIMIT_OFFSET_COMMA_RE = /\bLIMIT\s+\d+\s*,\s*\d+/i;
const ORDER_BY_RE = /\bORDER\s+BY\b/i;

/**
 * Every method name in the member-call chain that the `.offset()` call at
 * `offsetCall` belongs to. Walks receiver-ward through `callee.object` and
 * result-ward through the enclosing member-calls, so `.orderBy()` on either side
 * of `.offset()` is seen.
 */
const chainMethodNames = (offsetCall: AstNode): Set<string> => {
  const names = new Set<string>();

  // Receiver-ward: `a.orderBy().offset()` → follow `.callee.object`.
  let cur: AstNode | null = offsetCall;
  while (cur && cur.type === "CallExpression") {
    const m = getMethodName(cur);
    if (m) names.add(m);
    const callee = unwrapChain(cur.callee);
    cur = callee?.type === "MemberExpression" ? unwrapChain(callee.object) : null;
  }

  // Result-ward: `.offset().limit()` → follow the enclosing member-call.
  let up: AstNode | null = offsetCall;
  while (up) {
    const parent = up.parent as AstNode | null | undefined;
    if (parent?.type === "MemberExpression" && parent.object === up) {
      const gp = parent.parent as AstNode | null | undefined;
      if (gp?.type === "CallExpression" && gp.callee === parent) {
        const m = getMethodName(gp);
        if (m) names.add(m);
        up = gp;
        continue;
      }
    }
    break;
  }

  return names;
};

export const noUnstableOffsetPagination = defineDiagnostic({
  id: "no-unstable-offset-pagination",
  title: "Offset pagination without a stable sort order",
  severity: "warn",
  category: "Bugs",
  scope: "file",
  tags: ["correctness"],
  defaultEnabled: false,
  confidence: "high",
  recommendation:
    "Give every `skip`/`OFFSET` query a stable, unique sort key (e.g. `orderBy: { id: 'asc' }` or `ORDER BY id`), or switch to keyset/cursor pagination. Without a deterministic order, rows inserted or deleted between page fetches shift the window, so pages silently drop and duplicate records.",
  create: (ctx): Visitors => ({
    CallExpression: (node) => {
      const method = getMethodName(node);
      const args = (node.arguments as AstNode[]) ?? [];

      // Shape 1 — Prisma-style options object: a real offset `skip`, `orderBy`
      // absent, on a DB-shaped receiver (so a non-DB `.findMany`/`.groupBy` is safe).
      if (method && PRISMA_METHODS.has(method) && isDbReceiver(getReceiverName(node))) {
        const opts = args[0];
        if (opts && opts.type === "ObjectExpression" && !hasSpread(opts)) {
          const skipProp = getObjectProperty(opts, "skip");
          const hasOrderBy = getObjectProperty(opts, "orderBy") !== null;
          if (isOffsetSkip(skipProp?.value as AstNode | undefined) && !hasOrderBy) ctx.report(node, MESSAGE);
        }
        return;
      }

      // Shape 2 — query-builder chain: `.offset()` + page size, no order method.
      if (method === "offset") {
        const names = chainMethodNames(node);
        const hasLimit = [...names].some((m) => LIMIT_METHODS.has(m));
        const hasOrder = [...names].some(isOrderMethod);
        if (hasLimit && !hasOrder) ctx.report(node, MESSAGE);
        return;
      }

      // Shape 3 — raw SQL literal: a SELECT that offsets (an `OFFSET` clause, or
      // MySQL's `LIMIT <offset>, <count>` two-argument form) but has no ORDER BY.
      const sql = getStaticStringValue(args[0]);
      if (sql && SQL_SELECT_RE.test(sql) && (OFFSET_RE.test(sql) || LIMIT_OFFSET_COMMA_RE.test(sql)) && !ORDER_BY_RE.test(sql)) {
        ctx.report(node, MESSAGE);
      }
    },
  }),
});
