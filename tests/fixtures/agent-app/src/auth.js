import jwt from "jsonwebtoken";
import crypto from "node:crypto";

// BUG: no-weak-hash-for-password — MD5 is GPU-crackable.
export function hashPassword(password) {
  return crypto.createHash("md5").update(password).digest("hex");
}

// BUG: no-jwt-decode-as-verify — trusts unsigned claims for authz.
export function authorize(req, res, next) {
  const claims = jwt.decode(req.headers.authorization);
  if (claims.role !== "admin") {
    return res.status(403).end();
  }
  next();
}

// BUG: no-timing-unsafe-secret-compare — leaks a prefix oracle.
export function checkSignature(signature, expectedSignature) {
  return signature === expectedSignature;
}
