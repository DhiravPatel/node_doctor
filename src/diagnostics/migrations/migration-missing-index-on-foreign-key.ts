import { defineTextDiagnostic } from "../../core/text-scan.ts";
import {
  MIGRATION_FILE_GLOBS,
  analyzeMigration,
  inRegions,
  matchParen,
  normalizeIdentifier,
  positionOf,
  splitStatements,
  splitTopLevel,
} from "./context.ts";

/**
 * A foreign-key column declared without a matching index in the same migration.
 *
 * Postgres (and SQLite) index the *referenced* side automatically but never the
 * *referencing* side. So `orders.customer_id REFERENCES customers(id)` gives you
 * a sequential scan on every join, and — the part that actually pages people —
 * every `DELETE FROM customers` has to scan `orders` in full to enforce the
 * constraint, which is fine on the developer's 200-row table and a lock-holding
 * outage on the production one.
 *
 * Ships **opt-in** (`defaultEnabled: false`). The index may legitimately live in
 * a later migration, or in the ORM's schema file, so its absence *here* is weak
 * evidence — real, but not strong enough to be on by default. MySQL/InnoDB
 * creates the index itself, so files that read as MySQL are skipped entirely.
 *
 * ❌ CREATE TABLE orders (customer_id bigint REFERENCES customers(id));
 * ✅ CREATE TABLE orders (customer_id bigint REFERENCES customers(id));
 *    CREATE INDEX orders_customer_id_idx ON orders (customer_id);
 * ✅ CREATE TABLE orders (customer_id bigint PRIMARY KEY REFERENCES customers(id));
 */

