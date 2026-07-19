import { describe, test } from "node:test";
import assert from "node:assert/strict";
import plugin, { diagnostics } from "../../src/adapters/eslint.ts";

interface Reported {
  loc: { line: number; column: number };
  message: string;
}

/** A minimal fake ESLint flat-config context. */
const fakeContext = (filename: string, text: string, sink: Reported[]) => ({
  filename,
  sourceCode: { getText: () => text },
  report: (d: Reported) => sink.push(d),
});

describe("eslint adapter", () => {
  test("exposes one ESLint diagnostic per node.doctor diagnostic", () => {
    assert.ok(diagnostics["no-sql-template-interpolation"]);
    assert.ok(diagnostics["express-async-handler-unprotected"]);
    assert.equal(diagnostics["no-sql-template-interpolation"]!.meta.type, "problem");
  });

  test("a diagnostic reports on bad code through the ESLint contract", () => {
    const sink: Reported[] = [];
    const diagnostic = diagnostics["no-sql-template-interpolation"]!;
    const ctx = fakeContext("repo.ts", "db.query(`SELECT * FROM u WHERE id = ${id}`);", sink);
    const visitors = diagnostic.create(ctx);
    visitors.Program!(null);
    assert.equal(sink.length, 1);
    assert.ok(sink[0]!.message.includes("SQL"));
    assert.equal(sink[0]!.loc.line, 1);
  });

  test("a diagnostic stays silent on safe code", () => {
    const sink: Reported[] = [];
    const diagnostic = diagnostics["no-sql-template-interpolation"]!;
    const ctx = fakeContext("repo.ts", `db.query("SELECT * FROM u WHERE id = $1", [id]);`, sink);
    diagnostic.create(ctx).Program!(null);
    assert.equal(sink.length, 0);
  });

  test("recommended config maps every diagnostic", () => {
    const recommended = plugin.configs.recommended as { diagnostics: Record<string, string> };
    assert.ok(recommended.diagnostics["node-doctor/no-sql-template-interpolation"]);
    assert.ok(Object.keys(recommended.diagnostics).length >= 17);
  });
});
