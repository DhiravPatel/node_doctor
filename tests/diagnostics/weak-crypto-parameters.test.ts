/**
 * §7 — `no-weak-crypto-parameters`.
 *
 * Two literal options that weaken something already correct by default. Neither
 * produces an error, a warning, or a failing test — the handshake completes and
 * the key generates, so the weakness is invisible until somebody reads the
 * parameter.
 *
 * The two claims rest on DIFFERENT ground, and the tests pin both:
 *   - the TLS floor is a fact about this runtime (`tls.DEFAULT_MIN_VERSION`);
 *   - the RSA floor is a standards floor, and Node itself does not enforce it.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import tls from "node:tls";
import { generateKeyPairSync } from "node:crypto";
import { lintSource } from "../../src/core/scan.ts";
import { noWeakCryptoParameters } from "../../src/diagnostics/security/no-weak-crypto-parameters.ts";

const findings = (source: string) =>
  lintSource({
    filePath: "/repo/src/server.ts",
    sourceText: source,
    diagnostics: [noWeakCryptoParameters],
    capabilities: new Set(["node", "esm", "typescript"]),
  }).findings.filter((f) => f.diagnostic === "no-weak-crypto-parameters");

const fires = (source: string) => {
  const found = findings(source);
  assert.ok(found.length > 0, `expected a FIRE on:\n${source}`);
  return found;
};
const silent = (source: string): void =>
  assert.equal(findings(source).length, 0, `expected SILENCE on:\n${source}`);

describe("the premises, pinned as executable facts", () => {
  test("Node's own default minimum is TLSv1.2, and it accepts a downgrade silently", () => {
    assert.equal(tls.DEFAULT_MIN_VERSION, "TLSv1.2");
    // The whole point: nothing objects, so nothing tells you.
    assert.doesNotThrow(() => tls.createSecureContext({ minVersion: "TLSv1" }));
    assert.doesNotThrow(() => tls.createSecureContext({ minVersion: "TLSv1.1" }));
  });

  test("Node does NOT enforce an RSA floor", () => {
    // Which is why the standards floor has to come from the rule.
    assert.doesNotThrow(() => generateKeyPairSync("rsa", { modulusLength: 512 }));
  });
});

describe("no-weak-crypto-parameters — TLS", () => {
  test("a version below Node's default, and the message cites the runtime", () => {
    const [f] = fires(`https.createServer({ minVersion: "TLSv1" }, app);`);
    assert.match(f!.message, /DEFAULT_MIN_VERSION/);
    assert.match(f!.message, /RFC 8996/);
    assert.match(f!.message, /EVERY connection/);
  });

  test("every downgraded spelling", () => {
    fires(`https.createServer({ minVersion: "TLSv1.1" }, app);`);
    fires(`tls.connect({ minVersion: "TLSv1.0", host });`);
  });

  test("the legacy OpenSSL API pins an exact protocol", () => {
    fires(`new https.Agent({ secureProtocol: "TLSv1_method" });`);
    fires(`new https.Agent({ secureProtocol: "SSLv3_method" });`);
  });

  test("the default, and anything at or above it, is correct", () => {
    silent(`https.createServer({}, app);`);
    silent(`https.createServer({ minVersion: "TLSv1.2" }, app);`);
    silent(`https.createServer({ minVersion: "TLSv1.3" }, app);`);
    silent(`new https.Agent({ secureProtocol: "TLS_method" });`);
  });
});

describe("no-weak-crypto-parameters — key size", () => {
  test("a modulus below the standards floor, framed as a standards claim", () => {
    const [f] = fires(`generateKeyPair("rsa", { modulusLength: 1024 }, cb);`);
    assert.match(f!.message, /NIST SP 800-57/);
    assert.match(f!.message, /Node does \*\*not\*\* object/);
  });

  test("the type may be stated in the options object instead", () => {
    fires(`generateKeyPairSync("rsa", { modulusLength: 512 });`);
    fires(`generateKeyPair({ type: "rsa", modulusLength: 1024 }, cb);`);
  });

  test("2048 and above is fine", () => {
    silent(`generateKeyPair("rsa", { modulusLength: 2048 }, cb);`);
    silent(`generateKeyPair("rsa", { modulusLength: 4096 }, cb);`);
  });

  test("a key type whose modulus is not the security parameter", () => {
    silent(`generateKeyPair({ type: "ec", modulusLength: 256 }, cb);`);
  });
});

describe("no-weak-crypto-parameters — nothing is inferred", () => {
  test("a configured value is the config's business", () => {
    silent(`https.createServer({ minVersion: cfg.tlsMin }, app);`);
    silent(`generateKeyPair("rsa", { modulusLength: bits }, cb);`);
  });

  test("a standalone object literal is a fixture, not a live context", () => {
    // Only an object passed as an ARGUMENT is a TLS context or a key request.
    silent(`export const legacyProfile = { minVersion: "TLSv1" };`);
  });
});

describe("no-weak-crypto-parameters — determinism", () => {
  test("identical source yields identical findings", () => {
    const source = `https.createServer({ minVersion: "TLSv1" }, a);\ngenerateKeyPair("rsa", { modulusLength: 1024 }, b);`;
    assert.equal(JSON.stringify(findings(source)), JSON.stringify(findings(source)));
    assert.equal(findings(source).length, 2);
  });
});
