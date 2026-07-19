import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, getStaticStringValue, isLiteralTrue } from "../../core/ast.ts";

/**
 * `app.set("trust proxy", true)` tells Express to trust the *entire* chain of
 * `X-Forwarded-For` values as the client address. Since any client can send an
 * `X-Forwarded-For` header, `req.ip` becomes fully attacker-controlled: IP-based
 * rate limits, allow/deny lists, and audit logs can all be spoofed. The correct
 * value is the number of proxies actually in front of the app (a hop count), a
 * trusted subnet, or a predicate — never an unconditional `true`.
 *
 * ❌ app.set("trust proxy", true);
 * ✅ app.set("trust proxy", 1);                       // one proxy (e.g. the LB)
 * ✅ app.set("trust proxy", "loopback, 10.0.0.0/8");  // trusted subnets
 * ✅ app.set("trust proxy", (ip) => ip === "10.0.0.1");
 */

export const noTrustProxyTrue = defineDiagnostic({
  id: "no-trust-proxy-true",
  title: "Express trust proxy set to unconditional true",
  severity: "warn",
  category: "Security",
  requires: ["express"],
  tags: ["express", "auth"],
  recommendation:
    "Set `trust proxy` to the exact number of proxies in front of the app (e.g. `1`), a trusted subnet string, or a predicate function — not `true`. Trusting every hop lets any client spoof `X-Forwarded-For` and thus `req.ip`.",
  create: (ctx) => ({
    CallExpression: (node) => {
      if (getMethodName(node) !== "set") return;
      const args = (node.arguments as AstNode[]) ?? [];
      if (getStaticStringValue(args[0]) !== "trust proxy") return;
      if (!isLiteralTrue(args[1])) return; // a number / subnet / function is fine

      ctx.report(
        node,
        "`trust proxy` is set to `true`, trusting every proxy hop — any client can spoof `X-Forwarded-For` and forge `req.ip`, bypassing IP rate limits and allowlists.",
      );
    },
  }),
});
