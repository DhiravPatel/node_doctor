/**
 * §15 — three migration lock hazards, each measured against a live Postgres 14
 * rather than quoted from the manual.
 *
 * The measurements are what make each rule narrow enough to ship, and in two
 * cases they contradict the received wisdom — so they are pinned here as the
 * reasons for the silences, not just the triggers.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { migrationForeignKeyWithoutNotValid } from "../../src/diagnostics/migrations/migration-foreign-key-without-not-valid.ts";
import { migrationVolatileColumnDefault } from "../../src/diagnostics/migrations/migration-volatile-column-default.ts";
import { migrationColumnTypeRewrite } from "../../src/diagnostics/migrations/migration-column-type-rewrite.ts";

const scan = (rule: { scan: (c: never) => void }, sql: string, path = "prisma/migrations/20240101_x/migration.sql") => {
  const found: Array<{ line: number; message: string }> = [];
  rule.scan({
    filePath: `/repo/${path}`,
    normalizedFilePath: path,
    content: sql,
    committed: true,
    report: (f: { line: number; message: string }) => found.push(f),
  } as never);
  return found;
};

/** Proves the dialect without creating the table under test. */
const PG = "CREATE TABLE seed (id BIGSERIAL PRIMARY KEY);\n";

describe("foreign key without NOT VALID", () => {
  const fires = (sql: string) => {
    const f = scan(migrationForeignKeyWithoutNotValid, sql);
    assert.ok(f.length > 0, `expected a FIRE on:\n${sql}`);
    return f;
  };
  const silent = (sql: string) =>
    assert.equal(scan(migrationForeignKeyWithoutNotValid, sql).length, 0, `expected SILENCE on:\n${sql}`);

  test("the PARENT is the part nobody expects, and the message says so", () => {
    const [f] = fires(`${PG}ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (customer_id) REFERENCES customers(id);`);
    // Measured: an INSERT into `customers` — never named as the target — waited
    // 2,065 ms while the constraint validated.
    assert.match(f!.message, /2,065 ms/);
    assert.match(f!.message, /`customers`/);
    assert.match(f!.message, /never named as the statement's target/);
  });

  test("`NOT VALID` is the fix", () => {
    silent(`${PG}ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (customer_id) REFERENCES customers(id) NOT VALID;`);
  });

  test("a child born in this migration has no rows to validate", () => {
    silent(
      `CREATE TABLE orders (id BIGSERIAL PRIMARY KEY, customer_id int);\nALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (customer_id) REFERENCES customers(id);`,
    );
  });

  test("a key declared inside CREATE TABLE is on a new table by construction", () => {
    silent(`CREATE TABLE orders (id BIGSERIAL, customer_id int REFERENCES customers(id));`);
  });

  test("Postgres must be proven — `NOT VALID` does not exist elsewhere", () => {
    silent(`ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (customer_id) REFERENCES customers(id);`);
  });
});

describe("volatile column default", () => {
  const fires = (sql: string) => {
    const f = scan(migrationVolatileColumnDefault, sql);
    assert.ok(f.length > 0, `expected a FIRE on:\n${sql}`);
    return f;
  };
  const silent = (sql: string) =>
    assert.equal(scan(migrationVolatileColumnDefault, sql).length, 0, `expected SILENCE on:\n${sql}`);

  test("a volatile default rewrites the table", () => {
    const [f] = fires(`${PG}ALTER TABLE users ADD COLUMN pid uuid DEFAULT gen_random_uuid();`);
    assert.match(f!.message, /244 ms/);
    assert.match(f!.message, /18 ms/);
    fires(`${PG}ALTER TABLE users ADD COLUMN r double precision DEFAULT random();`);
  });

  test("the received wisdom is WRONG since Postgres 11: a constant default is free", () => {
    // Measured: no rewrite, 18 ms on 400,000 rows. Flagging every DEFAULT would
    // be wrong about the common case and train people to ignore the rule.
    silent(`${PG}ALTER TABLE users ADD COLUMN tier int DEFAULT 5;`);
    silent(`${PG}ALTER TABLE users ADD COLUMN label text DEFAULT 'none';`);
  });

  test("`now()` and `CURRENT_TIMESTAMP` are STABLE, not volatile", () => {
    // They take the fast path. Listing them would make the rule wrong about the
    // commonest default of all.
    silent(`${PG}ALTER TABLE users ADD COLUMN at timestamptz DEFAULT now();`);
    silent(`${PG}ALTER TABLE users ADD COLUMN at timestamptz DEFAULT CURRENT_TIMESTAMP;`);
  });

  test("a table born in this migration has no rows to rewrite", () => {
    silent(`CREATE TABLE users (id BIGSERIAL PRIMARY KEY);\nALTER TABLE users ADD COLUMN pid uuid DEFAULT gen_random_uuid();`);
  });
});

describe("column type rewrite", () => {
  const fires = (sql: string) => {
    const f = scan(migrationColumnTypeRewrite, sql);
    assert.ok(f.length > 0, `expected a FIRE on:\n${sql}`);
    return f;
  };
  const silent = (sql: string) =>
    assert.equal(scan(migrationColumnTypeRewrite, sql).length, 0, `expected SILENCE on:\n${sql}`);

  test("a modifier-free target always rewrites, and it blocks READS", () => {
    const [f] = fires(`${PG}ALTER TABLE events ALTER COLUMN id TYPE bigint;`);
    assert.match(f!.message, /ACCESS EXCLUSIVE/);
    assert.match(f!.message, /\*\*reads\*\*/);
    assert.match(f!.message, /2,464 ms/);
    fires(`${PG}ALTER TABLE events ALTER COLUMN k TYPE uuid USING k::uuid;`);
    fires(`${PG}ALTER TABLE events ALTER COLUMN id SET DATA TYPE bigint;`);
    fires(`${PG}ALTER TABLE events ALTER COLUMN meta TYPE jsonb USING meta::jsonb;`);
  });

  test("a target carrying a MODIFIER is undecidable from the file, so it is silent", () => {
    // Measured: the byte-identical statement `ALTER COLUMN c TYPE varchar(100)`
    // is 19 ms and no rewrite from varchar(50), and 144 ms with a rewrite from
    // text. The current type decides, and it is not in the file.
    silent(`${PG}ALTER TABLE events ALTER COLUMN c TYPE varchar(100);`);
    silent(`${PG}ALTER TABLE events ALTER COLUMN n TYPE numeric(12,2);`);
  });

  test("three near-misses are excluded because a free path into them was measured", () => {
    silent(`${PG}ALTER TABLE events ALTER COLUMN i TYPE integer;`); // free from oid
    silent(`${PG}ALTER TABLE events ALTER COLUMN a TYPE inet;`); // free from cidr
    silent(`${PG}ALTER TABLE events ALTER COLUMN t TYPE timestamptz;`); // free under a UTC session
  });

  test("a table born in this migration has no rows to rewrite", () => {
    silent(`CREATE TABLE events (id int);\nALTER TABLE events ALTER COLUMN id TYPE bigint;`);
  });
});

describe("all three — shared guards", () => {
  test("a down/rollback region is excluded", () => {
    const sql = `${PG}-- Down\nALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES b(id);`;
    // The exclusion is the migration module's, and it applies to each rule.
    assert.ok(scan(migrationForeignKeyWithoutNotValid, sql).length <= 1);
  });

  test("a file that is not a migration is never scanned", () => {
    assert.deepEqual(
      scan(migrationColumnTypeRewrite, `${PG}ALTER TABLE e ALTER COLUMN id TYPE bigint;`, "src/db/adhoc.sql"),
      [],
    );
  });
});
