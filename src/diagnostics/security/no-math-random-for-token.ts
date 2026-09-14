import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getCalleeName, securityValueName } from "../../core/ast.ts";

/**
 * `Math.random()` used to produce a security value. `Math.random()` is a fast,
 * seedable, non-cryptographic PRNG: its output is predictable, so a token, OTP,
 * session id, or nonce built from it can be guessed or reproduced by an attacker.
 * Security material must come from a CSPRNG.
 *
 * ❌ const token = Math.random().toString(36).slice(2);
 * ❌ function generateOtp() { return Math.floor(Math.random() * 1e6); }
 * ✅ const token = crypto.randomBytes(32).toString("hex");
 * ✅ const jitter = Math.random() * 100;   // non-security randomness — silent
 *
 * Fires when: `Math.random()` flows into a security-shaped binding or sits inside
 * a security-shaped function. Stays silent for jitter/sampling/animation.
 *
 * The "is this security material?" question lives in `securityValueName`, shared
 * with `no-predictable-security-token` — a value one rule treats as a token must
 * not be invisible to the next.
 */

export const noMathRandomForToken = defineDiagnostic({
  id: "no-math-random-for-token",
  title: "Math.random() used for a security token",
  severity: "error",
  category: "Security",
  tags: ["crypto", "secrets"],
  recommendation:
    "Use a CSPRNG: `crypto.randomBytes(n)` / `crypto.randomUUID()` / `crypto.randomInt()`. `Math.random()` is predictable, so any token, OTP, or session id derived from it can be guessed.",
  create: (ctx) => ({
    CallExpression: (node) => {
      if (getCalleeName(node) !== "Math.random") return;

      const security = securityValueName(node);
      if (security === null) return;
      ctx.report(
        node,
        security.via === "binding"
          ? `\`Math.random()\` feeds the security value \`${security.name}\` — its output is predictable and can be guessed.`
          : `\`Math.random()\` is used inside \`${security.name}\` to build security material — use a CSPRNG instead.`,
      );
    },
  }),
});
