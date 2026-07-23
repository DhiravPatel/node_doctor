import { defineTextDiagnostic } from "../../core/text-scan.ts";
import {
  MIGRATION_FILE_GLOBS,
  analyzeMigration,
  inRegions,
  normalizeIdentifier,
  positionOf,
  splitStatements,
} from "./context.ts";

/**
 * A migration that drops a table, drops a column, or truncates — outside a
 * down/rollback path.
 *
 * The failure mode is not that dropping is wrong; it is that dropping is
 * *irreversible against production data* and the rollback path usually does not
 * exist. The migration runs in the deploy pipeline, the data is gone before
 * anyone reads the diff, and the down migration — if there is one — can recreate
 * the empty table but never the rows. Dropping should be a deliberate, reviewed
 * decision, so this fires exactly once per destructive statement and stays
 * silent everywhere the intent is already explicit.
 *
 * Silent on: anything inside a down/rollback section (that is a down migration's
 * whole purpose), DROP INDEX (rebuildable from the schema), and temp/scratch
 * tables the same migration created.
 *
 * ❌ ALTER TABLE users DROP COLUMN legacy_email;
 * ✅ -- Down
 *    DROP TABLE IF EXISTS users;
 * ✅ CREATE TEMP TABLE tmp_backfill (...); DROP TABLE tmp_backfill;
 * ✅ DROP INDEX idx_users_email;
 */

/** `DROP TABLE` but never `DROP TABLESPACE`; the temp keyword is captured to gate on. */
const DROP_TABLE_RE = /\bDROP\s+(?:(TEMP|TEMPORARY|UNLOGGED)\s+)?TABLE\b\s*(?:IF\s+EXISTS\b\s*)?([^\s;(,]*)/gi;
/** Only the explicit `DROP COLUMN` form — MySQL's bare `DROP col` is ambiguous with DROP CONSTRAINT. */
const DROP_COLUMN_RE = /\bDROP\s+COLUMN\b\s*(?:IF\s+EXISTS\b\s*)?([^\s;(,]*)/gi;
const TRUNCATE_RE = /\bTRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?([^\s;(,]*)/gi;
const CREATE_TABLE_RE =
  /\bCREATE\s+(?:GLOBAL\s+|LOCAL\s+)?(?:TEMP\s+|TEMPORARY\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(;]+)/gi;
const ALTER_TABLE_RE = /^\s*ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?([^\s(;]+)/i;

/** Names that read as scratch storage rather than a durable table. */
const SCRATCH_NAME_RE = /^(?:tmp|temp)[_.]|_(?:tmp|temp)$|^pg_temp\b/i;

const builderLabel: Record<string, string> = {
  dropTable: "drops a table",
  dropTableIfExists: "drops a table",
  dropSchema: "drops a schema",
  dropSchemaIfExists: "drops a schema",
  dropColumn: "drops a column",
  dropColumns: "drops columns",
  truncate: "truncates a table",
};

export const migrationDestructiveWithoutGuard = defineTextDiagnostic({
  id: "migration-destructive-without-guard",
  title: "Destructive migration outside a rollback path",
  severity: "error",
  category: "Reliability",
  confidence: "high",
  tags: ["migration", "database", "data-loss"],
  files: MIGRATION_FILE_GLOBS,
  maxBytes: 512 * 1024,
  recommendation:
    "Split the destructive step into its own reviewed migration and stage it: stop writing the column in application code, deploy, verify nothing reads it, then drop it. Keep a restorable copy (a dated backup or a renamed table) until the drop is confirmed safe, and make sure the down migration can actually recreate what it removed.",
  scan: (ctx) => {
    const file = analyzeMigration(ctx.normalizedFilePath, ctx.content);
    if (!file) return;

    // Tables this migration creates itself are scratch space: dropping them
    // destroys nothing that existed before the migration ran.
    const createdHere = new Set<string>();
    for (const unit of file.units) {
      const re = new RegExp(CREATE_TABLE_RE.source, CREATE_TABLE_RE.flags);
      let m: RegExpExecArray | null;
      while ((m = re.exec(unit.text)) !== null) createdHere.add(normalizeIdentifier(m[1]!));
    }

    const report = (offset: number, message: string): void => {
      if (inRegions(file.downRegions, offset)) return;
      const { line, column } = positionOf(file.lineStarts, offset);
      ctx.report({ line, column, message });
    };

    const isScratch = (name: string): boolean =>
      name.length === 0 ? false : SCRATCH_NAME_RE.test(name) || createdHere.has(name);

    for (const unit of file.units) {
      for (const stmt of splitStatements(unit.text)) {
        const at = (index: number): number => unit.base + stmt.start + index;

        const dropTable = new RegExp(DROP_TABLE_RE.source, DROP_TABLE_RE.flags);
        let m: RegExpExecArray | null;
        while ((m = dropTable.exec(stmt.text)) !== null) {
          if (m[1]) continue; // explicitly TEMP/TEMPORARY/UNLOGGED
          const name = normalizeIdentifier(m[2] ?? "");
          if (isScratch(name)) continue;
          report(
            at(m.index),
            `Migration drops table ${name ? `\`${name}\`` : "(name not statically known)"} outside a down/rollback section — the rows are unrecoverable once this deploys.`,
          );
        }

        const truncate = new RegExp(TRUNCATE_RE.source, TRUNCATE_RE.flags);
        while ((m = truncate.exec(stmt.text)) !== null) {
          const name = normalizeIdentifier(m[1] ?? "");
          if (isScratch(name)) continue;
          report(
            at(m.index),
            `Migration truncates table ${name ? `\`${name}\`` : "(name not statically known)"} outside a down/rollback section — every row is deleted with no rollback path.`,
          );
        }

        const alter = ALTER_TABLE_RE.exec(stmt.text);
        const target = alter ? normalizeIdentifier(alter[1]!) : "";
        // Dropping a column from a table this migration just created is a no-op
        // against production data.
        if (target.length > 0 && createdHere.has(target)) continue;
        const dropColumn = new RegExp(DROP_COLUMN_RE.source, DROP_COLUMN_RE.flags);
        while ((m = dropColumn.exec(stmt.text)) !== null) {
          const name = normalizeIdentifier(m[1] ?? "");
          const label = target && name ? `\`${target}.${name}\`` : name ? `\`${name}\`` : "(name not statically known)";
          report(
            at(m.index),
            `Migration drops column ${label} outside a down/rollback section — the values are unrecoverable once this deploys.`,
          );
        }
      }
    }

    for (const call of file.builderCalls) {
      const label = builderLabel[call.name];
      if (!label) continue;
      report(
        call.offset,
        `Migration ${label} via \`${call.name}()\` outside a down/rollback section — the data is unrecoverable once this deploys.`,
      );
    }
  },
});
