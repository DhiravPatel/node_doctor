/**
 * Logging and caching diagnostics (FEATURE.md §21, §16).
 *
 * These drive `lintSource` with the diagnostic module directly rather than
 * `tests/helpers.ts`, so the suite is independent of the generated registry.
 * The bulk of the coverage is the SILENT half: for `no-sensitive-data-in-logs`
 * a false positive would train people to ignore the rule, and the string-literal
 * cases ("password reset requested") are the ones that must never fire.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import type { Diagnostic, Finding } from "../../src/core/types.ts";
import { noSensitiveDataInLogs } from "../../src/diagnostics/security/no-sensitive-data-in-logs.ts";
import { noCacheWithoutTtl } from "../../src/diagnostics/reliability/no-cache-without-ttl.ts";

const findingsFor = (diagnostic: Diagnostic, source: string): Finding[] =>
  lintSource({
    filePath: "test.ts",
    sourceText: source,
    diagnostics: [diagnostic],
    capabilities: new Set(["node", "esm"]),
  }).findings.filter((f) => f.diagnostic === diagnostic.id);

const fires = (diagnostic: Diagnostic, source: string): Finding[] => {
  const found = findingsFor(diagnostic, source);
  assert.ok(found.length > 0, `expected ${diagnostic.id} to FIRE on:\n${source}`);
  return found;
};

const silent = (diagnostic: Diagnostic, source: string): void => {
  const found = findingsFor(diagnostic, source);
  assert.equal(
    found.length,
    0,
    `expected ${diagnostic.id} to STAY SILENT, got ${found.length}:\n` +
      found.map((f) => `  - ${f.message} @ ${f.line}:${f.column}`).join("\n") +
      `\n--- source ---\n${source}`,
  );
};

// ---------------------------------------------------------------------------
// no-sensitive-data-in-logs
// ---------------------------------------------------------------------------

describe("no-sensitive-data-in-logs", () => {
  test("fires on a password passed to console.log", () => {
    fires(noSensitiveDataInLogs, `console.log("user login", password);`);
  });
  test("fires on a member access whose last segment is sensitive", () => {
    fires(noSensitiveDataInLogs, `console.error(user.password);`);
  });
  test("fires on a structured-logger payload carrying a token", () => {
    fires(noSensitiveDataInLogs, `logger.info({ userId, accessToken }, "issued");`);
  });
  test("fires on a nested payload carrying a session token", () => {
    fires(noSensitiveDataInLogs, `logger.info({ meta: { sessionToken } });`);
  });

  /**
   * Bare `token`, `sessionId` and `credentials` are deliberately NOT credential
   * names. Each produced a verified false positive on real code: a CSS/JS lexer
   * token (`for (const token of tokenize(css)) logger.debug({ token })`), a
   * session id logged for request correlation — which is what it is for — and a
   * WebAuthn/provider `credentials` descriptor. The qualified forms above carry
   * the auth signal that the bare words do not.
   */
  test("silent on the ambiguous bare names that caused false positives", () => {
    silent(noSensitiveDataInLogs, `for (const token of tokenize(css)) { logger.debug({ token }); }`);
    silent(noSensitiveDataInLogs, `logger.debug(\`Deleting transport for \${sessionId}\`);`);
    silent(noSensitiveDataInLogs, `this.logger.warn("blocked", { nodeCredentials: node.credentials });`);
  });
  test("fires on request credential objects", () => {
    fires(noSensitiveDataInLogs, `console.debug(req.headers.authorization);`);
    fires(noSensitiveDataInLogs, `logger.warn(req.body.password);`);
    fires(noSensitiveDataInLogs, `console.log(req.headers["authorization"]);`);
  });
  test("fires on template interpolation of a credential", () => {
    fires(noSensitiveDataInLogs, "console.debug(`auth=${req.headers.authorization}`);");
  });
  test("fires on string concatenation with a credential", () => {
    fires(noSensitiveDataInLogs, `console.log("token: " + accessToken);`);
  });
  test("fires on pino/winston/bunyan and this.logger receivers", () => {
    fires(noSensitiveDataInLogs, `pino.info(secret);`);
    fires(noSensitiveDataInLogs, `winston.error(apiKey);`);
    fires(noSensitiveDataInLogs, `bunyan.warn(refreshToken);`);
    fires(noSensitiveDataInLogs, `this.logger.error("failed", apiToken);`);
    fires(noSensitiveDataInLogs, `log.debug(process.env.API_KEY);`);
  });
  test("reports the credential name in the message", () => {
    const [finding] = fires(noSensitiveDataInLogs, `console.log("login", password);`);
    assert.match(finding.message, /`password`/);
    assert.equal(finding.confidence, "high");
    assert.equal(finding.severity, "warn");
  });
  test("reports once per log call", () => {
    assert.equal(findingsFor(noSensitiveDataInLogs, `console.log(password, token);`).length, 1);
  });

  // --- the silent half -----------------------------------------------------

  test("silent on a presence/boolean check", () => {
    silent(noSensitiveDataInLogs, `console.log("has token:", !!token);`);
    silent(noSensitiveDataInLogs, `console.log(Boolean(password));`);
    silent(noSensitiveDataInLogs, `logger.info({ hasToken: Boolean(token) });`);
    silent(noSensitiveDataInLogs, `console.log(token ? "present" : "absent");`);
    silent(noSensitiveDataInLogs, `console.log(token === expected);`);
  });
  test("silent on a string literal that merely mentions a secret", () => {
    silent(noSensitiveDataInLogs, `console.log("password reset requested");`);
    silent(noSensitiveDataInLogs, `console.log("password reset requested for", userId);`);
    silent(noSensitiveDataInLogs, `console.log("token");`);
    silent(noSensitiveDataInLogs, `console.log("secret", "apiKey", "authorization");`);
    silent(noSensitiveDataInLogs, `logger.warn("missing authorization header");`);
    silent(noSensitiveDataInLogs, "console.log(`password reset for ${email}`);");
    silent(noSensitiveDataInLogs, `logger.info({ event: "password.reset", userId });`);
  });
  test("silent on a redacted, masked, hashed, or sanitized value", () => {
    silent(noSensitiveDataInLogs, `logger.info({ password: redact(password) });`);
    silent(noSensitiveDataInLogs, `logger.info({ token: mask(token) });`);
    silent(noSensitiveDataInLogs, `logger.info({ password: hash(pw) });`);
    silent(noSensitiveDataInLogs, `logger.info({ body: sanitize(req.body) });`);
    silent(noSensitiveDataInLogs, `logger.info({ password: "[REDACTED]" });`);
  });
  test("silent on a length or a type", () => {
    silent(noSensitiveDataInLogs, `console.log(token.length);`);
    silent(noSensitiveDataInLogs, `console.log(typeof token);`);
    silent(noSensitiveDataInLogs, "console.log(`len=${token.length}`);");
  });
  test("silent on names that merely contain a sensitive word", () => {
    silent(noSensitiveDataInLogs, `console.log("tokens processed", tokenCount);`);
    silent(noSensitiveDataInLogs, `console.log(tokenizer.name, nextPageToken, cancellationToken);`);
    silent(noSensitiveDataInLogs, `console.log(user.passwordHash, user.tokenBalance);`);
    silent(noSensitiveDataInLogs, `console.log("passwordless login", passwordless);`);
  });
  test("silent outside a log sink", () => {
    silent(noSensitiveDataInLogs, `res.json({ token });`);
    silent(noSensitiveDataInLogs, `db.set("token", token);`);
    silent(noSensitiveDataInLogs, `jwt.sign({ userId }, secret);`);
  });
  test("silent on an unresolvable dynamic access", () => {
    silent(noSensitiveDataInLogs, `logger.info(secrets[i]);`);
    silent(noSensitiveDataInLogs, `logger.info(config[key]);`);
  });
  test("silent on ordinary request logging", () => {
    silent(
      noSensitiveDataInLogs,
      `logger.info({ userId, requestId, method: req.method, path: req.path, durationMs });
       console.error("request failed", err);`,
    );
  });
});

