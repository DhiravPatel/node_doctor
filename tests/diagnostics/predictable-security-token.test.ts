/**
 * `no-predictable-security-token`.
 *
 * MEASURED against uuid 14.0.2, three `v1()` calls in a row:
 *
 *   776c28c0-b008-11f1-941c-09e2f413dcbe
 *   776c4fd0-b008-11f1-941c-09e2f413dcbe
 *   776c4fd1-b008-11f1-941c-09e2f413dcbe
 *
 * All three end `941c-09e2f413dcbe` — the clock sequence and this host's MAC
 * address. 80 of the 128 bits are CONSTANT, and the only part that moves is the
 * low 32 bits of a 100-nanosecond timestamp. v3 and v5 are worse: the same input
 * returned the byte-identical UUID both times, because they are namespaced MD5
 * and SHA-1 hashes of a name the attacker usually supplies.
 *
 * v6 was going to be on the list and the measurement took it off — three
 * consecutive v6 values shared NO suffix, because uuid 14 re-randomises the node
 * id per call. v7 the same. Neither is reported.
 *
 * And three `Date.now().toString(36)` calls in a row returned the identical
 * string `mu0vurf2`, so a clock-derived token collides as well as leaks.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noPredictableSecurityToken } from "../../src/diagnostics/security/no-predictable-security-token.ts";

const CAPS = new Set(["node", "esm", "typescript"]);
const UUID = `import { v1, v3, v4, v5, v6, v7 } from "uuid";\n`;

const findings = (source: string) =>
  lintSource({
    filePath: "/repo/src/auth.ts",
    sourceText: source,
    diagnostics: [noPredictableSecurityToken],
    capabilities: CAPS,
  }).findings.filter((f) => f.diagnostic === "no-predictable-security-token");

const fires = (source: string) => {
  const found = findings(source);
  assert.ok(found.length > 0, `expected a FIRE on:\n${source}`);
  return found;
};
const silent = (source: string): void => {
  const found = findings(source);
  assert.equal(found.length, 0, `expected SILENCE on:\n${source}\ngot: ${found.map((f) => f.message).join("\n")}`);
};

describe("no-predictable-security-token", () => {
  describe("uuid — the versions measured to be predictable", () => {
    test("v1, v3 and v5 into a security-shaped binding", () => {
      fires(`${UUID}export const a = () => { const resetToken = v1(); return resetToken; };`);
      fires(`${UUID}export const b = (email) => { const apiKey = v5(email, NS); return apiKey; };`);
      fires(`${UUID}export const c = (email) => { const sessionId = v3(email, NS); return sessionId; };`);
    });

    test("v4, v6 and v7 are NOT — v6's absence is what the measurement forced", () => {
      // Three consecutive v6 values shared no suffix; uuid 14 re-randomises the
      // node id per call, so the tail carries real entropy.
      silent(`${UUID}export const a = () => { const resetToken = v4(); return resetToken; };`);
      silent(`${UUID}export const b = () => { const resetToken = v6(); return resetToken; };`);
      silent(`${UUID}export const c = () => { const resetToken = v7(); return resetToken; };`);
    });

    test("the enclosing function's name is enough, with no binding", () => {
      fires(`${UUID}export function generateResetToken() { return v1(); }`);
      fires(`${UUID}export const createApiKey = () => v1();`);
    });

    test("every import spelling", () => {
      fires(`import { v1 as uuidv1 } from "uuid";\nexport const a = () => { const token = uuidv1(); return token; };`);
      fires(`import * as uuid from "uuid";\nexport const b = () => { const token = uuid.v1(); return token; };`);
      fires(`import uuid from "uuid";\nexport const c = () => { const token = uuid.v1(); return token; };`);
      fires(`import uuidv1 from "uuid/v1";\nexport const d = () => { const token = uuidv1(); return token; };`);
      fires(`const { v1 } = require("uuid");\nexport const e = () => { const token = v1(); return token; };`);
      fires(`const uuid = require("uuid");\nexport const f = () => { const token = uuid.v1(); return token; };`);
      fires(`const uuidv1 = require("uuid/v1");\nexport const g = () => { const token = uuidv1(); return token; };`);
    });

    test("a local v1 is not the uuid package", () => {
      silent(`import { v1 } from "./versions.js";\nexport const a = () => { const token = v1(); return token; };`);
      silent(`export const a = () => { const token = v1(); return token; };`);
      silent(`import { v1 } from "uuid";\nexport const b = () => { const rowId = v1(); return rowId; };`);
    });

    test("the message names the version, the mechanism and the measurement", () => {
      const [found] = fires(`${UUID}export const a = () => { const resetToken = v1(); return resetToken; };`);
      assert.match(found!.message, /host's MAC address/);
      assert.match(found!.message, /941c-09e2f413dcbe/);
      assert.match(found!.message, /80 of the 128 bits are constant/);
      assert.match(found!.recommendation ?? "", /crypto\.randomUUID/);
    });
  });

  describe("the clock — predictable and colliding", () => {
    test("a clock read into a security-shaped binding", () => {
      fires(`export const a = () => { const sessionId = Date.now().toString(36); return sessionId; };`);
      fires(`export const b = () => { const csrfToken = String(Date.now()); return csrfToken; };`);
      fires(`export const c = () => { const otp = performance.now(); return otp; };`);
    });

    test("a time-shaped name is a legitimate clock use", () => {
      // `token_expiry` contains `token`, and this is correct code.
      silent(`export const a = () => { const tokenExpiry = Date.now() + 3600000; return tokenExpiry; };`);
      silent(`export const b = () => { const sessionExpiresAt = Date.now() + ttl; return sessionExpiresAt; };`);
      silent(`export const c = () => { const tokenIssuedAt = Date.now(); return tokenIssuedAt; };`);
      silent(`export const d = () => { const otpTtl = Date.now() + 60000; return otpTtl; };`);
    });

    test("the clock does NOT take the enclosing-function path", () => {
      // A Date.now() for a log line or an expiry inside a token generator is not
      // the token, so only a named binding is judged.
      silent(`export function generateToken() { const startedAt = Date.now(); return crypto.randomUUID(); }`);
      silent(`export function generateToken() { log(Date.now()); return crypto.randomUUID(); }`);
    });

    test("an ordinary clock read is untouched", () => {
      silent(`export const a = () => { const elapsed = Date.now() - start; return elapsed; };`);
      silent(`export const b = () => { const rowId = Date.now(); return rowId; };`);
    });

    test("the message states the collision, not just the leak", () => {
      const [found] = fires(`export const a = () => { const sessionId = Date.now().toString(36); return sessionId; };`);
      assert.match(found!.message, /COLLIDES/);
      assert.match(found!.message, /mu0vurf2/);
    });
  });

  describe("the security-name gate is segment-aware", () => {
    test("a name that merely contains the letters is not a token", () => {
      silent(`${UUID}export const a = () => { const tokenize = v1(); return tokenize; };`);
      silent(`${UUID}export const b = () => { const saltedButter = v1(); return saltedButter; };`);
    });

    test("separators and camelCase both split into segments", () => {
      fires(`${UUID}export const a = () => { const reset_token = v1(); return reset_token; };`);
      fires(`${UUID}export const b = () => { const apiKey = v1(); return apiKey; };`);
      fires(`${UUID}export const c = () => { const userId = v1(); return userId; };`);
    });
  });

  test("determinism — identical source yields identical findings", () => {
    const source = `${UUID}export const a = () => { const resetToken = v1(); const apiKey = v5(e, NS); return [resetToken, apiKey]; };`;
    assert.equal(JSON.stringify(findings(source)), JSON.stringify(findings(source)));
    assert.equal(findings(source).length, 2);
  });
});
