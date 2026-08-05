/**
 * §165 — `no-unreleased-resource`.
 *
 * The rule claims "you acquired this and never gave it back". That claim is
 * wrong the moment the release happens anywhere the rule cannot see, so the
 * SILENT block below is the real specification — it is written first and it is
 * the larger of the two, deliberately.
 *
 * The single most important property: nothing here fires on a NAME. Every case
 * is anchored to an import, so `pool.connect()` on something that is not a pg
 * Pool must be silent no matter how much it looks like one.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noUnreleasedResource } from "../../src/diagnostics/reliability/no-unreleased-resource.ts";

const CAPS = new Set(["node", "esm", "typescript"]);

const findings = (source: string) =>
  lintSource({
    filePath: "/repo/a.ts",
    sourceText: source,
    diagnostics: [noUnreleasedResource],
    capabilities: CAPS,
  }).findings.filter((f) => f.diagnostic === "no-unreleased-resource");

const fires = (source: string): void => {
  assert.ok(findings(source).length > 0, `expected no-unreleased-resource to FIRE on:\n${source}`);
};

const silent = (source: string): void => {
  const found = findings(source);
  assert.equal(
    found.length,
    0,
    `expected no-unreleased-resource to STAY SILENT, got ${found.length}:\n` +
      found.map((f) => `  - ${f.message}`).join("\n") +
      `\n--- source ---\n${source}`,
  );
};

const PG = `import { Pool } from "pg";\nconst pool = new Pool();\n`;
const OTEL = `import { trace } from "@opentelemetry/api";\nconst tracer = trace.getTracer("svc");\n`;
const MUTEX = `import { Mutex } from "async-mutex";\nconst mutex = new Mutex();\n`;

describe("no-unreleased-resource — silent unless the contract is proven", () => {
  test("a `pool.connect()` on something that is not a pg Pool", () => {
    // The whole point of the rule: no import, no claim. This is a websocket,
    // a redis client, a mongoose connection — the engine cannot tell, so it
    // must not guess from the word `connect`.
    silent(`
      async function f(pool) {
        const client = await pool.connect();
        return client.query("select 1");
      }
    `);
    silent(`
      const pool = makePool();
      async function f() {
        const client = await pool.connect();
        return client.query("select 1");
      }
    `);
  });

  test("a pg import with no Pool receiver bound from it", () => {
    silent(`
      import { Client } from "pg";
      async function f(pool) {
        const client = await pool.connect();
        return client.query("select 1");
      }
    `);
  });

  test("the release IS present — anywhere at all", () => {
    silent(`${PG}
      async function f() {
        const client = await pool.connect();
        try { return await client.query("select 1"); } finally { client.release(); }
      }
    `);
    silent(`${PG}
      async function f() {
        const client = await pool.connect();
        const rows = await client.query("select 1");
        client.release();
        return rows;
      }
    `);
    // Released only on the happy path — still silent. Proving "on every path"
    // needs a control-flow graph this engine does not have, and claiming it
    // without one would be a guess.
    silent(`${PG}
      async function f() {
        const client = await pool.connect();
        if (ok) { client.release(); }
        return 1;
      }
    `);
    // Released inside a nested callback.
    silent(`${PG}
      async function f() {
        const client = await pool.connect();
        process.nextTick(() => client.release());
      }
    `);
    // Released in a catch.
    silent(`${PG}
      async function f() {
        const client = await pool.connect();
        try { await client.query("x"); } catch (e) { client.release(); throw e; }
      }
    `);
  });

  test("the binding escapes, so the release may happen out of sight", () => {
    silent(`${PG}
      async function f() {
        const client = await pool.connect();
        return client;                        // the caller releases it
      }
    `);
    silent(`${PG}
      async function f() {
        const client = await pool.connect();
        await withClient(client);             // the helper releases it
      }
    `);
    silent(`${PG}
      async function f() {
        const client = await pool.connect();
        this.client = client;                 // stored
      }
    `);
    silent(`${PG}
      async function f() {
        const client = await pool.connect();
        return { client };                    // handed out in an object
      }
    `);
    silent(`${PG}
      async function f() {
        const client = await pool.connect();
        const alias = client;                 // aliased — the alias may release
        return alias.query("x");
      }
    `);
    silent(`${PG}
      async function f() {
        const client = await pool.connect();
        register([client]);                   // in an array
      }
    `);
    silent(`${PG}
      async function f() {
        const client = await pool.connect();
        return new Wrapper(client);           // NewExpression, not CallExpression
      }
    `);
  });

  test("a module-scope resource is meant to outlive the module body", () => {
    silent(`${PG}
      const client = await pool.connect();
      export const q = () => client.query("select 1");
    `);
  });

  test("the result is not bound, so there is nothing to release by name", () => {
    silent(`${PG}
      async function f() {
        await pool.connect();
      }
    `);
  });

  test("released inline off the acquire", () => {
    silent(`${PG}
      async function f() {
        const client = (await pool.connect()).release();
      }
    `);
  });

  test("a computed or dynamic release call is not evidence of a leak", () => {
    silent(`${PG}
      async function f() {
        const client = await pool.connect();
        client["release"]();
      }
    `);
    silent(`${PG}
      async function f() {
        const client = await pool.connect();
        client[cleanupMethod]();
      }
    `);
    silent(`${MUTEX}
      async function f() {
        const release = await mutex.acquire();
        try { await work(); } finally { release.call(null); }
      }
    `);
  });

  test("an inner shadow makes the binding unprovable", () => {
    silent(`${PG}
      async function f() {
        const client = await pool.connect();
        {
          const client = other();
          client.release();
        }
      }
    `);
  });

  test("a span that is ended, and a mutex that is released", () => {
    silent(`${OTEL}
      function f() {
        const span = tracer.startSpan("work");
        try { work(); } finally { span.end(); }
      }
    `);
    silent(`${MUTEX}
      async function f() {
        const release = await mutex.acquire();
        try { await work(); } finally { release(); }
      }
    `);
  });

  test("`trace.getTracer` from somewhere that is not OpenTelemetry", () => {
    silent(`
      const tracer = trace.getTracer("svc");
      function f() {
        const span = tracer.startSpan("work");
        return span;
      }
    `);
  });

  test("a different method on a proven receiver", () => {
    silent(`${PG}
      async function f() {
        const rows = await pool.query("select 1");
        return rows;
      }
    `);
  });
});

describe("no-unreleased-resource — fires when the contract is proven broken", () => {
  test("a pg pooled client checked out and never returned", () => {
    fires(`${PG}
      async function f() {
        const client = await pool.connect();
        const rows = await client.query("select 1");
        return rows.rows;
      }
    `);
  });

  test("the CJS require form binds the factory just as well", () => {
    fires(`
      const { Pool } = require("pg");
      const pool = new Pool();
      async function f() {
        const client = await pool.connect();
        return (await client.query("select 1")).rows;
      }
    `);
  });

  test("a renamed import is still the same contract", () => {
    fires(`
      import { Pool as PgPool } from "pg";
      const pool = new PgPool();
      async function f() {
        const client = await pool.connect();
        return (await client.query("select 1")).rows;
      }
    `);
  });

  test("an OpenTelemetry span that never ends", () => {
    fires(`${OTEL}
      function f() {
        const span = tracer.startSpan("work");
        span.setAttribute("k", 1);
        doWork();
      }
    `);
  });

  test("a mutex permit that is never given back", () => {
    fires(`${MUTEX}
      async function f() {
        const release = await mutex.acquire();
        await work();
      }
    `);
  });

  test("a MongoDB session that is never ended", () => {
    fires(`
      import { MongoClient } from "mongodb";
      const client = new MongoClient(uri);
      async function f() {
        const session = client.startSession();
        session.startTransaction();
        await save();
      }
    `);
  });

  test("the message names the resource and the exact call that is missing", () => {
    const [f] = findings(`${PG}
      async function f() {
        const client = await pool.connect();
        return (await client.query("select 1")).rows;
      }
    `);
    assert.ok(f, "expected a finding");
    assert.match(f.message, /client\.release\(\)/, "names the call the author must add");
    assert.match(f.message, /Postgres/, "names what is leaking");
  });
});

describe("no-unreleased-resource — determinism", () => {
  test("the same source yields identical findings", () => {
    const source = `${PG}
      async function a() { const c = await pool.connect(); return c.query("1"); }
      async function b() { const c = await pool.connect(); return c.query("2"); }
    `;
    assert.equal(JSON.stringify(findings(source)), JSON.stringify(findings(source)));
    assert.equal(findings(source).length, 2, "each function is judged on its own");
  });
});
