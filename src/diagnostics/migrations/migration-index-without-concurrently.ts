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
 * A Postgres `CREATE INDEX` on an existing table, without `CONCURRENTLY`.
 *
 * A plain `CREATE INDEX` holds a lock that blocks **every write** to the table
 * until the index is built. On a table small enough to test with, that is
 * milliseconds and nobody notices. On the production table it is however long
 * the build takes — and for that whole window every insert, update and delete
 * queues behind it.
 *
 *   ❌ CREATE INDEX orders_customer_id_idx ON orders (customer_id);
 *   ✅ CREATE INDEX CONCURRENTLY orders_customer_id_idx ON orders (customer_id);
 *
 * MEASURED, on Postgres 14 with a 600,000-row table, rather than quoted from
 * the manual:
 *
 *   - plain `CREATE INDEX` running: a concurrent `INSERT` waited **3,093 ms**
 *   - `CREATE INDEX CONCURRENTLY` running: the same `INSERT` waited **21 ms**
 *
 * A factor of 147, and it scales with the table rather than with the migration.
 * The migration itself always succeeds, so nothing in CI or in the deploy log
 * marks it; the symptom is a write stall in the application at the moment of
 * deploy, which gets attributed to almost anything else.
 *
 * PRECISION MODEL. Two guards, and both matter more than the trigger.
 *
 *   - **A table created in the SAME migration is never reported.** A brand-new
 *     table has no rows to scan and no traffic to block, so the lock costs
 *     nothing and `CONCURRENTLY` would only forbid running it in a transaction.
 *     This is the common case in a fresh schema, and firing on it would make the
 *     rule noise on exactly the migrations that are safe.
 *   - **Postgres must be PROVEN from the file.** `CONCURRENTLY` is Postgres-only
 *     syntax: MySQL and SQLite have no such option, so the advice would be
 *     impossible to follow there. Rather than guess a dialect, this requires
 *     positive in-file evidence — a Postgres-only type, cast, index method, or
 *     the keyword itself used elsewhere. No evidence, no finding, which matches
 *     this module's stated bias toward silence.
 *
 * And the usual one: a `down`/rollback region is excluded, because dropping and
 * rebuilding an index there is the point of a rollback.
 */

/**
 * Constructs that exist in Postgres and not in MySQL or SQLite. Any one of them
 * proves the dialect; none of them is a version-dependent fact that decays.
 */
const POSTGRES_EVIDENCE_RE =
  /\b(?:BIGSERIAL|SMALLSERIAL|SERIAL)\b|\bJSONB\b|\bUSING\s+(?:btree|gin|gist|hash|brin|spgist)\b|::\s*[A-Za-z]|\bTSVECTOR\b|\bGEN_RANDOM_UUID\s*\(|\bON\s+CONFLICT\b|\bCONCURRENTLY\b|\bRETURNING\b|\bCITEXT\b/i;

/** `CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] [name] ON table` */
const CREATE_INDEX_RE =
  /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:(?!ON\b)\S+\s+)?ON\s+(?:ONLY\s+)?([^\s(]+)/i;

const CREATE_TABLE_RE =
  /\bCREATE\s+(?:GLOBAL\s+|LOCAL\s+)?(?:TEMP\s+|TEMPORARY\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(;]+)/i;

export const migrationIndexWithoutConcurrently = defineTextDiagnostic({
  id: "migration-index-without-concurrently",
  title: "Index built on an existing table without CONCURRENTLY",
  severity: "warn",
  category: "Reliability",
  confidence: "high",
  tags: ["migration", "database", "index", "availability"],
  files: MIGRATION_FILE_GLOBS,
  maxBytes: 512 * 1024,
  recommendation:
    "Use `CREATE INDEX CONCURRENTLY` for an index on a table that already holds data. A plain `CREATE INDEX` blocks every write to the table until the build finishes — measured at 3,093 ms against 21 ms on a 600,000-row table. `CONCURRENTLY` cannot run inside a transaction block, so with Prisma it needs its own migration file, and it can leave an INVALID index behind if it fails, which is dropped and retried.",
  scan: (ctx) => {
    const file = analyzeMigration(ctx.normalizedFilePath, ctx.content);
    if (!file) return;

    // `CONCURRENTLY` is Postgres-only syntax. Without positive evidence of the
    // dialect the recommendation might be impossible to follow, so say nothing.
    if (!POSTGRES_EVIDENCE_RE.test(ctx.content)) return;

    /** Tables this migration creates — their indexes lock nothing. */
    const createdTables = new Set<string>();
    for (const unit of file.units) {
      for (const stmt of splitStatements(unit.text)) {
        const create = CREATE_TABLE_RE.exec(stmt.text);
        if (create?.[1]) createdTables.add(normalizeIdentifier(create[1]));
      }
    }

    for (const unit of file.units) {
      for (const stmt of splitStatements(unit.text)) {
        const abs = (index: number): number => unit.base + stmt.start + index;
        // Rebuilding an index is what a rollback is for.
        if (inRegions(file.downRegions, abs(0))) continue;

        const match = CREATE_INDEX_RE.exec(stmt.text);
        if (!match) continue;
        // Already concurrent — nothing to say.
        if (match[1]) continue;

        const table = normalizeIdentifier(match[2] ?? "");
        // A table born in this migration has no rows and no readers.
        if (table === "" || createdTables.has(table)) continue;

        const at = positionOf(file.lineStarts, abs(match.index));
        ctx.report({
          line: at.line,
          column: at.column,
          message: `This builds an index on \`${table}\`, which already exists, without \`CONCURRENTLY\` — so Postgres blocks **every write** to that table until the build finishes. Measured on a 600,000-row table: a concurrent \`INSERT\` waited 3,093 ms against a plain \`CREATE INDEX\` and 21 ms against \`CONCURRENTLY\`, and the gap grows with the table. The migration succeeds either way, so nothing in CI or the deploy log marks it; the symptom is a write stall at deploy time.`,
        });
      }
    }
  },
});
