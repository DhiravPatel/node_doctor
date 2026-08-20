import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getCalleeName, getMethodName } from "../../core/ast.ts";
import { isTestFile } from "../../core/test-file.ts";

/**
 * `createCipheriv` with an initialization vector that never changes.
 *
 *   ❌ crypto.createCipheriv("aes-256-cbc", key, "1234567812345678")
 *   ❌ crypto.createCipheriv("aes-256-gcm", key, Buffer.alloc(12))
 *   ✅ const iv = crypto.randomBytes(16);
 *      crypto.createCipheriv("aes-256-cbc", key, iv);   // store iv with the ciphertext
 *
 * An IV exists to make the same plaintext encrypt differently every time. Fix it
 * and the cipher becomes a deterministic function of the plaintext. MEASURED,
 * rather than asserted — the same key, the same plaintext, twice:
 *
 *   CBC, fixed IV:  2bb3f4f2bd6704d2e52480cca69d3ecf…
 *                   2bb3f4f2bd6704d2e52480cca69d3ecf…   identical
 *   CBC, random IV: different every time
 *
 * That leaks equality — an observer learns which records hold the same value,
 * which is enough to de-anonymise a column of statuses, salaries or IDs — and
 * because CBC chains block by block, two messages sharing a prefix share a
 * ciphertext prefix: measured, 32 identical hex characters for
 * `"transfer 100 to alice"` and `"transfer 100 to bob"`.
 *
 * For GCM and any counter mode it is worse than a leak, it is a break. Reusing a
 * nonce reuses the keystream, so `ct1 XOR ct2 == pt1 XOR pt2` exactly — measured:
 * both sides came out `030303030303030303030303`. Authentication falls with it,
 * because the authentication key can be recovered from two messages under one
 * nonce.
 *
 * FOUND IN THE CORPUS at three sites, all the same helper copied across a
 * monorepo's variants: a `static encrypt()` holding a hardcoded key AND a
 * hardcoded 16-character IV, so every value the application ever encrypts uses
 * the same pair. node.doctor reported nothing on that file before this rule —
 * `no-weak-cipher` judges the ALGORITHM, and `aes-256-cbc` is a fine algorithm.
 *
 * PRECISION MODEL. The IV must be provably constant: a literal, a
 * `Buffer.from(<literal>)`, a `Buffer.alloc(n)` (all zero bytes), or a `const`
 * binding initialised to one of those. Anything the file cannot decide —
 * a parameter, a call result, a property read — is silence.
 *
 *   - `crypto.randomBytes(…)` / `randomFillSync` are the correct form and are
 *     never reported, inline or through a binding.
 *   - Only ENCRYPTION is judged. `createDecipheriv` must be given the very IV the
 *     ciphertext was produced with, so a literal there is a consequence of the
 *     defect, not the defect.
 *   - A `null` IV is ECB, which is `no-weak-cipher`'s business, not this rule's.
 *   - Test and fixture files are excluded: a fixed IV is how you write a
 *     reproducible crypto test.
 */

/**
 * Test and fixture paths, alongside `isTestFile`.
 *
 * That helper demands proof — a runner import, or a test path AND real test
 * declarations — so a `.test.ts` holding only crypto helpers is correctly not
 * "provably a test". Here the path alone is enough: a fixed IV is exactly how you
 * write a reproducible crypto test.
 */
const TEST_OR_FIXTURE =
  /(^|[/\\])(__tests__|tests?|spec|fixtures?|mocks?)[/\\]|[.-](test|spec|fixture|mock)\.[cm]?[jt]sx?$/i;

/** Random sources that make an IV unique per message. */
const RANDOM_SOURCES = new Set(["randomBytes", "randomFillSync", "getRandomValues", "randomUUID"]);

