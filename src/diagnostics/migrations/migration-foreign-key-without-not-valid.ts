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
 * A foreign key added to an existing table without `NOT VALID`.
 *
 * Postgres validates every existing row before it will mark the constraint
 * valid, and it holds a write-blocking lock for the whole scan — **on both
 * tables**:
 *
 *   ❌ ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (customer_id)
 *        REFERENCES customers(id);
 *   ✅ ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (customer_id)
 *        REFERENCES customers(id) NOT VALID;
 *      -- then, in its own migration, once the deploy has settled:
 *      ALTER TABLE orders VALIDATE CONSTRAINT fk;
 *
 * MEASURED on Postgres 14, a 600,000-row child against a 200,000-row parent:
 * an `INSERT` into **`customers`** — the parent, a table the statement never
 * names as its target — waited **2,065 ms**.
 *
 * That is the part nobody expects. A migration that reads as "touch the orders
 * table" stalls every write to customers as well, and customers is usually the
 * busier of the two. `NOT VALID` splits it: the `ADD CONSTRAINT` becomes a
 * catalog-only change, and the later `VALIDATE CONSTRAINT` does the same scan
 * under a much weaker lock that does not block writes.
 *
 * The migration always succeeds, so nothing in CI or the deploy log marks it.
 * The symptom is a write stall on two tables at deploy time.
 *
 * PRECISION MODEL. The same two guards as the sibling lock rules, for the same
 * measured reasons:
 *
 *   - A table created in the SAME migration is never reported — no rows to
 *     validate, so the scan costs nothing.
 *   - Postgres must be PROVEN from the file. `NOT VALID` is Postgres-only
 *     syntax; on MySQL or SQLite the recommendation cannot be followed.
 *   - A foreign key declared INSIDE `CREATE TABLE` is not matched at all: the
 *     table is new by construction.
 *   - `down`/rollback regions are excluded.
 */

/** `ALTER TABLE <child> … ADD CONSTRAINT … FOREIGN KEY … REFERENCES <parent>` */
const ALTER_TABLE_RE = /\bALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?([^\s(;]+)/i;
const ADD_FOREIGN_KEY_RE = /\bADD\s+(?:CONSTRAINT\s+(?:"(?:[^"]|"")*"|[A-Za-z_][\w$]*)\s+)?FOREIGN\s+KEY\s*\(/i;
const REFERENCES_RE = /\bREFERENCES\s+([^\s(;]+)/i;
const NOT_VALID_RE = /\bNOT\s+VALID\b/i;

export const migrationForeignKeyWithoutNotValid = defineTextDiagnostic({
  id: "migration-foreign-key-without-not-valid",
  title: "Foreign key added to an existing table without NOT VALID",
  severity: "warn",
  category: "Reliability",
  confidence: "high",
  tags: ["migration", "database", "availability"],
  files: MIGRATION_FILE_GLOBS,
  maxBytes: 512 * 1024,
  recommendation:
    "Add the constraint `NOT VALID` first — a catalog-only change — then run `ALTER TABLE … VALIDATE CONSTRAINT …` in a later migration, where the same scan happens under a lock that does not block writes. Validating inline blocks writes to BOTH tables for the length of the scan: measured at 2,065 ms on the referenced parent, which the statement never names.",
  scan: (ctx) => {
    const file = analyzeMigration(ctx.normalizedFilePath, ctx.content);
    if (!file) return;
    // `NOT VALID` is Postgres-only; elsewhere the fix is unavailable.
    if (!POSTGRES_EVIDENCE_RE.test(ctx.content)) return;

    const createdTables = createdTablesIn(file);

    for (const unit of file.units) {
      for (const stmt of splitStatements(unit.text)) {
        const abs = (index: number): number => unit.base + stmt.start + index;
        if (inRegions(file.downRegions, abs(0))) continue;

        // Only ALTER TABLE. A key declared inside CREATE TABLE is on a new table.
        const alter = ALTER_TABLE_RE.exec(stmt.text);
        if (!alter || alter.index !== 0) {
          // `ALTER TABLE` may be preceded by whitespace only.
          if (!alter || stmt.text.slice(0, alter.index).trim() !== "") continue;
        }
        const add = ADD_FOREIGN_KEY_RE.exec(stmt.text);
        if (!add) continue;
        if (NOT_VALID_RE.test(stmt.text)) continue;

        const child = normalizeIdentifier(alter[1] ?? "");
        if (child === "" || createdTables.has(child)) continue;

        const parentMatch = REFERENCES_RE.exec(stmt.text.slice(add.index));
        const parent = parentMatch ? normalizeIdentifier(parentMatch[1] ?? "") : "";
        // A parent born in this migration holds no rows either.
        const parentPhrase =
          parent === "" || createdTables.has(parent) ? "the referenced table" : `\`${parent}\``;

        const at = positionOf(file.lineStarts, abs(add.index));
        ctx.report({
          line: at.line,
          column: at.column,
          message: `This validates the new foreign key against every existing row in \`${child}\`, and holds a write-blocking lock on ${parentPhrase} as well as on \`${child}\` for the whole scan. The parent is the part nobody expects — measured on Postgres 14, an \`INSERT\` into the referenced table waited **2,065 ms**, and that table is never named as the statement's target. Add it \`NOT VALID\`, then \`VALIDATE CONSTRAINT\` in a later migration under a lock that does not block writes.`,
        });
      }
    }
  },
});
