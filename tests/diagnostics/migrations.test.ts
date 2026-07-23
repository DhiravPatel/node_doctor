import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runTextScan } from "../../src/core/text-scan.ts";
import { MIGRATION_DIAGNOSTICS } from "../../src/diagnostics/migrations/index.ts";
import type { NodeDoctorConfig } from "../../src/core/config.ts";

/** Run the migration diagnostics over a single fabricated file. */
const scan = async (name: string, content: string, config?: NodeDoctorConfig): Promise<string[]> => {
  const dir = await mkdtemp(join(tmpdir(), "nd-mig-"));
  try {
    const full = join(dir, name);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
    const findings = await runTextScan(dir, { textDiagnostics: MIGRATION_DIAGNOSTICS, config });
    return findings.map((f) => f.diagnostic).sort();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** The FK check is opt-in, so it needs an explicit enable. */
const FK_ON: NodeDoctorConfig = { diagnostics: { "migration-missing-index-on-foreign-key": "warn" } };
const DESTRUCTIVE = "migration-destructive-without-guard";
const NOT_NULL = "migration-add-not-null-without-default";
const FK = "migration-missing-index-on-foreign-key";

describe("migration-destructive-without-guard", () => {
  test("fires on DROP TABLE in an up migration", async () => {
    assert.deepEqual(await scan("migrations/001_x.sql", "DROP TABLE users;\n"), [DESTRUCTIVE]);
  });

  test("fires on ALTER TABLE … DROP COLUMN", async () => {
    assert.deepEqual(await scan("migrations/001_x.sql", "ALTER TABLE users DROP COLUMN legacy_email;\n"), [DESTRUCTIVE]);
  });

  test("fires on TRUNCATE", async () => {
    assert.deepEqual(await scan("migrations/001_x.sql", "TRUNCATE TABLE audit_log;\n"), [DESTRUCTIVE]);
  });

  test("SILENT on DROP TABLE IF EXISTS inside a down section", async () => {
    const sql = [
      "-- +migrate Up",
      "CREATE TABLE sessions (id uuid PRIMARY KEY);",
      "",
      "-- +migrate Down",
      "DROP TABLE IF EXISTS sessions;",
      "",
    ].join("\n");
    assert.deepEqual(await scan("migrations/001_x.sql", sql), []);
  });

  test("SILENT on a bare `-- Down` marker section", async () => {
    const sql = "-- Up\nCREATE TABLE a (id int);\n-- Down\nDROP TABLE a;\nTRUNCATE b;\nALTER TABLE c DROP COLUMN d;\n";
    assert.deepEqual(await scan("migrations/001_x.sql", sql), []);
  });

  test("still fires when the up section follows a down section", async () => {
    const sql = "-- Down\nDROP TABLE a;\n-- Up\nDROP TABLE b;\n";
    assert.deepEqual(await scan("migrations/001_x.sql", sql), [DESTRUCTIVE]);
  });

  test("SILENT on a `.down.sql` file", async () => {
    assert.deepEqual(await scan("migrations/001_x.down.sql", "DROP TABLE users;\n"), []);
  });

  test("SILENT on DROP INDEX", async () => {
    assert.deepEqual(await scan("migrations/001_x.sql", "DROP INDEX CONCURRENTLY idx_users_email;\n"), []);
  });

  test("SILENT on DROP TABLESPACE (not a table)", async () => {
    assert.deepEqual(await scan("migrations/001_x.sql", "DROP TABLESPACE archive;\n"), []);
  });

  test("SILENT on an explicit temp table", async () => {
    assert.deepEqual(await scan("migrations/001_x.sql", "DROP TEMPORARY TABLE scratch;\n"), []);
  });

  test("SILENT on a tmp_-prefixed scratch table", async () => {
    assert.deepEqual(await scan("migrations/001_x.sql", "DROP TABLE tmp_backfill;\n"), []);
  });

  test("SILENT on a table the same migration created", async () => {
    const sql = "CREATE TABLE backfill_scratch (id int);\nDROP TABLE backfill_scratch;\n";
    assert.deepEqual(await scan("migrations/001_x.sql", sql), []);
  });

  test("SILENT on commented-out SQL (line and block comments)", async () => {
    const sql = "-- DROP TABLE users;\n/* TRUNCATE audit_log;\n   ALTER TABLE t DROP COLUMN c; */\n";
    assert.deepEqual(await scan("migrations/001_x.sql", sql), []);
  });

  test("SILENT on DROP inside a dollar-quoted function body", async () => {
    const sql = "CREATE FUNCTION f() RETURNS void AS $$ BEGIN DROP TABLE users; END $$ LANGUAGE plpgsql;\n";
    assert.deepEqual(await scan("migrations/001_x.sql", sql), []);
  });

  test("SILENT on a literal string that merely mentions the keywords", async () => {
    const sql = "INSERT INTO notes (body) VALUES ('remember to DROP TABLE users later');\n";
    assert.deepEqual(await scan("migrations/001_x.sql", sql), []);
  });

  test("fires on a knex dropColumn in up()", async () => {
    const js = [
      "exports.up = async function (knex) {",
      "  await knex.schema.alterTable('users', (t) => t.dropColumn('legacy_email'));",
      "};",
      "exports.down = async function (knex) {",
      "  await knex.schema.alterTable('users', (t) => t.string('legacy_email'));",
      "};",
      "",
    ].join("\n");
    assert.deepEqual(await scan("migrations/20240101_x.js", js), [DESTRUCTIVE]);
  });

  test("SILENT on a knex dropTableIfExists inside down()", async () => {
    const js = [
      "exports.up = async function (knex) {",
      "  await knex.schema.createTable('sessions', (t) => t.uuid('id').primary());",
      "};",
      "exports.down = async function (knex) {",
      "  await knex.schema.dropTableIfExists('sessions');",
      "};",
      "",
    ].join("\n");
    assert.deepEqual(await scan("migrations/20240101_x.js", js), []);
  });

  test("SILENT on a TypeORM down() method", async () => {
    const ts = [
      "import type { MigrationInterface, QueryRunner } from 'typeorm';",
      "export class AddSessions1700000000000 implements MigrationInterface {",
      "  public async up(queryRunner: QueryRunner): Promise<void> {",
      "    await queryRunner.query(`CREATE TABLE sessions (id uuid PRIMARY KEY)`);",
      "  }",
      "  public async down(queryRunner: QueryRunner): Promise<void> {",
      "    await queryRunner.query(`DROP TABLE sessions`);",
      "  }",
      "}",
      "",
    ].join("\n");
    assert.deepEqual(await scan("migrations/1700000000000-AddSessions.ts", ts), []);
  });

  test("fires on raw SQL in a TypeORM up() method", async () => {
    const ts = [
      "import type { MigrationInterface, QueryRunner } from 'typeorm';",
      "export class DropLegacy1700000000001 implements MigrationInterface {",
      "  public async up(queryRunner: QueryRunner): Promise<void> {",
      "    await queryRunner.query(`ALTER TABLE users DROP COLUMN legacy_email`);",
      "  }",
      "  public async down(queryRunner: QueryRunner): Promise<void> {}",
      "}",
      "",
    ].join("\n");
    assert.deepEqual(await scan("migrations/1700000000001-DropLegacy.ts", ts), [DESTRUCTIVE]);
  });

  test("SILENT on a commented-out drop in a JS migration", async () => {
    const js = [
      "exports.up = async function (knex) {",
      "  // await knex.schema.dropTable('users');",
      "  await knex.schema.createTable('t', (t) => t.increments());",
      "};",
      "exports.down = async function (knex) {};",
      "",
    ].join("\n");
    assert.deepEqual(await scan("migrations/20240101_x.js", js), []);
  });

  test("SILENT on a migration runner that has no up()", async () => {
    const ts = "export const run = async (db) => { await db.query('DROP TABLE users'); };\n";
    assert.deepEqual(await scan("src/db/migrate/runner.ts", ts), []);
  });

  test("SILENT on an ordinary source file outside a migrations directory", async () => {
    assert.deepEqual(await scan("src/db/cleanup.sql", "DROP TABLE users;\n"), []);
  });
});

describe("migration-add-not-null-without-default", () => {
  test("fires on ADD COLUMN … NOT NULL with no DEFAULT", async () => {
    assert.deepEqual(await scan("migrations/002_x.sql", "ALTER TABLE users ADD COLUMN tenant_id uuid NOT NULL;\n"), [
      NOT_NULL,
    ]);
  });

  test("SILENT when a DEFAULT is present", async () => {
    const sql = "ALTER TABLE users ADD COLUMN active boolean NOT NULL DEFAULT true;\n";
    assert.deepEqual(await scan("migrations/002_x.sql", sql), []);
  });

  test("SILENT when the DEFAULT is on a later line of the same statement", async () => {
    const sql = ["ALTER TABLE users", "  ADD COLUMN active boolean", "  NOT NULL", "  DEFAULT true;", ""].join("\n");
    assert.deepEqual(await scan("migrations/002_x.sql", sql), []);
  });

  test("fires on a multi-line statement with no DEFAULT anywhere", async () => {
    const sql = ["ALTER TABLE users", "  ADD COLUMN tenant_id uuid", "  NOT NULL;", ""].join("\n");
    assert.deepEqual(await scan("migrations/002_x.sql", sql), [NOT_NULL]);
  });

  test("SILENT on CREATE TABLE with NOT NULL columns", async () => {
    const sql = [
      "CREATE TABLE users (",
      "  id bigserial PRIMARY KEY,",
      "  email text NOT NULL,",
      "  created_at timestamptz NOT NULL",
      ");",
      "",
    ].join("\n");
    assert.deepEqual(await scan("migrations/002_x.sql", sql), []);
  });

  test("SILENT on ADD COLUMN with no NOT NULL", async () => {
    assert.deepEqual(await scan("migrations/002_x.sql", "ALTER TABLE users ADD COLUMN nickname text;\n"), []);
  });

  test("SILENT on IF NOT EXISTS — that is not a NOT NULL", async () => {
    assert.deepEqual(await scan("migrations/002_x.sql", "ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname text;\n"), []);
  });

  test("SILENT on a generated column", async () => {
    const sql = "ALTER TABLE users ADD COLUMN slug text GENERATED ALWAYS AS (lower(name)) STORED NOT NULL;\n";
    assert.deepEqual(await scan("migrations/002_x.sql", sql), []);
  });

  test("SILENT on commented-out SQL", async () => {
    assert.deepEqual(await scan("migrations/002_x.sql", "-- ALTER TABLE users ADD COLUMN t uuid NOT NULL;\n"), []);
  });

  test("a numeric type modifier does not end the clause", async () => {
    const sql = "ALTER TABLE invoices ADD COLUMN amount numeric(12,2) NOT NULL;\n";
    assert.deepEqual(await scan("migrations/002_x.sql", sql), [NOT_NULL]);
  });

  test("only the clause missing a DEFAULT is judged, per statement", async () => {
    const sql = "ALTER TABLE users ADD COLUMN a text NOT NULL, ADD COLUMN b text NOT NULL DEFAULT '';\n";
    // A DEFAULT anywhere in the statement silences it — deliberately the safer side.
    assert.deepEqual(await scan("migrations/002_x.sql", sql), []);
  });

  test("fires inside a Prisma migration.sql", async () => {
    const sql = 'ALTER TABLE "User" ADD COLUMN "tenantId" TEXT NOT NULL;\n';
    assert.deepEqual(await scan("prisma/migrations/20240101_add_tenant/migration.sql", sql), [NOT_NULL]);
  });
});

describe("migration-missing-index-on-foreign-key", () => {
  test("is opt-in — silent by default", async () => {
    const sql = "CREATE TABLE orders (id bigserial PRIMARY KEY, customer_id bigint REFERENCES customers(id));\n";
    assert.deepEqual(await scan("migrations/003_x.sql", sql), []);
  });

  test("fires when enabled and no index exists", async () => {
    const sql = "CREATE TABLE orders (id bigserial PRIMARY KEY, customer_id bigint REFERENCES customers(id));\n";
    assert.deepEqual(await scan("migrations/003_x.sql", sql, FK_ON), [FK]);
  });

  test("SILENT when the migration creates the index", async () => {
    const sql = [
      "CREATE TABLE orders (id bigserial PRIMARY KEY, customer_id bigint REFERENCES customers(id));",
      "CREATE INDEX orders_customer_id_idx ON orders (customer_id);",
      "",
    ].join("\n");
    assert.deepEqual(await scan("migrations/003_x.sql", sql, FK_ON), []);
  });

  test("SILENT when the FK column is the primary key", async () => {
    const sql = "CREATE TABLE profiles (user_id bigint PRIMARY KEY REFERENCES users(id));\n";
    assert.deepEqual(await scan("migrations/003_x.sql", sql, FK_ON), []);
  });

  test("SILENT when a UNIQUE table constraint covers the column", async () => {
    const sql = [
      "CREATE TABLE memberships (",
      "  user_id bigint REFERENCES users(id),",
      "  team_id bigint,",
      "  UNIQUE (user_id, team_id)",
      ");",
      "",
    ].join("\n");
    assert.deepEqual(await scan("migrations/003_x.sql", sql, FK_ON), []);
  });

  test("fires on a table-level FOREIGN KEY constraint with no index", async () => {
    const sql = [
      "CREATE TABLE orders (",
      "  id bigserial PRIMARY KEY,",
      "  customer_id bigint,",
      "  CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id)",
      ");",
      "",
    ].join("\n");
    assert.deepEqual(await scan("migrations/003_x.sql", sql, FK_ON), [FK]);
  });

  test("SILENT on MySQL-flavoured SQL — InnoDB indexes the referencing side itself", async () => {
    const sql = [
      "CREATE TABLE orders (",
      "  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,",
      "  customer_id BIGINT,",
      "  FOREIGN KEY (customer_id) REFERENCES customers (id)",
      ") ENGINE=InnoDB;",
      "",
    ].join("\n");
    assert.deepEqual(await scan("migrations/003_x.sql", sql, FK_ON), []);
  });

  test("SILENT inside a down section", async () => {
    const sql = "-- Down\nCREATE TABLE orders (customer_id bigint REFERENCES customers(id));\n";
    assert.deepEqual(await scan("migrations/003_x.sql", sql, FK_ON), []);
  });

  test("fires on ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY", async () => {
    const sql = "ALTER TABLE orders ADD CONSTRAINT fk_c FOREIGN KEY (customer_id) REFERENCES customers (id);\n";
    assert.deepEqual(await scan("migrations/003_x.sql", sql, FK_ON), [FK]);
  });

  test("SILENT when a later ALTER adds a unique constraint on the same column", async () => {
    const sql = [
      "ALTER TABLE orders ADD CONSTRAINT fk_c FOREIGN KEY (customer_id) REFERENCES customers (id);",
      "ALTER TABLE orders ADD CONSTRAINT uq_c UNIQUE (customer_id);",
      "",
    ].join("\n");
    assert.deepEqual(await scan("migrations/003_x.sql", sql, FK_ON), []);
  });

  test("reports each FK column once, not once per statement", async () => {
    const sql = [
      "CREATE TABLE orders (customer_id bigint REFERENCES customers(id));",
      "CREATE TABLE orders_archive (customer_id bigint REFERENCES customers(id));",
      "",
    ].join("\n");
    assert.deepEqual(await scan("migrations/003_x.sql", sql, FK_ON), [FK, FK]);
  });

  test("SILENT on commented-out SQL", async () => {
    const sql = "-- CREATE TABLE orders (customer_id bigint REFERENCES customers(id));\n";
    assert.deepEqual(await scan("migrations/003_x.sql", sql, FK_ON), []);
  });
});

describe("determinism", () => {
  test("identical input yields byte-identical findings", async () => {
    const sql = [
      "ALTER TABLE users ADD COLUMN tenant_id uuid NOT NULL;",
      "ALTER TABLE users DROP COLUMN legacy_email;",
      "CREATE TABLE orders (customer_id bigint REFERENCES customers(id));",
      "",
    ].join("\n");
    const a = await scan("migrations/004_x.sql", sql, FK_ON);
    const b = await scan("migrations/004_x.sql", sql, FK_ON);
    assert.deepEqual(a, b);
    assert.deepEqual(a, [NOT_NULL, DESTRUCTIVE, FK].sort());
  });
});
