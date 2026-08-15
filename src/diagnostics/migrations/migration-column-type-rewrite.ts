import { defineTextDiagnostic } from "../../core/text-scan.ts";
import {
  MIGRATION_FILE_GLOBS,
  POSTGRES_EVIDENCE_RE,
  analyzeMigration,
  createdTablesIn,
  inRegions,
  normalizeIdentifier,
  positionOf,
  splitStatements,
} from "./context.ts";

/**
 * `ALTER COLUMN … TYPE` to a target that always rewrites the table.
 *
 * This is the heaviest of the migration locks: `ACCESS EXCLUSIVE`, which blocks
 * **reads** as well as writes — where `CREATE INDEX` only blocks writes — held
 * for the whole heap rewrite.
 *
 *   ❌ ALTER TABLE events ALTER COLUMN id TYPE bigint;
 *      -- measured on 2.4M rows: lock held 2,464 ms, a concurrent indexed
 *      -- SELECT blocked 2,400 ms against a 2.08 ms baseline, 401 MB of WAL
 *   ✅ add a new column, backfill in batches, dual-write, then swap
 *
 * WHY THE TARGET LIST IS SHORT, AND WHY THAT IS THE WHOLE RULE. Most type
 * changes are free, and **the statement text cannot tell you which**. Measured,
 * two 400,000-row tables given the byte-identical statement
 * `ALTER COLUMN c TYPE varchar(100)`:
 *
 *   - the column was `varchar(50)` → no rewrite, 19 ms
 *   - the column was `text`        → REWROTE, 144 ms
 *
 * Same bytes on the page, opposite cost, decided entirely by the column's
 * CURRENT type — which a migration file does not contain. So every target that
 * carries a length or precision is excluded: `varchar(n)`, `numeric(p,s)`,
 * `timestamp(p)`, `bit(n)`. Widening one of those is the commonest
 * `ALTER COLUMN TYPE` in real migrations and it is free.
 *
 * What remains are targets carrying no modifier, where the only free source is
 * the type itself or its own alias — `bigint`, `smallint`, `double precision`,
 * `real`, `uuid`, `boolean`, `date`, `jsonb`. Three near-misses are excluded by
 * name because a measured free path exists into them: `integer` (free from
 * `oid`), `inet` (free from `cidr`), and `timestamptz` (free from `timestamp`,
 * but only when the session timezone is UTC — decided by a runtime GUC that is
 * not in the file under any analysis).
 *
 * PRECISION MODEL, beyond the target list:
 *
 *   - A table created in the SAME migration is never reported. Measured: the
 *     same `int -> bigint` took 1.4 ms on a table with no rows.
 *   - Postgres must be PROVEN from the file: MySQL 8 permits concurrent DML
 *     during an in-place ALTER, so the claim is Postgres-specific.
 *   - `down`/rollback regions are excluded.
 *
 * The residual is a no-op restatement — `TYPE bigint` on a column already
 * `bigint`, measured free. The rule takes the statement's own assertion that
 * the type is changing, exactly as the sibling rule takes `CREATE INDEX ON
 * orders` at its word that `orders` exists and holds rows.
 */

/**
 * Targets carrying no type modifier, where the only free source is the type
 * itself. Enumerated by sweeping every base type as a source and diffing
 * `pg_relation_filenode`, not from the manual.
 *
 * `integer`, `inet` and `timestamptz` are deliberately ABSENT: each has a
 * measured free path in (`oid`, `cidr`, and UTC-session `timestamp`).
 */
const ALWAYS_REWRITES = new Set([
  "bigint",
  "int8",
  "smallint",
  "int2",
  "double precision",
  "float8",
  "real",
  "float4",
  "uuid",
  "boolean",
  "bool",
  "date",
  "jsonb",
]);

const ALTER_TABLE_RE = /\bALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?([^\s(;]+)/i;
/** `ALTER [COLUMN] <name> [SET DATA] TYPE <target>` */
const ALTER_TYPE_RE =
  /\bALTER\s+(?:COLUMN\s+)?("(?:[^"]|"")*"|[A-Za-z_][\w$]*)\s+(?:SET\s+DATA\s+)?TYPE\s+([A-Za-z][\w ]*?)\s*(?:\(|USING\b|COLLATE\b|,|;|$)/i;

export const migrationColumnTypeRewrite = defineTextDiagnostic({
  id: "migration-column-type-rewrite",
  title: "Column type change that rewrites the table under an exclusive lock",
  severity: "warn",
  category: "Reliability",
  confidence: "high",
  tags: ["migration", "database", "availability"],
  files: MIGRATION_FILE_GLOBS,
  maxBytes: 512 * 1024,
  recommendation:
    "There is no concurrent form of this statement. Add a new column of the target type, backfill it in batches, dual-write, then swap — the same multi-deploy split the NOT NULL rule recommends. An in-place change takes ACCESS EXCLUSIVE, which blocks reads as well as writes, for the whole rewrite: measured at 2,464 ms on a 2.4M-row table, with 401 MB of WAL from the one statement.",
  scan: (ctx) => {
    const file = analyzeMigration(ctx.normalizedFilePath, ctx.content);
    if (!file) return;
    if (!POSTGRES_EVIDENCE_RE.test(ctx.content)) return;

    const createdTables = createdTablesIn(file);

    for (const unit of file.units) {
      for (const stmt of splitStatements(unit.text)) {
        const abs = (index: number): number => unit.base + stmt.start + index;
        if (inRegions(file.downRegions, abs(0))) continue;

        const alter = ALTER_TABLE_RE.exec(stmt.text);
        if (!alter || stmt.text.slice(0, alter.index).trim() !== "") continue;
        const table = normalizeIdentifier(alter[1] ?? "");
        if (table === "" || createdTables.has(table)) continue;

        const change = ALTER_TYPE_RE.exec(stmt.text);
        if (!change) continue;
        const target = (change[2] ?? "").trim().toLowerCase().replace(/\s+/g, " ");
        // A target carrying a modifier — `varchar(100)`, `numeric(12,2)` — is
        // free or not depending on the CURRENT type, which is not in this file.
        if (!ALWAYS_REWRITES.has(target)) continue;

        const at = positionOf(file.lineStarts, abs(change.index));
        ctx.report({
          line: at.line,
          column: at.column,
          message: `Changing a column of \`${table}\` to \`${target}\` rewrites the whole heap under \`ACCESS EXCLUSIVE\` — which blocks **reads** as well as writes, unlike \`CREATE INDEX\`. Measured on a 2.4M-row table: the lock was held 2,464 ms, a concurrent indexed \`SELECT\` waited 2,400 ms against a 2.08 ms baseline, and the one statement emitted 401 MB of WAL. There is no concurrent form; add a new column, backfill in batches, dual-write, then swap.`,
        });
      }
    }
  },
});
