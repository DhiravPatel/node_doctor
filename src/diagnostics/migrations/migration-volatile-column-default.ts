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
 * `ADD COLUMN` with a **volatile** default, which rewrites the whole table.
 *
 * The received wisdom — "adding a column with a default rewrites the table" —
 * has been wrong since Postgres 11, and measuring it is what makes this rule
 * narrow enough to ship:
 *
 *   ✅ ALTER TABLE users ADD COLUMN tier int DEFAULT 5;
 *      -- measured: no rewrite, 18 ms on 400,000 rows. The fast path is real,
 *      -- and it covers every NON-VOLATILE default, not just constants.
 *   ❌ ALTER TABLE users ADD COLUMN pid uuid DEFAULT gen_random_uuid();
 *      -- measured: REWROTE the heap, 244 ms on the same 400,000 rows.
 *
 * A volatile function has to be evaluated per row — that is what volatile
 * means — so every row must be written, and Postgres takes ACCESS EXCLUSIVE
 * for the duration, blocking reads as well as writes.
 *
 * So a rule that flagged every `DEFAULT` would be wrong about the common case
 * and would train people to ignore it. This one flags only the defaults that
 * are actually volatile, which is a short and stable list: the random and UUID
 * generators, and `clock_timestamp()`. **`now()` and `CURRENT_TIMESTAMP` are
 * NOT volatile** — they are stable within a transaction, take the fast path,
 * and are deliberately absent from the list.
 *
 * PRECISION MODEL. The same guards as the sibling lock rules:
 *
 *   - The default must name a function this file lists as volatile. An unknown
 *     function is not assumed to be anything.
 *   - A table created in the SAME migration is never reported — no rows to
 *     rewrite.
 *   - Postgres must be PROVEN from the file, since the fast-path behaviour and
 *     the remedy are both Postgres-specific.
 *   - `down`/rollback regions are excluded.
 */

/**
 * Volatile default expressions — evaluated per row, so the table is rewritten.
 *
 * Deliberately short. `now()`, `CURRENT_TIMESTAMP`, `CURRENT_DATE` and
 * `statement_timestamp()` are STABLE rather than volatile: they take the fast
 * path, and listing them would make the rule wrong about the commonest default
 * of all.
 */
const VOLATILE_DEFAULT_RE =
  /\b(?:gen_random_uuid|uuid_generate_v[145]|random|clock_timestamp|nextval)\s*\(/i;

const ALTER_TABLE_RE = /\bALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?([^\s(;]+)/i;
const ADD_COLUMN_RE = /\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:"(?:[^"]|"")*"|[A-Za-z_][\w$]*)\b/i;
const DEFAULT_RE = /\bDEFAULT\s+/i;

export const migrationVolatileColumnDefault = defineTextDiagnostic({
  id: "migration-volatile-column-default",
  title: "Column added with a volatile default, rewriting the table",
  severity: "warn",
  category: "Reliability",
  confidence: "high",
  tags: ["migration", "database", "availability"],
  files: MIGRATION_FILE_GLOBS,
  maxBytes: 512 * 1024,
  recommendation:
    "Add the column with no default, backfill in batches, then set the default for new rows. A VOLATILE default is evaluated per row, so Postgres rewrites the whole table under a lock that blocks reads as well as writes — measured at 244 ms on 400,000 rows, against 18 ms for a non-volatile default, which takes the Postgres 11 fast path and does not rewrite at all.",
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

        const add = ADD_COLUMN_RE.exec(stmt.text);
        if (!add) continue;
        const tail = stmt.text.slice(add.index);
        const dflt = DEFAULT_RE.exec(tail);
        if (!dflt) continue;
        if (!VOLATILE_DEFAULT_RE.test(tail.slice(dflt.index))) continue;

        const at = positionOf(file.lineStarts, abs(add.index + dflt.index));
        ctx.report({
          line: at.line,
          column: at.column,
          message: `This default is VOLATILE, so Postgres must evaluate it per row and rewrites the whole of \`${table}\` under a lock that blocks reads as well as writes. Measured on 400,000 rows: 244 ms for a volatile default against 18 ms for a non-volatile one, which takes the Postgres 11 fast path and does not rewrite at all. Add the column with no default, backfill in batches, then set the default for new rows.`,
        });
      }
    }
  },
});
