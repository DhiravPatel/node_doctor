// BUG: secret-in-env-fallback — a committed signing key that works everywhere.
export const JWT_SECRET = process.env.JWT_SECRET || "super-secret-dev-key-123";

// BUG: no-unbounded-module-cache — written, never evicted.
const sessionCache = new Map();

export function remember(token, user) {
  sessionCache.set(token, user);
}
