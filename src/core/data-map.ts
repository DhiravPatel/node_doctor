/**
 * Data Access Map & Route → Entity Lineage (§143).
 *
 * Two questions that a growing backend cannot answer from its own source without
 * reading every handler by hand:
 *
 *   1. "This route — which database tables does it touch, and does it read, write,
 *       or delete them?"  (the per-route lineage)
 *   2. "Which routes write `payments`?"  (the inverse: entity → the routes that
 *       touch it, and how)
 *
 * Both fall straight out of two things this engine already computes: the project
 * CALL GRAPH (`buildProjectGraph`, the same one impact/taint walk) and ORM/query
 * detection (`QUERY_METHODS` + `DB_RECEIVER_HINTS` in signals.ts, the same
 * vocabulary the N+1 and missing-await diagnostics use). We enumerate every route
 * handler, walk the call graph FORWARD from each one (mirroring
 * interprocedural-taint's per-handler forward walk), and at every call site ask a
 * single pure question — `queryTarget(call)`: is this a database query, and if so
 * against which entity and with what operation? The union of (entity, op) pairs
 * reachable from a route is that route's data lineage; inverting the index yields
 * the entity → routes view.
 *
 * CONSERVATIVE BY DESIGN. `queryTarget` returns a resolved (entity, op) only when
 * the shape is unambiguous; when a call is recognizably a query but the table
 * can't be pinned down (a dynamically-built SQL string, a raw `db.query(sql)`
 * with a variable argument) it is counted in `summary.unresolvedQueries` rather
 * than guessed at — a wrong table on a lineage map is worse than an honest gap.
 * A call that is not database-shaped at all simply contributes nothing.
 *
 * DETERMINISM is a hard invariant: identical input yields byte-identical output.
 * Source files are globbed and sorted; the forward walk is FIFO over a
 * deterministic pre-order call collection; routes are sorted by (file, line,
 * method, path); entities alphabetically; ops in the fixed order read < write <
 * delete. Nothing here reads a clock or a random source, and no `Map`/`Set`
 * iteration order ever reaches the output unsorted.
 */

import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";

import type { AstNode } from "./types.ts";
import type { NodeDoctorConfig } from "./config.ts";
import type { ScopeResolver } from "./scope.ts";
import type { ProjectGraph } from "./graph.ts";
import {
  getMethodName,
  getStaticStringValue,
  staticMemberPath,
  rootObjectName,
  unwrapChain,
  isFunctionLike,
} from "./ast.ts";
import { collectDescendants, walk, attachParents } from "./walk.ts";
import { resolveScopes } from "./scope.ts";
import { parseSource } from "./parse.ts";
import { createLocator } from "./location.ts";
import { collectRequestHandlers, looksLikeExpressHandler } from "./request-path.ts";
import { collectModuleFacts, buildProjectGraph } from "./graph.ts";
import { QUERY_METHODS, DB_RECEIVER_HINTS } from "./signals.ts";
import { BUILTIN_IGNORES } from "./config.ts";
import { mapPool } from "./pool.ts";

// ---------------------------------------------------------------------------
// Public shape.
// ---------------------------------------------------------------------------

/** How a route touches an entity. Fixed serialization order: read < write < delete. */
export type DataOp = "read" | "write" | "delete";

/** One route and the database entities it reaches, with the ops it performs on each. */
export interface RouteAccess {
  method: string;
  path: string;
  normalizedFilePath: string;
  line: number;
  entities: Array<{ entity: string; ops: DataOp[] }>;
}

/** The inverse index: one entity and the routes that touch it (the "who writes X?" view). */
export interface EntityAccess {
  entity: string;
  ops: DataOp[];
  routes: Array<{ method: string; path: string }>;
}

export interface DataAccessMap {
  routes: RouteAccess[];
  entities: EntityAccess[];
  summary: {
    routes: number;
    entities: number;
    /** Query call sites recognized as DB access whose target entity could not be resolved. */
    unresolvedQueries: number;
  };
}

const SOURCE_GLOB = "**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}";

/** HTTP verbs that register a route (mirrors api-surface.ts / observability.ts). */
const ROUTE_VERBS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "del",
  "options",
  "head",
  "all",
]);

// ---------------------------------------------------------------------------
// Entity + op extraction — the pure heart of the analysis.
// ---------------------------------------------------------------------------

/**
 * DB-receiver hints, extended with the transaction aliases (`tx`/`trx`) that
 * `<tx>.<model>.<method>` Prisma-in-a-transaction code uses. The shared
 * `DB_RECEIVER_HINTS` (signals.ts) deliberately omits them because the diagnostics
 * that consume it did not need them; the lineage map does, and the spec calls them
 * out explicitly (prisma/db/client/tx/…). Left as a local superset so signals.ts
 * stays untouched.
 */
const DB_HINTS = new Set<string>([...DB_RECEIVER_HINTS, "tx", "trx"]);

/**
 * Segment-aware db-receiver test, identical in spirit to `no-query-in-loop`'s:
 * a short hint (`db`, `em`, `tx`) must match a whole dotted segment so `items`
 * never matches `em`; a longer hint (`repo`, `prisma`) may match a sub-segment
 * (`orderRepo` → `repo`). The receiver is a dotted path such as `this.prisma`.
 */
/**
 * Prefixes that make a `…client`-suffixed segment a DATABASE client. The generic
 * `client` hint matches only exactly (`const client = new PrismaClient()`) or with
 * one of these prefixes (`dbClient`, `pgClient`) — a substring match would claim
 * `twilioClient.messages.create(…)` / `openaiClient.chat.completions.create(…)` as
 * database writes, the exact phantom-entity FP the precision rule forbids.
 */
const CLIENT_COMPOUND_PREFIXES = new Set([
  "db", "prisma", "pg", "sql", "mongo", "mysql", "postgres", "orm", "data",
]);

export const isDbReceiver = (receiver: string): boolean => {
  const segments = receiver.split(".").map((s) => s.toLowerCase());
  for (const seg of segments) {
    if (seg === "client" || (seg.endsWith("client") && CLIENT_COMPOUND_PREFIXES.has(seg.slice(0, -6)))) {
      return true;
    }
    for (const hint of DB_HINTS) {
      if (hint === "client") continue; // handled above, never as a substring
      if (hint.length < 4) {
        if (seg === hint) return true;
      } else if (seg.includes(hint)) {
        return true;
      }
    }
  }
  return false;
};

