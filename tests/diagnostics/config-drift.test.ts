import { describe, test } from "node:test";
import { expectFires, expectSilent } from "../helpers.ts";

// ---------------------------------------------------------------------------
// no-unchecked-required-env
//
// Fires ONLY on the two crash shapes — a non-null assertion on a required env
// var, or an immediate member access on `process.env.FOO` (which is typed
// `string | undefined`). Every defaulting / guarding / plain-read form stays
// silent, because a false positive here would flag correct defensive code.
// Opt-in (`defaultEnabled: false`); tests pass the `node` capability so the
// gate is satisfied and the rule runs.
// ---------------------------------------------------------------------------

const caps = ["node", "esm", "typescript"];

describe("no-unchecked-required-env", () => {
  // --- fires -------------------------------------------------------------
  test("fires on a non-null assertion", () => {
    expectFires("no-unchecked-required-env", `const url = process.env.DATABASE_URL!;`, { capabilities: caps });
  });
  test("fires on an immediate member access", () => {
    expectFires("no-unchecked-required-env", `const parts = process.env.REGION.split("-");`, { capabilities: caps });
  });
  test("fires on a computed (string-literal) member access", () => {
    expectFires("no-unchecked-required-env", `const x = process.env["BAR"].trim();`, { capabilities: caps });
  });
  test("fires on a method-call chain", () => {
    expectFires("no-unchecked-required-env", `process.env.FOO.toUpperCase();`, { capabilities: caps });
  });
  test("fires on a computed index access", () => {
    expectFires("no-unchecked-required-env", `const c = process.env.FOO[0];`, { capabilities: caps });
  });
  test("fires once through a non-null-then-member chain", () => {
    expectFires("no-unchecked-required-env", `const x = process.env.FOO!.bar;`, { capabilities: caps });
  });
  test("an unrelated guard does not silence the crash", () => {
    expectFires(
      "no-unchecked-required-env",
      `if (process.env.BAR) { process.env.FOO.split("-"); }`,
      { capabilities: caps },
    );
  });

  // --- silent ------------------------------------------------------------
  test("silent on `|| default`", () => {
    expectSilent("no-unchecked-required-env", `const x = process.env.FOO || "d";`, { capabilities: caps });
  });
  test("silent on `?? default`", () => {
    expectSilent("no-unchecked-required-env", `const x = process.env.FOO ?? "d";`, { capabilities: caps });
  });
  test("silent on an equality comparison", () => {
    expectSilent("no-unchecked-required-env", `if (process.env.NODE_ENV === "production") {}`, { capabilities: caps });
  });
  test("silent when passed as a plain argument", () => {
    expectSilent("no-unchecked-required-env", `configure(process.env.FOO);`, { capabilities: caps });
  });
  test("silent on destructuring `const { FOO } = process.env`", () => {
    expectSilent("no-unchecked-required-env", `const { FOO } = process.env;`, { capabilities: caps });
  });
  test("silent on an optional-chained member access", () => {
    expectSilent("no-unchecked-required-env", `const p = process.env.FOO?.split("-");`, { capabilities: caps });
  });
  test("silent on a plain read into a variable", () => {
    expectSilent("no-unchecked-required-env", `const p = process.env.FOO; use(p);`, { capabilities: caps });
  });
  test("silent under an if-guard of the same var", () => {
    expectSilent(
      "no-unchecked-required-env",
      `if (process.env.FOO) { process.env.FOO.split("-"); }`,
      { capabilities: caps },
    );
  });
  test("silent under a logical-and guard of the same var", () => {
    expectSilent(
      "no-unchecked-required-env",
      `const x = process.env.FOO && process.env.FOO.toUpperCase();`,
      { capabilities: caps },
    );
  });
  test("silent under a conditional-expression guard of the same var", () => {
    expectSilent(
      "no-unchecked-required-env",
      `const x = process.env.FOO ? process.env.FOO.trim() : "d";`,
      { capabilities: caps },
    );
  });
  test("silent on a dynamic (non-literal) key", () => {
    expectSilent("no-unchecked-required-env", `const x = process.env[key].split(",");`, { capabilities: caps });
  });
  test("silent on an aliased env object (not provably process.env)", () => {
    expectSilent("no-unchecked-required-env", `const env = process.env; env.FOO.split(",");`, { capabilities: caps });
  });
  test("silent on a bare read with no assumption", () => {
    expectSilent("no-unchecked-required-env", `console.log(process.env.FOO);`, { capabilities: caps });
  });

  // --- gating -------------------------------------------------------------
  test("inert without the node capability", () => {
    expectSilent("no-unchecked-required-env", `const url = process.env.DATABASE_URL!;`, { capabilities: ["esm"] });
  });
});
