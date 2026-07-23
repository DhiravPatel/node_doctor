import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noNondeterministicStableKey } from "../../src/diagnostics/security/no-nondeterministic-stable-key.ts";

/**
 * These tests import the diagnostic directly and lint against it, rather than
 * going through the id-based registry helpers — the registry is a generated file
 * the orchestrator regenerates, so a self-contained test passes both before and
 * after wiring.
 */
const CAPS = new Set(["node", "esm", "typescript", "express"]);
const findings = (src: string): string[] => {
  const { findings: f } = lintSource({
    filePath: "test.ts",
    sourceText: src,
    diagnostics: [noNondeterministicStableKey],
    capabilities: CAPS,
  });
  return f.map((x) => x.message);
};
const fires = (src: string): void => {
  const f = findings(src);
  assert.ok(f.length > 0, `expected FIRE, got 0 on:\n${src}`);
};
const silent = (src: string): void => {
  const f = findings(src);
  assert.equal(f.length, 0, `expected SILENT, got ${f.length}:\n${f.join("\n")}\n--- src ---\n${src}`);
};

describe("no-nondeterministic-stable-key", () => {
  // --- required cases: RANDOM into a stable-key sink FIRES -------------------
  test("Math.random() into hmac.update FIRES", () => {
    fires(
      `import crypto from "crypto";
       const h = crypto.createHmac("sha256", key);
       h.update(userId + Math.random());
       const sig = h.digest("hex");`,
    );
  });

  test("Math.random() into cache.set key FIRES", () => {
    fires("await redis.set(`job:${Math.random()}`, payload);");
  });

  test("Math.random() into a token/filename SILENT", () => {
    silent("const token = Math.random().toString(36).slice(2);");
    silent("const f = `/tmp/${Date.now()}.log`; fs.writeFileSync(f, x);");
  });

  test("a static key SILENT", () => {
    silent(
      `const h = crypto.createHmac("sha256", key);
       h.update(userId + ":" + amount);`,
    );
    silent(`cache.set("user:" + userId, val);`);
  });

  // --- further coverage: every sink, RANDOM source --------------------------
  test("chained createHash().update() FIRES on the random hop", () => {
    fires(`crypto.createHash("sha256").update("a").update(Math.random()).digest("hex");`);
  });

  test("cache.set with a Math.random() key FIRES", () => {
    fires("cache.set(`u:${Math.random()}`, val);");
  });

  test("idempotencyKey object property from randomUUID() FIRES", () => {
    fires("const opts = { idempotencyKey: crypto.randomUUID(), amount: 10 };");
  });

  test("obj.idempotencyKey assignment from randomUUID() FIRES", () => {
    fires(`req.headers.idempotencyKey = crypto.randomUUID();`);
  });

  test("cacheKey resolved through a one-hop random binding FIRES", () => {
    fires("const r = Math.random(); const o = { cacheKey: 'k' + r };");
  });

  test("etag from Math.random() FIRES", () => {
    fires("res.etag = Math.random();");
  });

  test("bare randomUUID() (destructured import) into hmac.update FIRES", () => {
    fires(
      `const h = crypto.createHmac("sha256", k);
       h.update(String(randomUUID()));`,
    );
  });

  // --- TIME and process.pid are deliberately SILENT (precision-first) --------
  // A timestamp in a stable-key sink is usually a signed or time-bucketed value,
  // not a bug, and the two cannot be told apart from one file — see the rule
  // header. These lock in that the fixed false positives stay fixed.
  test("signed-request timestamp: Date.now() into hmac.update SILENT", () => {
    silent(
      `const ts = Date.now();
       const h = crypto.createHmac("sha256", secret);
       h.update(ts + "." + body);
       res.setHeader("X-Timestamp", String(ts));`,
    );
  });

  test("time-bucketed cache key SILENT", () => {
    silent("cache.set(`metrics:${Math.floor(Date.now()/60000)}`, data);");
  });

  test("fixed-window rate-limit key SILENT", () => {
    silent("redis.set(`rl:${userId}:${Math.floor(Date.now()/1000)}`, count);");
  });

  test("raw Date.now() cache key SILENT (time is never a source)", () => {
    silent(`cache.set("u:" + Date.now(), val);`);
  });

  test("process.pid / hrtime / performance.now into a stable key SILENT", () => {
    silent(`req.headers.idempotencyKey = process.pid + "-x";`);
    silent(`const h = crypto.createHmac("sha256", k); h.update(String(process.hrtime()[0]));`);
    silent("res.etag = performance.now();");
  });

  // --- silence: nondeterminism that SHOULD vary -----------------------------
  test("setTimeout jitter SILENT", () => {
    silent("setTimeout(fn, 1000 + Math.random() * 500);");
  });

  test("log line with a timestamp SILENT", () => {
    silent(`logger.info("done at " + Date.now());`);
  });

  test("an ORM .update() call SILENT (receiver is not a hash object)", () => {
    silent("await User.update({ lastSeen: Date.now() }, { where: { id } });");
  });

  test("Map.set() SILENT (receiver is not a cache/redis)", () => {
    silent("const m = new Map(); m.set(Date.now(), v);");
  });

  test("redis.set with a stable key but a timestamp VALUE SILENT", () => {
    silent(`redis.set("user:" + id, Date.now());`);
  });

  test("idempotencyKey from a stable payload field SILENT", () => {
    silent("const o = { idempotencyKey: req.body.key };");
  });

  test("static etag SILENT", () => {
    silent(`res.etag = '"' + contentHash + '"';`);
  });
});