// ---------------------------------------------------------------------------
// no-cache-without-ttl
// ---------------------------------------------------------------------------

describe("no-cache-without-ttl", () => {
  test("is opt-in", () => {
    assert.equal(noCacheWithoutTtl.defaultEnabled, false);
  });

  test("fires on a redis SET with no expiry", () => {
    fires(noCacheWithoutTtl, "await redis.set(`user:${id}`, JSON.stringify(user));");
    fires(noCacheWithoutTtl, `redisClient.set("k", "v");`);
    fires(noCacheWithoutTtl, `this.redis.set(k, v);`);
  });
  test("fires on a cache/memcached write with no ttl", () => {
    fires(noCacheWithoutTtl, `cache.set(key, value);`);
    fires(noCacheWithoutTtl, `memcached.set(k, v);`);
  });
  test("fires when options are passed but none is an expiry", () => {
    fires(noCacheWithoutTtl, `cache.set(key, value, { staleWhileRevalidate: true });`);
  });

  // --- the silent half -----------------------------------------------------

  test("silent on redis expiry modifiers", () => {
    silent(noCacheWithoutTtl, `redis.set(k, v, "EX", 60);`);
    silent(noCacheWithoutTtl, `redis.set(k, v, "PX", 1000);`);
    silent(noCacheWithoutTtl, `redis.set(k, v, "ex", ttlSeconds);`);
    silent(noCacheWithoutTtl, `redis.set(k, v, "NX", "EX", 60);`);
    silent(noCacheWithoutTtl, `redis.set(k, v, { EX: 60 });`);
    silent(noCacheWithoutTtl, `redis.set(k, v, "KEEPTTL");`);
  });
  test("silent on setex", () => {
    silent(noCacheWithoutTtl, `redis.setex(k, 60, v);`);
    silent(noCacheWithoutTtl, `redis.psetex(k, 60000, v);`);
  });
  test("silent on a ttl option object", () => {
    silent(noCacheWithoutTtl, `cache.set(k, v, { ttl: 300 });`);
    silent(noCacheWithoutTtl, `cache.set(k, v, { expiresIn: "1h" });`);
    silent(noCacheWithoutTtl, `cache.set(k, v, { maxAge: 60_000 });`);
    silent(noCacheWithoutTtl, `cache.set(k, v, { ...defaults });`);
  });
  test("silent on a positional lifetime or unresolvable options", () => {
    silent(noCacheWithoutTtl, `cache.set(k, v, 300);`);
    silent(noCacheWithoutTtl, `memcached.set(k, v, 300, cb);`);
    silent(noCacheWithoutTtl, `cache.set(k, v, options);`);
    silent(noCacheWithoutTtl, `redis.set(k, v, ...args);`);
  });
  test("silent on reads and non-cache receivers", () => {
    silent(noCacheWithoutTtl, `redis.get(k);`);
    silent(noCacheWithoutTtl, `map.set(k, v);`);
    silent(noCacheWithoutTtl, `headers.set("content-type", "application/json");`);
    silent(noCacheWithoutTtl, `url.searchParams.set("page", "2");`);
    silent(noCacheWithoutTtl, `session.set("user", user);`);
  });
  test("silent when a cache-named receiver is a plain Map or Set", () => {
    silent(noCacheWithoutTtl, `const cache = new Map(); cache.set(k, v);`);
    silent(noCacheWithoutTtl, `const cache = new WeakMap(); cache.set(k, v);`);
    silent(noCacheWithoutTtl, `class S { private cache = new Map(); m() { this.cache.set(k, v); } }`);
    silent(noCacheWithoutTtl, `function f(cache: Map<string, number>) { cache.set(k, v); }`);
  });
  test("silent when the cache is bounded or given a default TTL at construction", () => {
    silent(noCacheWithoutTtl, `const cache = new LRUCache({ max: 500, ttl: 60_000 }); cache.set(k, v);`);
    silent(noCacheWithoutTtl, `const cache = new NodeCache({ stdTTL: 600 }); cache.set(k, v);`);
  });
});