/** The property name of a MemberExpression (plain or string-computed), or null. */
const memberPropertyName = (m: AstNode | null | undefined): string | null => {
  if (!m || m.type !== "MemberExpression") return null;
  if (!m.computed && m.property?.type === "Identifier") return m.property.name as string;
  if (m.computed && m.property?.type === "Literal" && typeof m.property.value === "string") {
    return m.property.value;
  }
  return null;
};

/** The trailing identifier of an Identifier or MemberExpression receiver, or null. */
const lastSegmentName = (expr: AstNode | null | undefined): string | null => {
  if (!expr) return null;
  if (expr.type === "Identifier") return expr.name as string;
  if (expr.type === "MemberExpression") return memberPropertyName(expr);
  return null;
};

/**
 * Method-name → operation classification. Prefix-anchored and case-insensitive so
 * `findMany`, `findUniqueOrThrow`, `deleteMany`, `bulkCreate` all classify off
 * their leading verb. Delete is tested before write before read; the three
 * prefix sets are disjoint in practice, so order only guards the odd
 * `deleteMany`-style compound.
 */
const READ_RE =
  /^(find|findone|findmany|findfirst|findunique|findall|findby|get|select|query|aggregate|count|groupby|first|exists|search)/i;
const WRITE_RE = /^(create|createmany|insert|update|updatemany|upsert|save|set|bulkcreate|increment)/i;
const DELETE_RE = /^(delete|deletemany|del|remove|destroy|drop|truncate|softdelete)/i;

const methodOp = (method: string): DataOp | null =>
  DELETE_RE.test(method) ? "delete" : WRITE_RE.test(method) ? "write" : READ_RE.test(method) ? "read" : null;

/**
 * Raw-SQL entry points. The `$`-prefixed names are Prisma's distinctive raw APIs
 * and are treated as database access on the method name alone; the generic
 * `query`/`execute`/`raw` require a db-hint receiver so `emitter.query(...)` or
 * `regexp.exec(...)`-adjacent shapes are not mistaken for SQL.
 */
const RAW_METHODS = new Set([
  "query",
  "execute",
  "raw",
  "$queryRaw",
  "$executeRaw",
  "$queryRawUnsafe",
  "$executeRawUnsafe",
]);

const isRawQueryCall = (calleeExpr: AstNode, method: string): boolean => {
  if (!RAW_METHODS.has(method)) return false;
  if (method.startsWith("$")) return true;
  const receiver = staticMemberPath(calleeExpr.object as AstNode | undefined);
  return !!receiver && isDbReceiver(receiver);
};

/**
 * Reduce a table reference to its bare name: the last DOT-SEPARATED segment (dots
 * inside quotes/brackets do not split, so `"public"."Order.Items"` → `Order.Items`),
 * with identifier quoting stripped — double quotes (`"public"."Users"` → `Users`),
 * MySQL backticks (`` `shop`.`items` `` → `items`), SQL-Server brackets
 * (`[dbo].[Orders]` → `Orders`).
 */
