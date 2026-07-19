import { describe, test } from "node:test";
import { expectFires, expectSilent } from "../helpers.ts";

const JWT = { capabilities: ["node", "esm", "jsonwebtoken"] };

describe("no-jwt-none-algorithm", () => {
  test("silent on a pinned real algorithm", () => {
    expectSilent(
      "no-jwt-none-algorithm",
      `import jwt from "jsonwebtoken";
       export const check = (t, k) => jwt.verify(t, k, { algorithms: ["RS256", "HS256"] });`,
      JWT,
    );
  });

  test("fires when the allowlist contains 'none'", () => {
    expectFires(
      "no-jwt-none-algorithm",
      `import jwt from "jsonwebtoken";
       export const check = (t, k) => jwt.verify(t, k, { algorithms: ["RS256", "none"] });`,
      JWT,
    );
  });

  test("fires when signing with algorithm 'none' (any case)", () => {
    expectFires(
      "no-jwt-none-algorithm",
      `import jwt from "jsonwebtoken";
       export const make = (p, k) => jwt.sign(p, k, { algorithm: "None" });`,
      JWT,
    );
  });
});

describe("require-jwt-algorithms-allowlist", () => {
  test("silent when algorithms are pinned", () => {
    expectSilent(
      "require-jwt-algorithms-allowlist",
      `import jwt from "jsonwebtoken";
       export const check = (t, k) => jwt.verify(t, k, { algorithms: ["RS256"] });`,
      JWT,
    );
  });

  test("silent for unrelated .verify receivers", () => {
    expectSilent(
      "require-jwt-algorithms-allowlist",
      `import argon2 from "argon2";
       export const check = (hash, pw) => argon2.verify(hash, pw);`,
      JWT,
    );
  });

  test("fires when verify has no options", () => {
    expectFires(
      "require-jwt-algorithms-allowlist",
      `import jwt from "jsonwebtoken";
       export const check = (t, k) => jwt.verify(t, k);`,
      JWT,
    );
  });

  test("fires when options omit algorithms", () => {
    expectFires(
      "require-jwt-algorithms-allowlist",
      `import jwt from "jsonwebtoken";
       export const check = (t, k) => jwt.verify(t, k, { issuer: "me" });`,
      JWT,
    );
  });
});

describe("no-hardcoded-secret-literal", () => {
  test("silent when the secret is read from the environment", () => {
    expectSilent(
      "no-hardcoded-secret-literal",
      `export const apiKey = process.env.API_KEY;
       export const placeholder = "changeme";
       export const shortPw = "abc";`,
    );
  });

  test("silent for a dictionary-word value on a token-shaped name", () => {
    expectSilent(
      "no-hardcoded-secret-literal",
      `export const tokenType = "authorization";`,
    );
  });

  test("fires on a secret-shaped binding with a real literal", () => {
    expectFires(
      "no-hardcoded-secret-literal",
      `const apiKey = "a1b2c3d4e5f6g7h8i9j0";
       export default apiKey;`,
    );
  });

  test("fires on a recognizable provider key prefix regardless of name", () => {
    expectFires(
      "no-hardcoded-secret-literal",
      // Fake key: the sk_live_ prefix is what fires the diagnostic; the body is
      // deliberately not a real high-entropy token (so secret scanners ignore it).
      `const client = { key: "sk_live_EXAMPLE_not_a_real_key" };`,
    );
  });
});

describe("no-math-random-for-token", () => {
  test("silent for non-security randomness", () => {
    expectSilent(
      "no-math-random-for-token",
      `const jitter = Math.random() * 100;
       export function backoff() { return 50 + Math.random() * 50; }`,
    );
  });

  test("fires when Math.random flows into a token binding", () => {
    expectFires(
      "no-math-random-for-token",
      `const token = Math.random().toString(36).slice(2);
       export default token;`,
    );
  });

  test("fires inside a security-shaped function", () => {
    expectFires(
      "no-math-random-for-token",
      `export function generateOtp() { return Math.floor(Math.random() * 1000000); }`,
    );
  });
});

describe("no-weak-cipher", () => {
  test("silent for an authenticated cipher with an IV", () => {
    expectSilent(
      "no-weak-cipher",
      `import crypto from "node:crypto";
       export const enc = (k, iv) => crypto.createCipheriv("aes-256-gcm", k, iv);`,
    );
  });

  test("fires on an ECB-mode algorithm", () => {
    expectFires(
      "no-weak-cipher",
      `import crypto from "node:crypto";
       export const enc = (k) => crypto.createCipheriv("aes-128-ecb", k, null);`,
    );
  });

  test("fires on the deprecated createCipher API", () => {
    expectFires(
      "no-weak-cipher",
      `import crypto from "node:crypto";
       export const enc = (pw) => crypto.createCipher("aes-256-cbc", pw);`,
    );
  });
});

describe("no-disabled-tls-verification", () => {
  test("silent when a real CA is provided", () => {
    expectSilent(
      "no-disabled-tls-verification",
      `import https from "node:https";
       export const get = (url, ca) => https.get(url, { ca });`,
    );
  });

  test("fires on rejectUnauthorized: false", () => {
    expectFires(
      "no-disabled-tls-verification",
      `import https from "node:https";
       export const get = (url) => https.get(url, { rejectUnauthorized: false });`,
    );
  });

  test("fires on NODE_TLS_REJECT_UNAUTHORIZED = '0'", () => {
    expectFires(
      "no-disabled-tls-verification",
      `process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";`,
    );
  });
});

describe("require-secure-cookie-flags", () => {
  test("silent when both flags are set", () => {
    expectSilent(
      "require-secure-cookie-flags",
      `export const login = (req, res) =>
         res.cookie("session", req.body.id, { httpOnly: true, secure: true, sameSite: "lax" });`,
    );
  });

  test("silent for a non-auth cookie name", () => {
    expectSilent(
      "require-secure-cookie-flags",
      `export const theme = (req, res) => res.cookie("theme", "dark");`,
    );
  });

  test("fires when an auth cookie has no options", () => {
    expectFires(
      "require-secure-cookie-flags",
      `export const login = (req, res) => res.cookie("session", req.body.id);`,
    );
  });

  test("fires when secure is missing", () => {
    expectFires(
      "require-secure-cookie-flags",
      `export const login = (req, res) => res.cookie("jwt", token, { httpOnly: true });`,
    );
  });
});
