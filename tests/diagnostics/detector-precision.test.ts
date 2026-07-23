import { describe, test } from "node:test";
import { expectFires, expectSilent } from "../helpers.ts";

/**
 * Regressions for two false positives our own dogfooding caught: node.doctor
 * firing on the very code that implements its detectors. A false positive is a
 * bug in the diagnostic, so these pin the corrected behaviour in both directions.
 */

// Assembled so this file never contains a scannable provider-key literal.
const LEAKED = `sk_${"live"}_51H8xR2eZvKYlo9aBcDeFgHiJ`;

describe("no-hardcoded-secret-literal: prefix constants are not credentials", () => {
  test("fires on a real key (prefix + material)", () => {
    expectFires("no-hardcoded-secret-literal", `const k = "${LEAKED}";`);
  });
  test("silent on a bare provider prefix — detector code, no key material", () => {
    expectSilent("no-hardcoded-secret-literal", `const p = "sk_live_";`);
    expectSilent("no-hardcoded-secret-literal", `const q = "github_pat_";`);
  });
  test("still fires on a secret-named value with entropy", () => {
    expectSilent("no-hardcoded-secret-literal", `const password = "changeme";`);
    expectFires("no-hardcoded-secret-literal", `const password = "S3cr3t!longEnoughValue";`);
  });
  test("silent on a natural-language value with interior whitespace (a label, not a secret)", () => {
    // A credential token is a single contiguous string; a value with a space is
    // prose that merely sits in a secret-shaped field.
    expectSilent("no-hardcoded-secret-literal", `const credentials = "Credential files";`);
    expectSilent("no-hardcoded-secret-literal", `const apiKey = "See the wiki for setup steps";`);
    expectSilent("no-hardcoded-secret-literal", `const token = { "secret-content": "Files containing a secret" };`);
  });
});

describe("no-redos-prone-regex: an optional group cannot backtrack catastrophically", () => {
  test("fires on a genuinely nested quantifier", () => {
    expectFires("no-redos-prone-regex", `const re = /^(\\w+)*$/;`);
    expectFires("no-redos-prone-regex", `const re = /^(.*)*$/;`);
  });
  test("silent on an optional group containing a quantifier — matches at most once", () => {
    expectSilent("no-redos-prone-regex", `const re = /^\\d+\\.\\d+(?:[-+][0-9A-Za-z.]+)?$/;`);
  });
  test("silent on an ordinary single quantifier", () => {
    expectSilent("no-redos-prone-regex", `const re = /^\\w+$/;`);
  });
});
