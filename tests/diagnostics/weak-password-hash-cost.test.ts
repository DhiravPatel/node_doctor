/**
 * `no-weak-password-hash-cost`.
 *
 * The algorithm is right — this is not `no-weak-hash-for-password`, which is about
 * MD5 and SHA-1 — but the work factor makes it cheap to brute-force anyway.
 * MEASURED on one core, five runs after warmup with the median taken, so the
 * doubling per bcrypt cost step is visible rather than lost in JIT noise:
 *
 *   bcrypt cost   median ms   guesses/s   vs cost 12
 *      4              1.0        1035        204x
 *      6              3.2         315         62x
 *      8             12.3          81         16x
 *     10             49.2          20          4x
 *     12            197.5           5          1x
 *
 *   pbkdf2-sha256   median ms   guesses/s
 *       1,000           0.1       12773      563x faster than 600,000
 *      10,000           0.7        1354
 *     100,000           7.5         134
 *     600,000          44.1          23
 *
 * Nothing fails when the cost is too low: the hash verifies, the tests pass, and
 * the only observable difference is how fast an attacker holding the table can
 * guess. The floors are library defaults and published minimums, never guesses.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noWeakPasswordHashCost } from "../../src/diagnostics/security/no-weak-password-hash-cost.ts";

const CAPS = new Set(["node", "esm", "typescript"]);
const BCRYPT = `import bcrypt from "bcryptjs";\n`;
const CRYPTO = `import crypto from "node:crypto";\n`;

const findings = (source: string) =>
  lintSource({
    filePath: "/repo/src/auth.ts",
    sourceText: source,
    diagnostics: [noWeakPasswordHashCost],
    capabilities: CAPS,
  }).findings.filter((f) => f.diagnostic === "no-weak-password-hash-cost");

const fires = (source: string) => {
  const found = findings(source);
  assert.ok(found.length > 0, `expected a FIRE on:\n${source}`);
  return found;
};
const silent = (source: string): void => {
  const found = findings(source);
  assert.equal(found.length, 0, `expected SILENCE on:\n${source}\ngot: ${found.map((f) => f.message).join("\n")}`);
};

describe("no-weak-password-hash-cost", () => {
  describe("bcrypt — the floor is 10, bcryptjs's own default", () => {
    test("every cost below the floor", () => {
      for (const cost of [1, 4, 6, 8, 9]) {
        fires(`${BCRYPT}export const store = (password) => bcrypt.hash(password, ${cost});`);
      }
    });

    test("a cost with no measured row falls back to the doubling, with no invented number", () => {
      const [found] = fires(`${BCRYPT}export const store = (password) => bcrypt.hash(password, 9);`);
      assert.match(found!.message, /Each step of the cost doubles the work/);
      assert.doesNotMatch(found!.message, /cost 9 takes/);
    });

    test("the floor itself and above are silent", () => {
      for (const cost of [10, 11, 12, 14]) {
        silent(`${BCRYPT}export const store = (password) => bcrypt.hash(password, ${cost});`);
      }
    });

    test("hashSync, genSalt and genSaltSync", () => {
      fires(`${BCRYPT}export const a = (password) => bcrypt.hashSync(password, 4);`);
      fires(`${BCRYPT}export const b = () => bcrypt.genSalt(6);`);
      fires(`${BCRYPT}export const c = () => bcrypt.genSaltSync(8);`);
    });

    test("a destructured import, and the require spelling", () => {
      fires(`import { hash } from "bcrypt";\nexport const a = (password) => hash(password, 4);`);
      fires(`const bcrypt = require("bcryptjs");\nexport const b = (password) => bcrypt.hash(password, 4);`);
      fires(`const { hash } = require("bcrypt");\nexport const c = (password) => hash(password, 4);`);
    });

    test("bcrypt needs no password context — it exists for one purpose", () => {
      fires(`${BCRYPT}export const derive = (value) => bcrypt.hash(value, 4);`);
    });

    test("the message states the measured ratio and the fix", () => {
      const [found] = fires(`${BCRYPT}export const store = (password) => bcrypt.hash(password, 4);`);
      // The MEASURED ratio, not a computed 2 ** (12 - cost) dressed up as one.
      assert.match(found!.message, /\*\*204x\*\* cheaper to attack/);
      assert.match(found!.message, /1\.0 ms per hash against cost 12's 197\.5 ms/);
      assert.match(found!.message, /only after a breach/);
      assert.match(found!.recommendation ?? "", /204x/);
    });
  });

  describe("bcrypt — what is not a cost", () => {
    test("a salt STRING is a different overload", () => {
      silent(`${BCRYPT}export const a = (password, salt) => bcrypt.hash(password, salt);`);
      silent(`${BCRYPT}export const b = (password) => bcrypt.hash(password, "$2b$04$abcdefghijklmnopqrstuv");`);
    });

    test("a cost the rule cannot read", () => {
      silent(`${BCRYPT}export const a = (password) => bcrypt.hash(password, ROUNDS);`);
      silent(`${BCRYPT}export const b = (password) => bcrypt.hash(password, Number(process.env.ROUNDS));`);
      silent(`${BCRYPT}export const c = (password) => bcrypt.hash(password, isTest ? 4 : 12);`);
    });

    test("a `hash` from somewhere else is not bcrypt", () => {
      silent(`import { hash } from "ohash";\nexport const a = (password) => hash(password, 4);`);
      silent(`export const a = (password) => cache.hash(password, 4);`);
    });
  });

  describe("pbkdf2 — the floor is 100,000, well under OWASP's 600,000", () => {
    test("iteration counts below the floor, in a password context", () => {
      fires(`${CRYPTO}export const store = (password, salt) => crypto.pbkdf2Sync(password, salt, 1000, 32, "sha256");`);
      fires(`${CRYPTO}export const s = (password, salt) => crypto.pbkdf2(password, salt, 10000, 32, "sha256", cb);`);
    });

    test("100,000 and above are silent — the many codebases at 100k-310k", () => {
      silent(`${CRYPTO}export const a = (password, salt) => crypto.pbkdf2Sync(password, salt, 100000, 32, "sha256");`);
      silent(`${CRYPTO}export const b = (password, salt) => crypto.pbkdf2Sync(password, salt, 600000, 32, "sha256");`);
    });

    test("without a password context it is a plain KDF, where low cost is correct", () => {
      // Deriving a subkey from a 256-bit master key does not need 600,000 rounds.
      silent(`${CRYPTO}export const subkey = (masterKey, salt) => crypto.pbkdf2Sync(masterKey, salt, 1000, 32, "sha256");`);
    });

    test("the message names the measured guess rate", () => {
      const [found] = fires(
        `${CRYPTO}export const store = (password, salt) => crypto.pbkdf2Sync(password, salt, 1000, 32, "sha256");`,
      );
      assert.match(found!.message, /12,?773 guesses a second/);
      assert.match(found!.message, /\*\*563x\*\*/);
    });
  });

  describe("scrypt — the floor is Node's own default", () => {
    test("an N below 16384 in a password context", () => {
      fires(`${CRYPTO}export const s = (password, salt) => crypto.scryptSync(password, salt, 32, { N: 1024, r: 8, p: 1 });`);
    });

    test("the default and above, and an absent N", () => {
      silent(`${CRYPTO}export const a = (password, salt) => crypto.scryptSync(password, salt, 32, { N: 16384 });`);
      silent(`${CRYPTO}export const b = (password, salt) => crypto.scryptSync(password, salt, 32, { N: 32768 });`);
      silent(`${CRYPTO}export const c = (password, salt) => crypto.scryptSync(password, salt, 32);`);
      silent(`${CRYPTO}export const d = (password, salt) => crypto.scryptSync(password, salt, 32, { r: 8, p: 1 });`);
    });

    test("an N the rule cannot read", () => {
      silent(`${CRYPTO}export const a = (password, salt) => crypto.scryptSync(password, salt, 32, { N: COST });`);
      silent(`${CRYPTO}export const b = (password, salt) => crypto.scryptSync(password, salt, 32, opts);`);
    });

    test("the message says the cost was turned DOWN from the default", () => {
      const [found] = fires(
        `${CRYPTO}export const s = (password, salt) => crypto.scryptSync(password, salt, 32, { N: 1024 });`,
      );
      assert.match(found!.message, /below Node's own default of 16384/);
      assert.match(found!.message, /turns the cost \*\*down\*\*/);
    });
  });

  test("determinism — identical source yields identical findings", () => {
    const source = `${BCRYPT}export const a = (password) => bcrypt.hash(password, 4);\nexport const b = (password) => bcrypt.hashSync(password, 6);`;
    assert.equal(JSON.stringify(findings(source)), JSON.stringify(findings(source)));
    assert.equal(findings(source).length, 2);
  });
});
