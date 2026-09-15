/**
 * `no-static-kdf-salt`.
 *
 * MEASURED on Node 22 with pbkdf2-sha256 at 600,000 iterations. Three different
 * users who happened to choose the same password:
 *
 *   static salt      alice  c5e1bd456fe4a47c1d6e277820004348
 *                    bob    c5e1bd456fe4a47c1d6e277820004348
 *                    carol  c5e1bd456fe4a47c1d6e277820004348    byte-identical
 *
 *   randomBytes(16)  alice  d5170108fbea0dee219d45b5b094dfa6
 *                    bob    0ff5d24ef5a8f384450693d2772431ea
 *                    carol  6ed92222686d716aa1b84825b6fb6dbc
 *
 * Two things follow. With a constant salt the stored hashes THEMSELVES reveal
 * which accounts share a password, before anyone attacks them. And a table of
 * four guesses, built once, cracked three of three rows — where per-user salts
 * force it to be rebuilt per row. That is the whole point of a salt: it converts
 * "attack the database" into "attack each row".
 *
 * HKDF is deliberately absent. Its salt is a DOMAIN SEPARATOR, RFC 5869
 * explicitly permits an empty one, and the construction is sound over
 * high-entropy input — so a constant there is the documented correct use.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noStaticKdfSalt } from "../../src/diagnostics/security/no-static-kdf-salt.ts";

const CAPS = new Set(["node", "esm", "typescript"]);
const IMPORT = `import crypto from "node:crypto";\n`;

const findings = (source: string) =>
  lintSource({
    filePath: "/repo/src/auth.ts",
    sourceText: IMPORT + source,
    diagnostics: [noStaticKdfSalt],
    capabilities: CAPS,
  }).findings.filter((f) => f.diagnostic === "no-static-kdf-salt");

const fires = (source: string) => {
  const found = findings(source);
  assert.ok(found.length > 0, `expected a FIRE on:\n${source}`);
  return found;
};
const silent = (source: string): void => {
  const found = findings(source);
  assert.equal(found.length, 0, `expected SILENCE on:\n${source}\ngot: ${found.map((f) => f.message).join("\n")}`);
};

describe("no-static-kdf-salt", () => {
  describe("the defect — one table cracks every row", () => {
    test("a string literal salt, in both KDFs and both forms", () => {
      fires(`export const h = (password) => crypto.pbkdf2Sync(password, "app-salt", 600000, 32, "sha256");`);
      fires(`export const h = (password) => crypto.pbkdf2(password, "app-salt", 600000, 32, "sha256", cb);`);
      fires(`export const h = (password) => crypto.scryptSync(password, "app-salt", 32);`);
      fires(`export const h = (password) => crypto.scrypt(password, "app-salt", 32, cb);`);
    });

    test("a module-level const holding the literal", () => {
      fires(`const SALT = "app-salt";\nexport const h = (password) => crypto.pbkdf2Sync(password, SALT, 600000, 32, "sha256");`);
    });

    test("a Buffer.from of a literal, and a template with no interpolation", () => {
      fires(`export const h = (password) => crypto.pbkdf2Sync(password, Buffer.from("app-salt"), 600000, 32, "sha256");`);
      fires(`export const h = (password) => crypto.pbkdf2Sync(password, \`app-salt\`, 600000, 32, "sha256");`);
    });

    test("the destructured import spelling", () => {
      fires(`import { pbkdf2Sync } from "node:crypto";\nexport const h = (password) => pbkdf2Sync(password, "s", 600000, 32, "sha256");`);
    });

    test("the message states both consequences and the fix", () => {
      const [found] = fires(`export const h = (password) => crypto.pbkdf2Sync(password, "app-salt", 600000, 32, "sha256");`);
      assert.match(found!.message, /byte-identical/);
      assert.match(found!.message, /reveal which accounts share a password/);
      assert.match(found!.message, /cracked three of three rows/);
      assert.match(found!.recommendation ?? "", /randomBytes\(16\)/);
    });
  });

  describe("silence — a salt the rule cannot read is the common right answer", () => {
    test("a generated salt", () => {
      silent(`export const h = (password) => { const salt = crypto.randomBytes(16); return crypto.pbkdf2Sync(password, salt, 600000, 32, "sha256"); };`);
    });

    test("a salt read from the row beside the hash", () => {
      silent(`export const v = (password, user) => crypto.pbkdf2Sync(password, user.salt, 600000, 32, "sha256");`);
      silent(`export const v = (password, salt) => crypto.pbkdf2Sync(password, salt, 600000, 32, "sha256");`);
    });

    test("a const that is written to elsewhere is not a constant", () => {
      silent(`let SALT = "seed";\nSALT = crypto.randomBytes(16);\nexport const h = (password) => crypto.pbkdf2Sync(password, SALT, 600000, 32, "sha256");`);
    });

    test("a template with interpolation is per-call", () => {
      silent(`export const h = (password, id) => crypto.pbkdf2Sync(password, \`salt-\${id}\`, 600000, 32, "sha256");`);
    });
  });

  describe("the password-context gate", () => {
    test("key derivation from high-entropy material with a fixed salt is correct", () => {
      // No low-entropy secret means there is no table to build.
      silent(`export const subkey = (masterKey) => crypto.pbkdf2Sync(masterKey, "app-v1", 600000, 32, "sha256");`);
      silent(`export const derive = (rootKey) => crypto.scryptSync(rootKey, "app-v1", 32);`);
    });

    test("the context is found from the function name as well as the identifiers", () => {
      fires(`export function hashPassword(input) { return crypto.pbkdf2Sync(input, "app-salt", 600000, 32, "sha256"); }`);
    });
  });

  describe("HKDF is deliberately absent", () => {
    test("a constant salt is the documented correct use there", () => {
      // RFC 5869 explicitly permits an empty salt; it is a domain separator.
      silent(`export const k = (password) => crypto.hkdfSync("sha256", password, "app-v1", "info", 32);`);
      silent(`export const k = (password) => crypto.hkdf("sha256", password, "app-v1", "info", 32, cb);`);
    });
  });

  test("determinism — identical source yields identical findings", () => {
    const source = `export const h = (password) => [crypto.pbkdf2Sync(password, "a", 600000, 32, "sha256"), crypto.scryptSync(password, "b", 32)];`;
    assert.equal(JSON.stringify(findings(source)), JSON.stringify(findings(source)));
    assert.equal(findings(source).length, 2);
  });
});
