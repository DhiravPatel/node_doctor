import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, getStaticStringValue, getPropertyValue } from "../../core/ast.ts";

/**
 * A JWT verified or signed with the `none` algorithm. The `none` algorithm means
 * "no signature" — a token signed with `none` carries a valid-looking header and
 * an empty signature, so anyone can forge one and every claim becomes attacker
 * controlled. Accepting `none` on `verify` turns authentication off entirely.
 *
 * ❌ jwt.verify(token, key, { algorithms: ["RS256", "none"] });
 * ❌ jwt.sign(payload, key, { algorithm: "none" });
 * ✅ jwt.verify(token, key, { algorithms: ["RS256"] });
 *
 * Fires when: a `verify`/`sign` options object names `none` (any case) as the
 * algorithm or in the algorithms allowlist.
 * Stays silent when: only real algorithms (RS256, HS256, ES256, …) are listed.
 */

const isNoneString = (node: AstNode | null | undefined): boolean => {
  const v = getStaticStringValue(node);
  return v !== null && v.trim().toLowerCase() === "none";
};

export const noJwtNoneAlgorithm = defineDiagnostic({
  id: "no-jwt-none-algorithm",
  title: "JWT verified with the 'none' algorithm",
  severity: "error",
  category: "Security",
  tags: ["auth", "crypto"],
  requires: ["jsonwebtoken"],
  recommendation:
    "Never allow the `none` algorithm. Pin a specific allowlist, e.g. `jwt.verify(token, key, { algorithms: ['RS256'] })`, and sign with a real algorithm. `none` disables signature verification, so any token is accepted.",
  create: (ctx) => ({
    CallExpression: (node) => {
      const method = getMethodName(node);
      if (method !== "verify" && method !== "sign") return;

      // Scan the argument objects for an `algorithm`/`algorithms` naming `none`.
      for (const arg of (node.arguments as AstNode[]) ?? []) {
        if (!arg || arg.type !== "ObjectExpression") continue;

        // sign form: { algorithm: "none" }
        const algorithm = getPropertyValue(arg, "algorithm");
        if (isNoneString(algorithm)) {
          ctx.report(algorithm!, "JWT signed with the `none` algorithm — the token carries no signature and can be forged by anyone.");
          continue;
        }

        // verify form: { algorithms: [..., "none"] }
        const algorithms = getPropertyValue(arg, "algorithms");
        if (algorithms?.type === "ArrayExpression") {
          const noneEl = (algorithms.elements as (AstNode | null)[]).find((el) => isNoneString(el ?? undefined));
          if (noneEl) {
            ctx.report(noneEl, "JWT verification allows the `none` algorithm — signature verification is disabled and any token is accepted.");
          }
        }
      }
    },
  }),
});