/** Why this IV is constant, or null when it is not decidably constant. */
const constantIvReason = (
  node: AstNode | null | undefined,
  resolve: (name: string, from: AstNode) => AstNode | undefined,
  depth = 0,
): string | null => {
  if (!node || depth > 3) return null;

  if (node.type === "Literal") {
    // `null` is ECB — a different rule's subject.
    if (node.value === null) return null;
    if (typeof node.value === "string") return "a string literal";
    return null;
  }

  if (node.type === "TemplateLiteral") {
    return ((node.expressions as AstNode[] | undefined) ?? []).length === 0 ? "a template literal" : null;
  }

  if (node.type === "CallExpression") {
    const method = getMethodName(node) ?? getCalleeName(node);
    if (method !== null && RANDOM_SOURCES.has(method.split(".").pop() ?? method)) return null;
    const callee = node.callee as AstNode | undefined;
    if (callee?.type === "MemberExpression") {
      const object = callee.object as AstNode | undefined;
      const property = callee.property as AstNode | undefined;
      if (
        object?.type === "Identifier" &&
        String(object.name) === "Buffer" &&
        property?.type === "Identifier"
      ) {
        const name = String(property.name);
        const first = ((node.arguments as AstNode[] | undefined) ?? [])[0];
        // `Buffer.alloc(16)` is sixteen zero bytes — the most fixed IV there is.
        if (name === "alloc") return "`Buffer.alloc`, which is all zero bytes";
        if (name === "from" && first?.type === "Literal") return "`Buffer.from` of a literal";
      }
    }
    return null;
  }

  if (node.type === "Identifier") {
    const initializer = resolve(String(node.name), node);
    return constantIvReason(initializer, resolve, depth + 1);
  }

  return null;
};

export const noStaticCipherIv = defineDiagnostic({
  id: "no-static-cipher-iv",
  title: "Cipher initialization vector is the same every time",
  severity: "error",
  category: "Security",
  confidence: "high",
  tags: ["crypto", "encryption"],
  recommendation:
    "Generate the IV per message — `const iv = crypto.randomBytes(16)` — and store it alongside the ciphertext; it is not secret, only unique. A fixed IV makes the cipher deterministic, so equal plaintexts produce equal ciphertexts and shared prefixes stay shared. In GCM or any counter mode a repeated nonce repeats the keystream, which reveals the XOR of two plaintexts and lets the authentication key be recovered. If you genuinely need deterministic encryption for searching, use a construction designed for it (AES-SIV) rather than a fixed IV.",
  create: (ctx) => {
    const resolve = (name: string, from: AstNode): AstNode | undefined => {
      const binding = ctx.scope.getBinding(name, from);
      // Only a `const`: a `let` may hold a fresh IV by the time this runs.
      if (binding?.kind !== "const") return undefined;
      return binding.initNode as AstNode | undefined;
    };

    let inert: boolean | null = null;

    return {
      CallExpression: (node) => {
        const name = getMethodName(node) ?? getCalleeName(node);
        if (name === null || !name.endsWith("createCipheriv")) return;

        if (inert === null) {
          inert = isTestFile(ctx.program, ctx.normalizedFilePath) || TEST_OR_FIXTURE.test(ctx.normalizedFilePath);
        }
        if (inert) return;

        const iv = ((node.arguments as AstNode[] | undefined) ?? [])[2];
        if (!iv) return;
        const reason = constantIvReason(iv, resolve);
        if (reason === null) return;

        ctx.report(
          iv,
          `This initialization vector is ${reason}, so every encryption uses the same one and the cipher becomes deterministic — equal plaintexts produce byte-identical ciphertexts, and in CBC two messages sharing a prefix share a ciphertext prefix (measured: 32 identical hex characters). In GCM or a counter mode a repeated nonce repeats the keystream, so \`ct1 XOR ct2\` equals \`pt1 XOR pt2\` and authentication is broken outright. Generate it per message with \`crypto.randomBytes\` and store it with the ciphertext.`,
        );
      },
    };
  },
});
