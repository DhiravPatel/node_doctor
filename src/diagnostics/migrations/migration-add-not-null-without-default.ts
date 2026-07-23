import { defineTextDiagnostic } from "../../core/text-scan.ts";
import { MIGRATION_FILE_GLOBS, analyzeMigration, clauseEnd, normalizeIdentifier, positionOf, splitStatements } from "./context.ts";

/**
 * `ALTER TABLE … ADD COLUMN … NOT NULL` with no `DEFAULT`.
 *
 * Against an empty table this works, which is why it survives code review and
 * CI: the test database has no rows. Against production it fails outright —
 * Postgres and MySQL both refuse to add a NOT NULL column to a table that
 * already has rows and cannot say what those rows should contain. The deploy
 * dies halfway through the migration, leaving the schema in a state neither the
 * old nor the new application version expects. Even where a DEFAULT is supplied,
 * older engines rewrite the whole table under an ACCESS EXCLUSIVE lock.
 *
 * Silent on `CREATE TABLE` (a brand-new table has no rows, so NOT NULL is
 * correct and normal there), and on any statement that supplies a DEFAULT or a
 * generated/serial value.
 *
 * ❌ ALTER TABLE users ADD COLUMN tenant_id uuid NOT NULL;
 * ✅ ALTER TABLE users ADD COLUMN tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';
 * ✅ CREATE TABLE users (id bigserial PRIMARY KEY, tenant_id uuid NOT NULL);
 */

const IS_ALTER_TABLE_RE = /^\s*ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?([^\s(;]+)/i;
const ADD_COLUMN_RE = /\bADD\s+COLUMN\b\s*(?:IF\s+NOT\s+EXISTS\b\s*)?([^\s;(,]*)/gi;
const NOT_NULL_RE = /\bNOT\s+NULL\b/i;
const DEFAULT_RE = /\bDEFAULT\b/i;
/** A column whose value the engine supplies itself never needs a DEFAULT. */
const SELF_POPULATING_RE = /\b(?:SERIAL|BIGSERIAL|SMALLSERIAL|GENERATED)\b/i;

export const migrationAddNotNullWithoutDefault = defineTextDiagnostic({
  id: "migration-add-not-null-without-default",
  title: "Migration adds a NOT NULL column with no DEFAULT",
  severity: "error",
  category: "Reliability",
  confidence: "high",
  tags: ["migration", "database", "deploy"],
  files: MIGRATION_FILE_GLOBS,
  maxBytes: 512 * 1024,
  recommendation:
    "Split it into three deploys: add the column nullable (or with a cheap constant DEFAULT), backfill in bounded batches, then add the NOT NULL constraint — on Postgres 12+ as a NOT VALID CHECK followed by VALIDATE CONSTRAINT so no long ACCESS EXCLUSIVE lock is taken.",
  scan: (ctx) => {
    const file = analyzeMigration(ctx.normalizedFilePath, ctx.content);
    if (!file) return;

    for (const unit of file.units) {
      for (const stmt of splitStatements(unit.text)) {
        const alter = IS_ALTER_TABLE_RE.exec(stmt.text);
        if (!alter) continue; // CREATE TABLE and everything else is out of scope
        // A DEFAULT anywhere in the reconstructed statement means the intent is
        // already handled; statements span lines, so this is the whole point of
        // rebuilding up to the `;` before deciding.
        if (DEFAULT_RE.test(stmt.text)) continue;
        const table = normalizeIdentifier(alter[1]!);

        const re = new RegExp(ADD_COLUMN_RE.source, ADD_COLUMN_RE.flags);
        let m: RegExpExecArray | null;
        while ((m = re.exec(stmt.text)) !== null) {
          const clause = stmt.text.slice(m.index, clauseEnd(stmt.text, m.index));
          if (!NOT_NULL_RE.test(clause)) continue;
          if (SELF_POPULATING_RE.test(clause)) continue;
          const column = normalizeIdentifier(m[1] ?? "");
          const { line, column: col } = positionOf(file.lineStarts, unit.base + stmt.start + m.index);
          ctx.report({
            line,
            column: col,
            message: `Adds NOT NULL column ${column ? `\`${table}.${column}\`` : `to \`${table}\``} with no DEFAULT — this fails outright on any table that already has rows, and the deploy stops mid-migration.`,
          });
        }
      }
    }
  },
});
