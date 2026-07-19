import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import argon2 from "argon2";
import { JWT_SECRET } from "./config.js";

// Slow, salted, memory-hard KDF — correct for passwords.
export async function hashPassword(password) {
  return argon2.hash(password);
}

export async function checkPassword(password, hash) {
  return argon2.verify(hash, password);
}

// Constant-time comparison after a length check.
export function verifyApiKey(provided, expected) {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Signature IS verified before the claims are trusted.
export function isAdmin(token) {
  const claims = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
  return claims.role === "admin";
}
