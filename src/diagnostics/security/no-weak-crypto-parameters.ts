import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getStaticStringValue } from "../../core/ast.ts";

/**
 * §7 — a cryptographic parameter set below the floor, in a literal.
 *
 * Two options, both written as constants, both weakening something that was
 * already correct by default. Neither produces an error, a warning, or a failing
 * test — the handshake completes, the key generates, and the weakness is
 * invisible until somebody looks at the parameter.
 *
 * **A TLS version below Node's own default.** Verified against the runtime:
 * `tls.DEFAULT_MIN_VERSION` is `TLSv1.2`, and Node **accepts a downgrade to
 * TLSv1 or TLSv1.1 without complaint**.
 *
 *   ❌ https.createServer({ minVersion: "TLSv1" }, app)
 *   ❌ new https.Agent({ secureProtocol: "TLSv1_method" })
 *   ✅ https.createServer({}, app)                    // TLSv1.2, by default
 *   ✅ https.createServer({ minVersion: "TLSv1.2" }, app)
 *
 * TLS 1.0 and 1.1 were deprecated outright by RFC 8996 in 2021; every major
 * browser removed them in 2020. Re-enabling one is normally done to accommodate
 * a single legacy client and then forgotten, and it downgrades **every**
 * connection, not that one.
 *
 * **An RSA modulus below 2048 bits.** Also verified: Node generates a 512-bit
 * key without objecting, so nothing in the stack will tell you.
 *
 *   ❌ generateKeyPair("rsa", { modulusLength: 1024 }, cb)
 *   ✅ generateKeyPair("rsa", { modulusLength: 2048 }, cb)
 *
 * PRECISION MODEL. Both are literal options, so nothing is inferred:
 *
 *   - The value must be a LITERAL. `minVersion: cfg.tlsMin` and
 *     `modulusLength: bits` are not folded — a configured value is the config's
 *     business.
 *   - `TLSv1.2` and `TLSv1.3` are fine and are never reported; so is any
 *     modulus of 2048 or more.
 *   - The two claims rest on different ground, and the messages say so. The TLS
 *     one is a fact about THIS runtime — it is below the default Node itself
 *     ships. The RSA floor is a standards floor (NIST SP 800-57 retired 1024-bit
 *     RSA in 2013) rather than something Node enforces, and it is reported as
 *     that rather than as a runtime error.
 */

/** TLS versions below Node's own `DEFAULT_MIN_VERSION` of TLSv1.2. */
const DOWNGRADED_VERSIONS = new Set(["TLSv1", "TLSv1.0", "TLSv1.1"]);

/**
 * Legacy `secureProtocol` strings. This is OpenSSL's older API, where the value
 * names an exact method rather than a floor.
 */
const LEGACY_PROTOCOLS = /^(SSLv2|SSLv3|TLSv1|TLSv1_1)_(client_|server_)?method$/;

/** Below this, the modulus is under every standard's floor. */
const MIN_RSA_BITS = 2048;

/** Key types whose `modulusLength` is the security parameter. */
const MODULUS_KEY_TYPES = new Set(["rsa", "rsa-pss", "dsa"]);

export const noWeakCryptoParameters = defineDiagnostic({
  id: "no-weak-crypto-parameters",
  title: "Cryptographic parameter set below the accepted floor",
  severity: "error",
  category: "Security",
  confidence: "high",
  tags: ["security", "crypto", "tls"],
  recommendation:
    "Leave `minVersion` unset — Node already defaults to TLSv1.2 — or set it to `TLSv1.2`/`TLSv1.3`. For key generation use a modulus of at least 2048 bits. Both of these are silent when wrong: the handshake completes and the key generates, so nothing fails until somebody reads the parameter.",
  create: (ctx) => {
    /** Report each offending property once, wherever the options object sits. */
    const checkOptions = (options: AstNode): void => {
      const properties = (options.properties as AstNode[] | undefined) ?? [];
      let keyType: string | null = null;

      for (const prop of properties) {
        if (prop.type !== "Property" || prop.computed) continue;
        const key = prop.key as AstNode | undefined;
        const name = key?.type === "Identifier" ? (key.name as string) : getStaticStringValue(key);
        if (name === "type") keyType = getStaticStringValue(prop.value as AstNode);
      }

      for (const prop of properties) {
        if (prop.type !== "Property" || prop.computed) continue;
        const key = prop.key as AstNode | undefined;
        const name = key?.type === "Identifier" ? (key.name as string) : getStaticStringValue(key);
        const value = prop.value as AstNode | undefined;
        if (!name || !value) continue;

        if (name === "minVersion") {
          const version = getStaticStringValue(value);
          if (version !== null && DOWNGRADED_VERSIONS.has(version)) {
            ctx.report(
              value,
              `\`${version}\` is below \`tls.DEFAULT_MIN_VERSION\`, which this runtime reports as \`TLSv1.2\` — and Node accepts the downgrade without complaint, so nothing fails. TLS 1.0 and 1.1 were deprecated by RFC 8996 and dropped by every major browser in 2020. This weakens EVERY connection, not just the legacy client it was added for; drop the option and take Node's default.`,
            );
          }
          continue;
        }

        if (name === "secureProtocol") {
          const protocol = getStaticStringValue(value);
          if (protocol !== null && LEGACY_PROTOCOLS.test(protocol)) {
            ctx.report(
              value,
              `\`${protocol}\` pins an exact legacy protocol through OpenSSL's older API, below Node's own default of \`TLSv1.2\`. Use \`minVersion\`/\`maxVersion\` instead, or drop the option entirely — the default is already correct.`,
            );
          }
          continue;
        }

        if (name === "modulusLength") {
          // Only when the key type is one whose modulus IS the parameter, or
          // when it is not stated (RSA is `generateKeyPair`'s common case).
          if (keyType !== null && !MODULUS_KEY_TYPES.has(keyType.toLowerCase())) continue;
          if (value.type !== "Literal" || typeof value.value !== "number") continue;
          const bits = value.value as number;
          if (bits >= MIN_RSA_BITS) continue;
          ctx.report(
            value,
            `A ${bits}-bit modulus is below the 2048-bit floor every standard has held since NIST SP 800-57 retired 1024-bit RSA in 2013. Node does **not** object — verified, it generates a 512-bit key without error — so nothing in the stack will tell you. Use at least 2048.`,
          );
        }
      }
    };

    return {
      ObjectExpression: (node) => {
        // Only judge an object that is an ARGUMENT: a standalone literal with a
        // `minVersion` key is a config fixture, not a live TLS context.
        const parent = node.parent as AstNode | undefined;
        if (parent?.type !== "CallExpression" && parent?.type !== "NewExpression") return;
        if (!((parent.arguments as AstNode[] | undefined) ?? []).includes(node)) return;
        checkOptions(node);
      },
    };
  },
});