/** InnoDB creates the referencing-side index itself, so this check does not apply. */
const MYSQL_MARKER_RE = /\bENGINE\s*=|\bAUTO_INCREMENT\b|`/;

const CREATE_TABLE_RE =
  /\bCREATE\s+(?:GLOBAL\s+|LOCAL\s+)?(TEMP\s+|TEMPORARY\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(;]+)\s*\(/i;
const ALTER_TABLE_RE = /^\s*ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?([^\s(;]+)/i;
const CREATE_INDEX_RE =
  /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:(?!ON\b)\S+\s+)?ON\s+(?:ONLY\s+)?([^\s(]+)\s*(?:USING\s+\w+\s*)?\(/i;

const IDENT_HEAD_RE = /^\s*("(?:[^"]|"")*"|\[[^\]]*\]|[A-Za-z_][\w$]*)/;
const CONSTRAINT_PREFIX_RE = /^\s*CONSTRAINT\s+(?:"(?:[^"]|"")*"|[A-Za-z_][\w$]*)\s+/i;
/** Table-level constraint keywords — anything starting with one is not a column definition. */
const TABLE_CONSTRAINT_RE = /^\s*(?:PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK|EXCLUDE|LIKE|INDEX|KEY|PERIOD)\b/i;

interface ForeignKey {
  table: string;
  column: string;
  offset: number;
}

/** Split a parenthesised column list and return the first column, normalized. */
const leadingColumn = (list: string): string => {
  const first = splitTopLevel(list)[0];
  if (first === undefined) return "";
  const head = IDENT_HEAD_RE.exec(first);
  return head ? normalizeIdentifier(head[1]!) : "";
};

/** Parts of `text` from `from`, split on top-level commas, with absolute-ish offsets. */
const topLevelParts = (text: string, from: number): Array<{ text: string; start: number }> => {
  const parts: Array<{ text: string; start: number }> = [];
  let start = from;
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i]!;
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      parts.push({ text: text.slice(start, i), start });
      start = i + 1;
    }
  }
  parts.push({ text: text.slice(start), start });
  return parts.filter((p) => p.text.trim().length > 0);
};

export const migrationMissingIndexOnForeignKey = defineTextDiagnostic({
  id: "migration-missing-index-on-foreign-key",
  title: "Foreign key column has no index in this migration",
  severity: "warn",
  category: "Performance",
  confidence: "low",
  defaultEnabled: false,
  tags: ["migration", "database", "index"],
  files: MIGRATION_FILE_GLOBS,
  maxBytes: 512 * 1024,
  recommendation:
    "Create an index on the referencing column in the same migration (`CREATE INDEX CONCURRENTLY … ON child (parent_id)` on Postgres, so no long write lock is taken). If the index already exists in another migration or is declared on the ORM model, no change is needed.",
  scan: (ctx) => {
    const file = analyzeMigration(ctx.normalizedFilePath, ctx.content);
    if (!file) return;
    if (MYSQL_MARKER_RE.test(ctx.content)) return;

    const foreignKeys: ForeignKey[] = [];
    /** `table::leading_column` for every index this migration creates or implies. */
    const indexed = new Set<string>();

    const addIndex = (table: string, column: string): void => {
      if (table && column) indexed.add(`${table}::${column}`);
    };

    for (const unit of file.units) {
      for (const stmt of splitStatements(unit.text)) {
        const abs = (index: number): number => unit.base + stmt.start + index;
        if (inRegions(file.downRegions, abs(0))) continue;

        const create = CREATE_TABLE_RE.exec(stmt.text);
        if (create && !create[1]) {
          const table = normalizeIdentifier(create[2]!);
          const open = stmt.text.indexOf("(", create.index + create[0].length - 1);
          const close = open === -1 ? -1 : matchParen(stmt.text, open);
          if (close !== -1) {
            for (const item of topLevelParts(stmt.text.slice(open + 1, close), 0)) {
              const body = item.text.replace(CONSTRAINT_PREFIX_RE, "");
              const offset = abs(open + 1 + item.start);
              if (TABLE_CONSTRAINT_RE.test(body)) {
                const fk = /^\s*FOREIGN\s+KEY\s*\(([^)]*)\)/i.exec(body);
                if (fk) {
                  const column = leadingColumn(fk[1]!);
                  if (column) foreignKeys.push({ table, column, offset });
                  continue;
                }
                const idx = /^\s*(?:PRIMARY\s+KEY|UNIQUE(?:\s+(?:INDEX|KEY))?|INDEX|KEY)\s*(?:\S+\s*)?\(([^)]*)\)/i.exec(body);
                if (idx) addIndex(table, leadingColumn(idx[1]!));
                continue;
              }
              const head = IDENT_HEAD_RE.exec(body);
              if (!head) continue;
              const column = normalizeIdentifier(head[1]!);
              const rest = body.slice(head[0].length);
              if (/\b(?:PRIMARY\s+KEY|UNIQUE)\b/i.test(rest)) addIndex(table, column);
              if (/\bREFERENCES\b/i.test(rest)) foreignKeys.push({ table, column, offset });
            }
          }
        }

        const index = CREATE_INDEX_RE.exec(stmt.text);
        if (index) {
          const open = stmt.text.indexOf("(", index.index + index[0].length - 1);
          const close = open === -1 ? -1 : matchParen(stmt.text, open);
          if (close !== -1) addIndex(normalizeIdentifier(index[1]!), leadingColumn(stmt.text.slice(open + 1, close)));
        }

        const alter = ALTER_TABLE_RE.exec(stmt.text);
        if (alter) {
          const table = normalizeIdentifier(alter[1]!);
          for (const part of topLevelParts(stmt.text, alter.index + alter[0].length)) {
            // Only ADD clauses matter here; DROP/ALTER COLUMN/RENAME are other diagnostics' business.
            const add = /^\s*ADD\s+/i.exec(part.text);
            if (!add) continue;
            const body = part.text.slice(add[0].length).replace(CONSTRAINT_PREFIX_RE, "");
            const fk = /^\s*FOREIGN\s+KEY\s*\(([^)]*)\)/i.exec(body);
            if (fk) {
              const column = leadingColumn(fk[1]!);
              if (column) foreignKeys.push({ table, column, offset: abs(part.start) });
              continue;
            }
            const idx = /^\s*(?:PRIMARY\s+KEY|UNIQUE(?:\s+(?:INDEX|KEY))?|INDEX|KEY)\s*(?:\S+\s*)?\(([^)]*)\)/i.exec(body);
            if (idx) {
              addIndex(table, leadingColumn(idx[1]!));
              continue;
            }
            const column = /^\s*(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?/i.exec(body);
            const after = body.slice(column ? column[0].length : 0);
            const head = IDENT_HEAD_RE.exec(after);
            if (!head) continue;
            const name = normalizeIdentifier(head[1]!);
            const rest = after.slice(head[0].length);
            if (/\b(?:PRIMARY\s+KEY|UNIQUE)\b/i.test(rest)) addIndex(table, name);
            if (/\bREFERENCES\b/i.test(rest)) foreignKeys.push({ table, column: name, offset: abs(part.start) });
          }
        }
      }
    }

    const reported = new Set<string>();
    for (const fk of foreignKeys) {
      const key = `${fk.table}::${fk.column}`;
      if (indexed.has(key) || reported.has(key)) continue;
      reported.add(key);
      const { line, column } = positionOf(file.lineStarts, fk.offset);
      ctx.report({
        line,
        column,
        message: `Foreign key column \`${fk.table}.${fk.column}\` has no index in this migration — Postgres does not index the referencing side, so joins and cascading deletes on the parent scan the whole table.`,
      });
    }
  },
});