const cleanEntity = (raw: string): string => {
  const segments: string[] = [];
  let cur = "";
  let close = ""; // the closing delimiter we're inside, or ""
  for (const ch of raw) {
    if (close) {
      cur += ch;
      if (ch === close) close = "";
      continue;
    }
    if (ch === '"' || ch === "`") {
      close = ch;
      cur += ch;
    } else if (ch === "[") {
      close = "]";
      cur += ch;
    } else if (ch === ".") {
      segments.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  segments.push(cur);
  const last = (segments[segments.length - 1] ?? raw).trim();
  return last.replace(/[`"'[\]]/g, "").trim();
};

/**
 * Sentinel that replaces every `${…}` interpolation hole in a raw-SQL template. It
 * is word-character text so it fuses with adjacent identifier characters — a hole in
 * the table position (`` `FROM ${t}` `` → `FROM ⟨HOLE⟩`, `` `FROM us${x}ers` `` →
 * `FROM us⟨HOLE⟩ers`) produces a token containing the sentinel, which the extractor
 * rejects rather than guessing a partial/wrong table.
 */
const SQL_HOLE = "NDX0HOLE0XDN";

/**
 * SQL keywords that must never be reported as a table (they can sit in a table
 * position through a construct the extractor does not fully model — e.g. `SET` after
 * a `MERGE … WHEN MATCHED THEN UPDATE`). A captured token equal to one of these is
 * treated as unresolvable.
 */
const SQL_RESERVED = new Set<string>([
  "SET", "VALUES", "SELECT", "WHERE", "FROM", "INTO", "UPDATE", "DELETE", "INSERT",
  "JOIN", "INNER", "LEFT", "RIGHT", "OUTER", "CROSS", "FULL", "USING", "ON", "AND",
  "OR", "AS", "ORDER", "GROUP", "BY", "HAVING", "LIMIT", "OFFSET", "RETURNING",
  "WHEN", "MATCHED", "THEN", "NULL", "DEFAULT", "DISTINCT", "ALL", "UNION", "EXCEPT",
  "INTERSECT", "LOCK", "SHARE", "OF", "SKIP", "NOWAIT", "LOCKED", "WITH", "RECURSIVE",
  "MERGE", "TABLE", "DUAL",
]);

const TABLE_INTRO = new Set<string>(["FROM", "JOIN", "INTO", "UPDATE", "TABLE"]);

/**
 * Mask the parts of a SQL string that must NOT be scanned for a table keyword —
 * comments and string literals — in a single left-to-right pass that respects
 * string/comment/escape boundaries. A double-quoted / backticked / bracketed token
 * is PRESERVED only when it sits in a table position (right after FROM/JOIN/INTO/
 * UPDATE/TABLE), where it is an identifier; anywhere else it is treated as a string
 * (MySQL `"…"`) or an irrelevant column and masked. Masked regions become spaces so
 * keyword offsets and paren depth survive. This is what stops a `FROM`/`DELETE`
 * hidden in a comment or a `'…'` / `"…"` value from inventing a phantom table.
 */
const maskSqlNoise = (sql: string, preserveAllQuoted = false): string => {
  let out = "";
  let i = 0;
  let prevWord = "";
  const n = sql.length;
  const pad = (k: number): string => " ".repeat(Math.max(0, k));
  while (i < n) {
    const c = sql[i]!;
    if ((c === "-" && sql[i + 1] === "-") || c === "#") {
      let j = i;
      while (j < n && sql[j] !== "\n") j++;
      out += pad(j - i);
      i = j;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      // Bracketed comments NEST per the SQL standard (and PostgreSQL) — track depth
      // so `/* outer /* inner */ still comment */` masks as ONE comment.
      let j = i + 2;
      let depth = 1;
      while (j < n && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      out += pad(j - i);
      i = j;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "\\") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      out += pad(j - i);
      i = j;
      continue;
    }
    if (c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      while (j < n) {
        if (c === '"' && sql[j] === "\\") {
          j += 2;
          continue;
        }
        if (sql[j] === close) {
          // SQL-standard doubled-delimiter escape inside the token ("", ``, ]]).
          if (sql[j + 1] === close) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      j = Math.min(n, j + 1);
      out += preserveAllQuoted || TABLE_INTRO.has(prevWord) ? sql.slice(i, j) : pad(j - i);
      i = j; // a quoted token never becomes prevWord
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j]!)) j++;
      const word = sql.slice(i, j);
      out += word;
      prevWord = word.toUpperCase();
      i = j;
      continue;
    }
    out += c;
    if (!/\s/.test(c) && c !== ".") prevWord = ""; // punctuation ends a keyword run
    i++;
  }
  return out;
};

/**
 * Sentinel that replaces a top-level parenthesized group after blanking. It is
 * word-character text so a derived table's position keeps a token: `FROM (SELECT …)
 * sub` becomes `FROM ⟨SUBQ⟩ sub`, and the FROM capture is the sentinel — rejected
 * by `resolveTable` — rather than the alias `sub` masquerading as a real table.
 */
const SQL_SUBQ = "NDXSUBQXDN";

/** Blank everything inside parentheses (any depth) so only depth-0 keywords match —
 *  a `FROM` inside `EXTRACT(… FROM …)`, a sub-select, or a CTE body is neutralized.
 *  Each top-level group leaves the `SQL_SUBQ` sentinel in its place. */
const blankNestedParens = (s: string): string => {
  let out = "";
  let depth = 0;
  for (const ch of s) {
    if (ch === "(") {
      depth++;
      // The leading space keeps the sentinel from fusing with a preceding word —
      // `INSERT INTO t(a, b)` must still capture `t`, not reject `t⟨SUBQ⟩`.
      out += depth === 1 ? ` ${SQL_SUBQ}` : " ";
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
      out += " ";
    } else {
      out += depth > 0 && !/\s/.test(ch) ? " " : ch;
    }
  }
  return out;
};

/**
 * CTE definitions `WITH x AS ( … ), y AS ( … )` — alias (lower-cased, unquoted) →
 * the paren-balanced body text. Handles a column list (`tree(id, parent) AS (…)`),
 * `AS [NOT] MATERIALIZED (…)`, and quoted aliases (`WITH "tree" AS (…)`). Alias
 * NAMES are matched on the permissive mask (all quoted tokens visible); BODIES are
 * sliced from the strict mask at the same offsets (both masks are 1:1 with the raw
 * string), so a double-quoted MySQL string inside a body stays masked. The aliases
 * stop `FROM <alias>` from inventing a table; the bodies are the fallback parse
 * targets (so `WITH r AS (SELECT … FROM refunds) SELECT * FROM r` still maps to
 * `refunds:read`).
 */
const collectCtes = (
  masked: string,
  permissive: string,
): Map<string, { body: string; permissiveBody: string }> => {
  const ctes = new Map<string, { body: string; permissiveBody: string }>();
  const re = /("[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_$][\w$]*)\s*(?:\([^()]*\))?\s+AS\s+(?:NOT\s+MATERIALIZED\s*|MATERIALIZED\s*)?\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(permissive)) !== null) {
    const open = re.lastIndex - 1; // the "(" the regex just consumed
    let depth = 1;
    let j = open + 1;
    while (j < permissive.length && depth > 0) {
      if (permissive[j] === "(") depth++;
      else if (permissive[j] === ")") depth--;
      j++;
    }
    const name = cleanEntity(m[1]!).toLowerCase();
    if (name) {
      ctes.set(name, {
        body: masked.slice(open + 1, j - 1),
        permissiveBody: permissive.slice(open + 1, j - 1),
      });
    }
  }
  return ctes;
};

const stripLockingClauses = (s: string): string =>
  s
    .replace(/\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b[\s\S]*$/i, " ")
    .replace(/\bFOR\s+(?:KEY\s+)?SHARE\b[\s\S]*$/i, " ")
    .replace(/\bLOCK\s+IN\s+SHARE\s+MODE\b[\s\S]*$/i, " ");

// A (possibly schema-qualified, possibly quoted/backticked/bracketed) table
// identifier. Each quoted alternative admits the doubled-delimiter escape ("" ``
// ]]) so an escaped identifier is captured WHOLE — and then rejected by
// `resolveTable` rather than truncated at the inner quote.
const SQL_IDENT = '(?:"(?:[^"]|"")+"|`(?:[^`]|``)+`|\\[(?:[^\\]]|\\]\\])+\\]|[\\w$]+)';
const SQL_TABLE_REF = `(${SQL_IDENT}(?:\\s*\\.\\s*${SQL_IDENT})*)`;
const DELETE_FROM_RE = new RegExp(`\\bDELETE\\s+FROM\\s+${SQL_TABLE_REF}`, "i");
const INSERT_INTO_RE = new RegExp(`\\bINSERT\\s+INTO\\s+${SQL_TABLE_REF}`, "i");
const MERGE_INTO_RE = new RegExp(`\\bMERGE\\s+INTO\\s+${SQL_TABLE_REF}`, "i");
const SQL_UPDATE_RE = new RegExp(`\\bUPDATE\\s+${SQL_TABLE_REF}`, "i");
const SQL_FROM_RE = new RegExp(`\\bFROM\\s+${SQL_TABLE_REF}`, "i");

/**
 * Resolve one keyword form to a table, or null when the captured token is not a
 * usable table — a reserved keyword, a CTE alias, a token containing an
 * interpolation hole (`FROM public.${t}` / `FROM us${x}ers`), a blanked subquery
 * (`FROM (SELECT …) alias`), or an escaped-delimiter identifier. Conservative: an
 * unusable capture is a miss, never a guess.
 */
const resolveTable = (
  m: RegExpExecArray | null,
  op: DataOp,
  cteAliases: Set<string>,
): { entity: string; op: DataOp } | null => {
  if (!m) return null;
  const raw = m[1]!;
  if (raw.includes(SQL_HOLE) || raw.includes(SQL_SUBQ)) return null;
  if (raw.includes('""') || raw.includes("``") || raw.includes("]]")) return null;
  const entity = cleanEntity(raw);
  if (!entity) return null;
  if (entity.includes(SQL_HOLE)) return null;
  if (SQL_RESERVED.has(entity.toUpperCase())) return null;
  if (cteAliases.has(entity.toLowerCase())) return null;
  return { entity, op };
};

/**
 * Extract (entity, op) from a static SQL string. The string is first lexed to mask
 * comments and string literals (preserving only table-position quoted identifiers),
 * then all parenthesized groups are blanked so only depth-0 keywords match (skipping
 * a `FROM` inside a function/sub-select/CTE body). `DELETE FROM` / `INSERT INTO` /
 * `MERGE INTO` / `UPDATE` take priority over a trailing `FROM`, and any capture that
 * is a reserved word, a CTE alias, or an interpolation hole is rejected. When the
 * outer statement resolves nothing (typically because its FROM targets a CTE alias),
 * each CTE body is parsed in turn — bounded depth, so `WITH r AS (SELECT … FROM
 * refunds) SELECT * FROM r` maps to `refunds:read` while a constant-body CTE stays
 * unresolved. Returns null (an unresolved query, recorded by the caller) when nothing
 * resolves — a miss is always preferred to a phantom table.
 */
/** Keyword forms in priority order — first REGEX MATCH wins the statement. */
const SQL_FORMS: ReadonlyArray<readonly [RegExp, DataOp]> = [
  [DELETE_FROM_RE, "delete"],
  [INSERT_INTO_RE, "write"],
  [MERGE_INTO_RE, "write"],
  [SQL_UPDATE_RE, "write"],
  [SQL_FROM_RE, "read"],
];

const parseMaskedSql = (
  masked: string,
  permissive: string,
  depth: number,
  inheritedAliases: ReadonlySet<string>,
): { entity: string; op: DataOp } | null => {
  const ctes = collectCtes(masked, permissive);
  // A CTE body inherits the outer statement's aliases — a recursive CTE references
  // ITSELF (`WITH RECURSIVE tree AS (… FROM tree …)`), and a later CTE references
  // an earlier one; neither reference is a real table.
  const aliases = new Set<string>([...inheritedAliases, ...ctes.keys()]);
  const viaCtes = (): { entity: string; op: DataOp } | null => {
    if (depth >= 2) return null;
    for (const { body, permissiveBody } of ctes.values()) {
      const r = parseMaskedSql(body, permissiveBody, depth + 1, aliases);
      if (r) return r;
    }
    return null;
  };
  const sql = stripLockingClauses(blankNestedParens(masked));
  for (const [re, op] of SQL_FORMS) {
    const m = re.exec(sql);
    if (!m) continue;
    // The FIRST keyword form that matches OWNS the statement. If its capture is
    // unusable (a hole, an alias, a subquery sentinel), the statement's target is
    // unknown — falling through to a lower-priority form would attribute a WRONG
    // table (`INSERT INTO ${t} … ON DUPLICATE KEY UPDATE col = …` must not become
    // `col:write`), so only the CTE-body fallback remains.
    return resolveTable(m, op, aliases) ?? viaCtes();
  }
  return viaCtes();
};

const parseSql = (rawSql: string): { entity: string; op: DataOp } | null =>
  parseMaskedSql(maskSqlNoise(rawSql), maskSqlNoise(rawSql, true), 0, new Set());

/**
 * The SQL text of a raw-query argument, static parts only. A plain string (or a
 * no-substitution template) is returned verbatim by `getStaticStringValue`. A
 * template literal WITH interpolations — `` `SELECT * FROM users WHERE id = ${x}` ``
 * or Prisma's tagged `` $queryRaw`…` `` — is reconstructed from its static quasis
 * with each `${…}` hole replaced by the `SQL_HOLE` sentinel, so the table-bearing
 * keyword in the static text still resolves while a hole in the table position stays
 * deliberately unresolved rather than guessed.
 */
const staticSqlText = (node: AstNode | undefined): string | null => {
  if (!node) return null;
  const direct = getStaticStringValue(node);
  if (direct !== null) return direct;
  if (node.type !== "TemplateLiteral") return null;
  const quasis = node.quasis as AstNode[] | undefined;
  if (!quasis || quasis.length === 0) return null;
  return quasis
    .map((q) => (q.value as { cooked?: string | null } | undefined)?.cooked ?? "")
    .join(SQL_HOLE);
};

/**
 * Walk a Knex/query-builder chain from its terminal call downward looking for the
 * table string. Handles the base form `db("orders")…` (a db-hint identifier called
 * with a string literal) and the scoping form `.from("x")` / `.into("x")` /
 * `.table("x")`. Returns the table verbatim, or null when none is a string literal
 * (a dynamic table is left unresolved rather than guessed). `guard` bounds the
 * descent so a pathological chain can never loop.
 */
const findKnexTable = (terminalCall: AstNode): string | null => {
  let node: AstNode | null = terminalCall;
  let guard = 0;
  while (node && guard++ < 64) {
    if (node.type === "CallExpression") {
      const cal = unwrapChain(node.callee as AstNode);
      const arg0 = ((node.arguments as AstNode[]) ?? [])[0];
      // Base call: db("orders") / knex("users").
      if (cal && cal.type === "Identifier" && isDbReceiver(cal.name as string)) {
        const s = getStaticStringValue(arg0);
        if (s !== null) return cleanEntity(s);
      }
      // Scoping call: x.from("orders") / x.into("audit") / x.table("t").
      if (cal && cal.type === "MemberExpression") {
        const prop = memberPropertyName(cal);
        if (prop === "from" || prop === "into" || prop === "table") {
          const s = getStaticStringValue(arg0);
          if (s !== null) return cleanEntity(s);
        }
      }
      node = cal ?? null;
    } else if (node.type === "MemberExpression") {
      node = (node.object as AstNode) ?? null;
    } else {
      break;
    }
  }
  return null;
};

/**
 * Built-in global namespaces/constructors that are PascalCase but never an ORM
 * model — so `Object.create(...)`, `Array.from(...)`, `Promise.all(...)`,
 * `JSON.parse(...)`, `Buffer.from(...)` are never mistaken for a `Model.method()`
 * database call (a `create`/`from`/… method name would otherwise match).
 */
const NON_MODEL_GLOBALS = new Set<string>([
  "Object", "Array", "Buffer", "JSON", "Math", "Promise", "Date", "Number",
  "String", "Boolean", "Symbol", "Reflect", "Proxy", "RegExp", "Map", "Set",
  "WeakMap", "WeakSet", "Error", "TypeError", "RangeError", "SyntaxError",
  "BigInt", "Intl", "Atomics", "ArrayBuffer", "DataView", "Function", "Global",
  "globalThis", "process", "console",
]);

/** Does a receiver name look like an ORM model/repository handle (and not a JS global)? */
const REPO_SUFFIX_RE = /(Repository|Repo|Model)$/;
const isModelReceiver = (name: string): boolean =>
  !NON_MODEL_GLOBALS.has(name) && (/^[A-Z][a-z]/.test(name) || REPO_SUFFIX_RE.test(name));
const stripRepoSuffix = (name: string): string => name.replace(REPO_SUFFIX_RE, "") || name;

/**
 * The root receiver name of a builder chain: `db` for `db("x").a().b()`, `db.a().b()`,
 * and `knex("u").where().first()`; null when the chain roots at `this.x`, a literal,
 * or another non-identifier. Gates the Knex shape on a db-hint root so `Buffer.from(…)`
 * / `Array.from(…)` are never read as a table selector.
 */
const chainRootName = (call: AstNode): string | null => {
  let node: AstNode | null = call;
  let guard = 0;
  while (node && guard++ < 64) {
    if (node.type === "CallExpression") node = unwrapChain(node.callee as AstNode) ?? null;
    else if (node.type === "MemberExpression") node = (node.object as AstNode) ?? null;
    else if (node.type === "Identifier") return node.name as string;
    else return null;
  }
  return null;
};

/**
 * Recognized Knex / query-builder terminal methods → operation. A closed set (not
 * open-ended verb-prefix matching) so a non-query method chained on a db-hint
 * receiver — `db("config").setup()`, `db("s").destroyer()`, `db("e").removeListener()`
 * — is never classified as a write/delete.
 */
const KNEX_OP = new Map<string, DataOp>([
  ["insert", "write"], ["update", "write"], ["upsert", "write"], ["merge", "write"],
  ["increment", "write"], ["decrement", "write"],
  ["delete", "delete"], ["del", "delete"], ["truncate", "delete"],
  ["select", "read"], ["first", "read"], ["pluck", "read"], ["count", "read"],
  ["countDistinct", "read"], ["sum", "read"], ["avg", "read"], ["min", "read"],
  ["max", "read"], ["distinct", "read"],
]);

/**
 * Recognized TypeORM `getRepository(Entity).<method>()` methods → operation. A closed
 * set (not open-ended verb-prefix matching) so `createQueryBuilder` reads and, crucially,
 * a non-query method — `.setup()`, `.destroyer()`, `.removeListener()` — is never
 * classified as a write/delete on the entity. `createQueryBuilder` is a read: it almost
 * always builds a SELECT, and the entity is captured correctly regardless.
 */
const REPO_OP = new Map<string, DataOp>([
  ["find", "read"], ["findOne", "read"], ["findOneBy", "read"], ["findBy", "read"],
  ["findAndCount", "read"], ["findOneOrFail", "read"], ["findOneByOrFail", "read"],
  ["findByIds", "read"], ["count", "read"], ["countBy", "read"], ["exist", "read"],
  ["exists", "read"], ["existsBy", "read"], ["createQueryBuilder", "read"],
  ["stream", "read"],
  // `preload` READS the row and merges in memory — persisting needs a later `save`.
  ["preload", "read"],
  ["save", "write"], ["insert", "write"], ["update", "write"], ["upsert", "write"],
  ["increment", "write"], ["decrement", "write"], ["recover", "write"],
  ["delete", "delete"], ["remove", "delete"], ["softDelete", "delete"],
  ["softRemove", "delete"], ["restore", "write"], ["clear", "delete"],
]);

/**
 * True when a `.from(...)`/`.table(...)` scoping call sits in a builder chain that a
 * mutation method (`.update()`/`.delete()`/`.insert()`/…) terminates — walking UP the
 * enclosing member/call chain via attached parents. The scoping call's implicit READ is
 * then suppressed so `db.from("prices").where(...).update(...)` maps to `prices:write`
 * only, not `prices:read` + `prices:write`.
 */
const chainMutatesAfter = (scopingCall: AstNode): boolean => {
  let n = (scopingCall as { parent?: AstNode }).parent;
  let guard = 0;
  while (n && guard++ < 64 && (n.type === "MemberExpression" || n.type === "CallExpression")) {
    if (n.type === "CallExpression") {
      const m = getMethodName(n);
      const op = m ? KNEX_OP.get(m) : null;
      if (op === "write" || op === "delete") return true;
    }
    n = (n as { parent?: AstNode }).parent;
  }
  return false;
};

/** The result of classifying one call: a resolved entity, an unresolved query, or not-a-query. */
interface QueryTarget {
  /** The entity/table, or null when the call is a DB query whose target can't be resolved. */
  entity: string | null;
  op: DataOp;
}

/**
 * Classify a single CallExpression as a database query. Returns:
 *   - `{ entity, op }`   — a resolved query against a known entity;
 *   - `{ entity: null, op }` — recognizably a DB query, entity unresolvable;
 *   - `null`             — not database access at all.
 *
 * Patterns, in priority order (most specific first):
 *   1. Prisma      `<client>.<model>.<method>()`  — client segment a db hint,
 *                  method ∈ QUERY_METHODS → entity = the model segment, verbatim.
 *   2. TypeORM     `getRepository(User).find()` / `em.getRepository(User).save()`
 *                  → entity from the getRepository class argument.
 *   3. ORM model   `<Model>.<method>()` — PascalCase receiver, or one ending in
 *                  Repository/Repo/Model, method ∈ QUERY_METHODS → entity = the
 *                  receiver name (suffix stripped).
 *   4. Raw SQL     `db.query("…")` / `prisma.$queryRawUnsafe("…")` — parse the
 *                  static string; a dynamic string is an unresolved query.
 *   5. Knex        `db("orders").insert()` / `knex("u").where().first()` — table
 *                  from the chain, op from the terminal method.
 */
export const queryTarget = (call: AstNode): QueryTarget | null => {
  if (!call || call.type !== "CallExpression") return null;
  const calleeExpr = unwrapChain(call.callee as AstNode);
  if (!calleeExpr) return null;
  const method = getMethodName(call);
  if (!method) return null;
  const args = (call.arguments as AstNode[]) ?? [];

  // (1) Prisma: <client>.<model>.<method>()
  if (calleeExpr.type === "MemberExpression" && QUERY_METHODS.has(method)) {
    const receiverExpr = calleeExpr.object as AstNode;
    if (receiverExpr && receiverExpr.type === "MemberExpression") {
      const model = memberPropertyName(receiverExpr);
      const clientExpr = receiverExpr.object as AstNode;
      const clientPath = staticMemberPath(clientExpr) ?? rootObjectName(clientExpr);
      if (model && clientPath && isDbReceiver(clientPath)) {
        return { entity: model, op: methodOp(method) ?? "read" };
      }
    }
  }

  // (2) getRepository(User).method() / em.getRepository(User).method() — the method
  //     must be in the closed REPO_OP vocabulary, so a non-query method
  //     (`.setup()`, `.removeListener()`) never becomes a phantom write/delete, and
  //     `createQueryBuilder` classifies as the read it almost always is.
  if (calleeExpr.type === "MemberExpression") {
    const obj = unwrapChain(calleeExpr.object as AstNode);
    if (obj && obj.type === "CallExpression" && getMethodName(obj) === "getRepository") {
      // `.query(rawSql)` targets whatever table the SQL names — NOT the repository's
      // entity (`getRepository(User).query("DELETE FROM sessions …")` deletes
      // sessions, not User). Route it through the raw-SQL parser instead.
      if (method === "query") {
        const sql = staticSqlText(args[0]);
        if (sql !== null) {
          const parsed = parseSql(sql);
          if (parsed) return parsed;
        }
        return { entity: null, op: "read" };
      }
      const op = REPO_OP.get(method) ?? null;
      const arg0 = ((obj.arguments as AstNode[]) ?? [])[0];
      if (op && arg0 && arg0.type === "Identifier") {
        return { entity: arg0.name as string, op };
      }
    }
  }

  // (3) ORM model: <Model>.<method>() / <xRepository>.<method>()
  if (calleeExpr.type === "MemberExpression" && QUERY_METHODS.has(method)) {
    const receiverName = lastSegmentName(calleeExpr.object as AstNode);
    if (receiverName && isModelReceiver(receiverName)) {
      return { entity: stripRepoSuffix(receiverName), op: methodOp(method) ?? "read" };
    }
  }

  // (4) Raw SQL: db.query(...) / prisma.$queryRawUnsafe(...)
  if (isRawQueryCall(calleeExpr, method)) {
    const sql = staticSqlText(args[0]);
    if (sql !== null) {
      const parsed = parseSql(sql);
      if (parsed) return parsed;
    }
    // A DB query we cannot pin to a table (dynamic SQL, or SQL with no FROM/INTO).
    return { entity: null, op: "read" };
  }

  // (5) Knex / query-builder chain — only when the chain roots at a db-hint receiver
  //     (so `Buffer.from(…)` / `Array.from(…)` are never read as a table selector) and
  //     the method is a recognized builder op or scoping call (so `db("x").setup()` /
  //     `.removeListener()` on a db-hint receiver are not classified as writes/deletes).
  const root = chainRootName(call);
  if (root && isDbReceiver(root)) {
    let op: DataOp | null = KNEX_OP.get(method) ?? null;
    if (op === null && (method === "from" || method === "table")) {
      // A scoping call's implicit read is suppressed when a mutation method
      // terminates the same chain — `db.from("prices").where(…).update(…)` is
      // `prices:write` alone, not a phantom `prices:read` as well.
      if (chainMutatesAfter(call)) return null;
      op = "read";
    }
    if (op === null && method === "into") op = "write";
    if (op !== null) {
      const table = findKnexTable(call);
      if (table !== null) return { entity: table, op };
    }
  }

  return null;
};

/**
 * (entity, op) for Prisma's typed tagged-template raw API — `` prisma.$queryRaw`…` ``
 * and `` $executeRaw`…` ``. These are `TaggedTemplateExpression` nodes, not calls,
 * so the walk collects them separately and routes them here. Only the `$`-prefixed
 * raw methods are recognized (unambiguous Prisma APIs); a bare ``sql`…` `` tag is
 * left out deliberately to keep the map free of false database attributions. The
 * table is parsed from the template's static text exactly as the call form is.
 */
export const taggedTemplateTarget = (node: AstNode): QueryTarget | null => {
  const tag = node.tag as AstNode | undefined;
  if (!tag) return null;
  const method =
    tag.type === "Identifier"
      ? (tag.name as string)
      : tag.type === "MemberExpression"
        ? getMethodName(tag)
        : null;
  if (!method || !method.startsWith("$") || !RAW_METHODS.has(method)) return null;
  const sql = staticSqlText(node.quasi as AstNode | undefined);
  if (sql !== null) {
    const parsed = parseSql(sql);
    if (parsed) return parsed;
  }
  // A recognized raw tag whose table we could not pin (fully dynamic table).
  return { entity: null, op: "read" };
};

// ---------------------------------------------------------------------------
// Route-handler capture — the function node a route registers.
// ---------------------------------------------------------------------------

/**
 * A route whose handler function node we captured (method, path, line, node, file).
 * The node is what the forward walk starts from — a route table on its own is not
 * enough; we need the body to trace its data access.
 */
/** A route registration together with the function node it registers — shared
 *  with the OpenAPI generator (§77) so both commands agree on what a route is. */
export interface RouteHandler {
  method: string;
  path: string;
  normalizedFilePath: string;
  filePath: string;
  line: number;
  handler: AstNode;
}

/**
 * Does `fn` have a request-handler signature? Mirrors observability.ts: an
 * express/fastify `(req, res)` / `(request, reply)` shape, or a koa single `ctx`.
 * This is the gate that keeps a `cache.get("key", loader)` or `config.get("x",
 * () => 3000)` look-alike out of the route table — its callback is not
 * request-shaped.
 */
const looksLikeRouteHandler = (fn: AstNode): boolean => {
  if (looksLikeExpressHandler(fn)) return true;
  const params = (fn.params as AstNode[]) ?? [];
  if (params.length < 1 || params.length > 2) return false;
  const first = params[0];
  const name =
    first?.type === "Identifier"
      ? (first.name as string)
      : first?.type === "AssignmentPattern" && first.left?.type === "Identifier"
        ? (first.left.name as string)
        : null;
  return name === "ctx" || name === "context";
};

/**
 * Resolve a registration argument to the concrete handler function node, following
 * one level of wrapping/aliasing exactly as observability.ts does: a function
 * literal is the handler; a wrapper call `asyncHandler(fn)` descends into its
 * arguments; an array `[mw, handler]` takes its last function-ish element; a
 * same-file identifier resolves through the scope binding's initializer.
 */
const resolveHandlerFromArg = (arg: AstNode | null | undefined, scope: ScopeResolver): AstNode | null => {
  if (!arg) return null;
  if (isFunctionLike(arg)) return arg;
  if (arg.type === "CallExpression") {
    for (const inner of (arg.arguments as AstNode[]) ?? []) {
      const resolved = resolveHandlerFromArg(inner, scope);
      if (resolved) return resolved;
    }
    return null;
  }
  if (arg.type === "ArrayExpression") {
    const els = (arg.elements as (AstNode | null)[]) ?? [];
    for (let k = els.length - 1; k >= 0; k--) {
      const resolved = resolveHandlerFromArg(els[k], scope);
      if (resolved) return resolved;
    }
    return null;
  }
  if (arg.type === "Identifier") {
    const binding = scope.getBinding(arg.name as string, arg);
    if (binding && binding.initNode && isFunctionLike(binding.initNode)) return binding.initNode;
    return null;
  }
  return null;
};

/**
 * Collect a `{ handler, method, path, line }` for every route whose handler node we
 * can resolve in this module. Follows the same registration walk as
 * `extractRoutes` (verb calls + the Fastify `route({...})` object form) but
 * captures the handler FUNCTION NODE rather than a middleware-name chain — the node
 * is what we walk the call graph from.
 */
export const collectRouteHandlers = (
  program: AstNode,
  scope: ScopeResolver,
  normalizedFilePath: string,
  filePath: string,
  locate: (offset: number) => { line: number; column: number },
): RouteHandler[] => {
  const out: RouteHandler[] = [];

  const push = (node: AstNode, method: string, path: string, handler: AstNode): void => {
    out.push({
      method: method.toUpperCase() === "DEL" ? "DELETE" : method.toUpperCase(),
      path,
      normalizedFilePath,
      filePath,
      line: locate(typeof node.start === "number" ? node.start : 0).line,
      handler,
    });
  };

  for (const node of collectDescendants(program, (n) => n.type === "CallExpression", undefined, true)) {
    const method = getMethodName(node);
    if (!method) continue;
    const args = (node.arguments as AstNode[]) ?? [];

    // app.get("/path", ...middleware, handler)
    if (ROUTE_VERBS.has(method)) {
      const first = args[0];
      if (!first) continue;
      const literalPath = getStaticStringValue(first);
      if (literalPath === null && first.type !== "TemplateLiteral") continue;
      const rest = args.slice(1);
      if (rest.length === 0) continue;
      // The handler is the last function-ish argument; earlier ones are middleware.
      let handlerNode: AstNode | null = null;
      for (let k = rest.length - 1; k >= 0; k--) {
        const resolved = resolveHandlerFromArg(rest[k], scope);
        if (resolved) {
          handlerNode = resolved;
          break;
        }
      }
      if (!handlerNode || !looksLikeRouteHandler(handlerNode)) continue;
      push(node, method, literalPath ?? "<dynamic>", handlerNode);
      continue;
    }

    // fastify.route({ method, url, handler })
    if (method === "route") {
      const options = args[0];
      if (options?.type !== "ObjectExpression") continue;
      let verb = "ALL";
      let path = "<dynamic>";
      let handlerNode: AstNode | null = null;
      for (const prop of (options.properties as AstNode[]) ?? []) {
        if (prop.type !== "Property") continue;
        const key =
          prop.key?.type === "Identifier" ? (prop.key.name as string) : String(prop.key?.value ?? "");
        const value = prop.value as AstNode;
        if (key === "method") verb = getStaticStringValue(value) ?? "ALL";
        else if (key === "url" || key === "path") path = getStaticStringValue(value) ?? "<dynamic>";
        else if (key === "handler") handlerNode = resolveHandlerFromArg(value, scope);
      }
      if (handlerNode) push(node, verb, path, handlerNode);
    }
  }

  return out;
};

// ---------------------------------------------------------------------------
// Forward walk — the (entity, op) pairs reachable from one route.
// ---------------------------------------------------------------------------

/**
 * Depth and breadth bounds for the per-route forward walk. Six hops handler →
 * service → repository → … is deeper than realistic backends layer, and the
 * visited cap keeps a single route's traversal linear even in a densely connected
 * graph. Both are deliberately generous: exceeding them under-reports (drops far
 * edges) rather than lying.
 */
const MAX_DEPTH = 6;
const MAX_VISITED = 1000;

/**
 * The set of (entity, op) pairs a route reaches, as `"entity op"` keys.
 * Forward BFS over the call graph starting at the handler, exactly the walk shape
 * of interprocedural-taint: at each function we collect every CallExpression
 * (descending into inline callbacks, which run in request context), classify it
 * with `queryTarget`, and follow `graph.resolveCallee` into in-project functions
 * not yet visited. Unresolved DB queries are recorded by node in `unresolvedNodes`
 * (a project-wide set, so a shared helper's dynamic query is counted once).
 */
const reachableQueryTargets = (
  handler: AstNode,
  handlerFile: string,
  graph: ProjectGraph,
  fnFile: Map<AstNode, string>,
  unresolvedNodes: Set<AstNode>,
): Set<string> => {
  const pairs = new Set<string>();
  const visited = new Set<AstNode>([handler]);
  const queue: Array<{ fn: AstNode; file: string; depth: number }> = [
    { fn: handler, file: handlerFile, depth: 0 },
  ];
  let processed = 0;

  while (queue.length > 0) {
    const { fn, file, depth } = queue.shift()!;
    if (++processed > MAX_VISITED) break;

    const body = (fn.body as AstNode) ?? fn;
    const calls = collectDescendants(
      body,
      (n) => n.type === "CallExpression" || n.type === "TaggedTemplateExpression",
      undefined,
      true,
    );
    for (const call of calls) {
      const target =
        call.type === "TaggedTemplateExpression" ? taggedTemplateTarget(call) : queryTarget(call);
      if (target) {
        if (target.entity !== null) pairs.add(`${target.entity} ${target.op}`);
        else unresolvedNodes.add(call);
      }
      // Only call expressions carry a resolvable in-project callee to follow.
      if (call.type === "CallExpression" && depth < MAX_DEPTH) {
        const callee = graph.resolveCallee(call, file);
        if (callee && !visited.has(callee)) {
          visited.add(callee);
          const calleeFile = fnFile.get(callee);
          if (calleeFile) queue.push({ fn: callee, file: calleeFile, depth: depth + 1 });
        }
      }
    }
  }

  return pairs;
};

// ---------------------------------------------------------------------------
// Assembly + deterministic ordering.
// ---------------------------------------------------------------------------

const OP_RANK: Record<DataOp, number> = { read: 0, write: 1, delete: 2 };
const sortOps = (ops: Iterable<DataOp>): DataOp[] => [...new Set(ops)].sort((a, b) => OP_RANK[a] - OP_RANK[b]);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Build the Data Access Map for a directory tree: glob + parse every source file,
 * build the project call graph, capture each route's handler node, walk the graph
 * forward from each route to the entities it touches, and invert the result into
 * the entity → routes index.
 */
export const buildDataAccessMap = async (
  rootDirectory: string,
  options?: { config?: NodeDoctorConfig },
): Promise<DataAccessMap> => {
  const config = options?.config ?? {};
  const fg = (await import("fast-glob")).default;
  const files = (
    await fg([SOURCE_GLOB], {
      cwd: rootDirectory,
      ignore: [...BUILTIN_IGNORES, ...(config.ignore ?? [])],
      absolute: true,
      followSymbolicLinks: false,
      suppressErrors: true,
    })
  ).sort();

  // Phase A: parse each file once, collecting both the graph facts and the route
  // handler nodes from the SAME parsed program, so node identity is shared with
  // the graph's `resolveCallee`. mapPool preserves input (sorted) order.
  const perModule = (
    await mapPool(files, 8, async (filePath) => {
      let sourceText: string;
      try {
        sourceText = await readFile(filePath, "utf8");
      } catch {
        return null;
      }
      const parsed = parseSource(filePath, sourceText);
      if (parsed.parseFailed) return null;
      const program = parsed.program;
      attachParents(program);
      const scope = resolveScopes(program);
      const handlers = collectRequestHandlers(program, scope);
      const normalizedFilePath = relative(rootDirectory, filePath).split(sep).join("/");
      const facts = collectModuleFacts(filePath, normalizedFilePath, program, scope, handlers);
      const routeHandlers = collectRouteHandlers(
        program,
        scope,
        normalizedFilePath,
        filePath,
        createLocator(sourceText),
      );
      return { facts, routeHandlers };
    })
  ).filter((m): m is NonNullable<typeof m> => m !== null);

  const graph = buildProjectGraph(perModule.map((m) => m.facts));

  // Function node → its file, for resolving calls inside a reached callee.
  const fnFile = new Map<AstNode, string>();
  for (const facts of graph.modules.values()) {
    walk(facts.program, {
      enter: (node) => {
        if (isFunctionLike(node)) fnFile.set(node, facts.filePath);
      },
    });
  }

  // Phase B: forward-walk from every route handler.
  const unresolvedNodes = new Set<AstNode>();
  const routes: RouteAccess[] = [];
  for (const m of perModule) {
    for (const rh of m.routeHandlers) {
      const pairs = reachableQueryTargets(rh.handler, rh.filePath, graph, fnFile, unresolvedNodes);

      // Group ops by entity for this route.
      const byEntity = new Map<string, Set<DataOp>>();
      for (const key of pairs) {
        const sep2 = key.indexOf(" ");
        const entity = key.slice(0, sep2);
        const op = key.slice(sep2 + 1) as DataOp;
        const set = byEntity.get(entity) ?? new Set<DataOp>();
        set.add(op);
        byEntity.set(entity, set);
      }
      const entities = [...byEntity.entries()]
        .map(([entity, ops]) => ({ entity, ops: sortOps(ops) }))
        .sort((a, b) => cmp(a.entity, b.entity));

      routes.push({
        method: rh.method,
        path: rh.path,
        normalizedFilePath: rh.normalizedFilePath,
        line: rh.line,
        entities,
      });
    }
  }

  // Deterministic route order: file, line, method, path.
  routes.sort(
    (a, b) =>
      cmp(a.normalizedFilePath, b.normalizedFilePath) ||
      a.line - b.line ||
      cmp(a.method, b.method) ||
      cmp(a.path, b.path),
  );

  // Invert into the entity → routes index.
  const entityIndex = new Map<string, { ops: Set<DataOp>; routes: Map<string, { method: string; path: string }> }>();
  for (const r of routes) {
    for (const e of r.entities) {
      const rec = entityIndex.get(e.entity) ?? { ops: new Set<DataOp>(), routes: new Map() };
      for (const op of e.ops) rec.ops.add(op);
      rec.routes.set(`${r.method} ${r.path}`, { method: r.method, path: r.path });
      entityIndex.set(e.entity, rec);
    }
  }
  const entities: EntityAccess[] = [...entityIndex.entries()]
    .map(([entity, rec]) => ({
      entity,
      ops: sortOps(rec.ops),
      routes: [...rec.routes.values()].sort((a, b) => cmp(a.method, b.method) || cmp(a.path, b.path)),
    }))
    .sort((a, b) => cmp(a.entity, b.entity));

  return {
    routes,
    entities,
    summary: { routes: routes.length, entities: entities.length, unresolvedQueries: unresolvedNodes.size },
  };
};
