import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { staticMemberPath } from "../../core/ast.ts";

/**
 * TLS certificate verification turned off. `rejectUnauthorized: false` (on an
 * https/tls/agent options object) and `NODE_TLS_REJECT_UNAUTHORIZED = '0'` both
 * make the client accept ANY certificate — expired, self-signed, or an attacker's
 * — which silently defeats TLS and enables a man-in-the-middle to read and modify
 * every request.
 *
 * ❌ https.get(url, { rejectUnauthorized: false });
 * ❌ process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
 * ✅ https.get(url, { ca: fs.readFileSync("corp-ca.pem") });   // trust a real CA
 *
 * Fires when: verification is explicitly disabled. Stays silent otherwise.
 */

export const noDisabledTlsVerification = defineDiagnostic({
  id: "no-disabled-tls-verification",
  title: "TLS certificate verification disabled",
  severity: "error",
  category: "Security",
  tags: ["crypto", "network"],
  recommendation:
    "Keep verification on. If the peer uses a private CA, provide it via the `ca` option (`{ ca: fs.readFileSync('ca.pem') }`) instead of disabling verification. `rejectUnauthorized: false` accepts any certificate and enables man-in-the-middle.",
  create: (ctx) => ({
    Property: (node) => {
      if (node.computed) return;
      const key = node.key;
      const keyName = key?.type === "Identifier" ? key.name : key?.type === "Literal" ? key.value : null;
      if (keyName !== "rejectUnauthorized") return;
      if (node.value?.type === "Literal" && node.value.value === false) {
        ctx.report(node, "`rejectUnauthorized: false` disables TLS certificate verification — the client will accept any certificate, enabling man-in-the-middle.");
      }
    },

    AssignmentExpression: (node) => {
      if (staticMemberPath(node.left) !== "process.env.NODE_TLS_REJECT_UNAUTHORIZED") return;
      const right = node.right;
      const disabled =
        right?.type === "Literal" && (right.value === "0" || right.value === 0);
      if (disabled) {
        ctx.report(node, "Setting `NODE_TLS_REJECT_UNAUTHORIZED = '0'` disables TLS verification process-wide — every HTTPS connection becomes vulnerable to man-in-the-middle.");
      }
    },
  }),
});
