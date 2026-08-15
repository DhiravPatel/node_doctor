/**
 * §15 — `migration-index-without-concurrently`.
 *
 * A plain `CREATE INDEX` holds a lock that blocks every write to the table until
 * the build finishes. MEASURED on Postgres 14 with a 600,000-row table rather
 * than quoted from the manual:
 *
 *   - plain `CREATE INDEX` running: a concurrent INSERT waited 3,093 ms
 *   - `CREATE INDEX CONCURRENTLY` running: the same INSERT waited 21 ms
 *
 * The migration succeeds either way, so nothing in CI marks it; the symptom is a
 * write stall at deploy time.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { migrationIndexWithoutConcurrently } from "../../src/diagnostics/migrations/migration-index-without-concurrently.ts";

const scan = (sql: string, path = "prisma/migrations/20240101_x/migration.sql") => {
  const found: Array<{ line: number; message: string }> = [];
  migrationIndexWithoutConcurrently.scan({
    filePath: `/repo/${path}`,
    normalizedFilePath: path,
    content: sql,
    committed: true,
    report: (f) => found.push({ line: f.line, message: f.message }),
  });
  return found;
};

/** A statement that proves the dialect without creating the indexed table. */
const PG = "CREATE TABLE seed (id BIGSERIAL PRIMARY KEY);\n";

const fires = (sql: string) => {
  const found = scan(sql);
  assert.ok(found.length > 0, `expected a FIRE on:\n${sql}`);
  return found;
};
const silent = (sql: string): void =>
  assert.equal(scan(sql).length, 0, `expected SILENCE on:\n${sql}`);

describe("migration-index-without-concurrently — fires", () => {
  test("an index on a table that already exists, with the measurement in the message", () => {
    const [f] = fires(`${PG}CREATE INDEX orders_cid_idx ON orders (customer_id);`);
    assert.match(f!.message, /blocks \*\*every write\*\*/);
    assert.match(f!.message, /3,093 ms/);
    assert.match(f!.message, /21 ms/);
    assert.match(f!.message, /`orders`/);
  });

  test("every spelling of the statement", () => {
    fires(`${PG}CREATE UNIQUE INDEX u ON orders (email);`);
    fires(`${PG}CREATE INDEX IF NOT EXISTS i ON orders (a);`);
    fires(`${PG}CREATE INDEX i ON ONLY orders (a);`);
  });

  test("any Postgres-only construct is enough to prove the dialect", () => {
    fires(`ALTER TABLE orders ADD COLUMN meta JSONB;\nCREATE INDEX i ON orders (a);`);
    fires(`CREATE INDEX i ON orders USING gin (tags);`);
    fires(`UPDATE orders SET n = n::int;\nCREATE INDEX i ON orders (a);`);
  });
});

describe("migration-index-without-concurrently — silent", () => {
  test("`CONCURRENTLY` is the fix", () => {
    silent(`${PG}CREATE INDEX CONCURRENTLY orders_cid_idx ON orders (customer_id);`);
    silent(`${PG}CREATE UNIQUE INDEX CONCURRENTLY u ON orders (email);`);
  });

  test("a table created in the SAME migration has no rows to lock", () => {
    // The common case in a fresh schema. Firing here would make the rule noise
    // on exactly the migrations that are safe — and `CONCURRENTLY` would only
    // forbid running them in a transaction.
    silent(`CREATE TABLE orders (id BIGSERIAL PRIMARY KEY, customer_id int);\nCREATE INDEX orders_cid_idx ON orders (customer_id);`);
  });

  test("Postgres must be PROVEN, because the advice is unfollowable elsewhere", () => {
    // MySQL and SQLite have no `CONCURRENTLY`.
    silent(`CREATE INDEX orders_cid_idx ON orders (customer_id);`);
    silent("CREATE TABLE t (id INT AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB;\nCREATE INDEX i ON orders (a);");
  });

  test("a commented-out statement is not a statement", () => {
    silent(`${PG}-- CREATE INDEX i ON orders (a);`);
  });

  test("a file that is not a migration", () => {
    assert.deepEqual(scan(`${PG}CREATE INDEX i ON orders (a);`, "src/db/queries.sql"), []);
  });
});

describe("migration-index-without-concurrently — determinism", () => {
  test("identical input yields identical output", () => {
    const sql = `${PG}CREATE INDEX a ON orders (x);\nCREATE INDEX b ON users (y);`;
    assert.equal(JSON.stringify(scan(sql)), JSON.stringify(scan(sql)));
    assert.equal(scan(sql).length, 2);
  });
});
