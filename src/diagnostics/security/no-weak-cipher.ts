import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, getStaticStringValue } from "../../core/ast.ts";

/**
 * A weak or misused symmetric cipher. DES/3DES and RC4 are broken; ECB mode
 * leaks plaintext structure (identical blocks encrypt identically); and the
 * deprecated `createCipher`/`createDecipher` derive the key/IV from a password
 * with no salt and no explicit IV. Any of these undermines confidentiality.
 *
 * ❌ crypto.createCipheriv("des-ede3-cbc", key, iv);
 * ❌ crypto.createCipheriv("aes-128-ecb", key, null);
 * ❌ crypto.createCipher("aes-256-cbc", password);   // deprecated, no IV
 * ✅ crypto.createCipheriv("aes-256-gcm", key, iv);   // authenticated — silent
 *
 * Fires when: a weak algorithm string (DES/RC4/ECB) is named, or the no-IV
 * `createCipher`/`createDecipher` API is used at all.
 */

const CIPHER_IV_METHODS = new Set(["createCipheriv", "createDecipheriv"]);
const CIPHER_NOIV_METHODS = new Set(["createCipher", "createDecipher"]);
const WEAK_ALGO_RE = /(^|[^a-z])(des|rc4)([^a-z]|$)|ecb/i;

export const noWeakCipher = defineDiagnostic({
  id: "no-weak-cipher",
  title: "Weak or insecure cipher",
  severity: "error",
  category: "Security",
  tags: ["crypto"],
  recommendation:
    "Use an authenticated cipher with a random IV: `crypto.createCipheriv('aes-256-gcm', key, iv)`. DES/3DES and RC4 are broken, ECB leaks structure, and `createCipher` derives keys insecurely.",
  create: (ctx) => ({
    CallExpression: (node) => {
      const method = getMethodName(node);
      if (!method) return;

      // Deprecated, IV-less API — insecure regardless of algorithm.
      if (CIPHER_NOIV_METHODS.has(method)) {
        ctx.report(node, `\`${method}\` is deprecated and derives the key/IV insecurely (no salt, no explicit IV) — use \`createCipheriv\` with \`aes-256-gcm\` and a random IV.`);
        return;
      }

      // IV-based API — flag only weak algorithm names.
      if (CIPHER_IV_METHODS.has(method)) {
        const algo = getStaticStringValue((node.arguments as AstNode[])[0]);
        if (algo && WEAK_ALGO_RE.test(algo)) {
          ctx.report(node, `Weak cipher \`${algo}\` — DES/RC4 are broken and ECB leaks plaintext structure. Use an authenticated mode such as aes-256-gcm.`);
        }
      }
    },

    // A `{ algorithm: "<weak>" }` config property (e.g. custom crypto wrappers).
    Property: (node) => {
      if (node.computed) return;
      const key = node.key;
      const keyName = key?.type === "Identifier" ? key.name : key?.type === "Literal" ? key.value : null;
      if (keyName !== "algorithm") return;
      const algo = getStaticStringValue(node.value);
      if (algo && WEAK_ALGO_RE.test(algo)) {
        ctx.report(node.value, `Weak cipher algorithm \`${algo}\` configured — DES/RC4/ECB are insecure. Use aes-256-gcm with a random IV.`);
      }
    },
  }),
});
