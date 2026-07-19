import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { staticMemberPath } from "../../core/ast.ts";

/**
 * A secret-shaped environment variable with a hardcoded fallback value.
 * `process.env.JWT_SECRET || "dev-secret"` is *worse* than a plain hardcoded
 * secret: it works in every environment, so nothing fails loudly and production
 * silently signs tokens with a value anyone can read off the repository.
 *
 * ❌ const JWT_SECRET = process.env.JWT_SECRET || "super-secret-dev-key-123";
 * ✅ if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is required");
 * ✅ const port = process.env.PORT || "3000";        // not secret-shaped
 * ✅ const key = process.env.API_KEY || "changeme";  // obvious placeholder
 */

const SECRET_NAME_RE =
  /(SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|SIGNING[_-]?KEY|ENCRYPTION[_-]?KEY|CLIENT[_-]?SECRET|ACCESS[_-]?KEY|CREDENTIAL|AUTH[_-]?TOKEN)/i;
const PLACEHOLDER_RE =
  /^(changeme|change[-_]me|x{2,}|todo|placeholder|example|dummy|test|dev|none|null|undefined|your[-_ ].*|<.*>|\.\.\.|secret|password)$/i;

const envVarName = (node: AstNode | null | undefined): string | null => {
  if (!node) return null;
  const path = staticMemberPath(node);
  if (!path) return null;
  const prefix = "process.env.";
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
};

export const secretInEnvFallback = defineDiagnostic({
  id: "secret-in-env-fallback",
  title: "Secret env var with a hardcoded fallback",
  severity: "error",
  category: "Security",
  tags: ["secrets", "auth"],
  recommendation:
    "Fail fast at boot instead of degrading silently: `if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required')`. A `|| \"fallback\"` ships a working key that anyone can read from source.",
  create: (ctx) => ({
    LogicalExpression: (node) => {
      if (node.operator !== "||" && node.operator !== "??") return;

      const name = envVarName(node.left);
      if (!name || !SECRET_NAME_RE.test(name)) return;

      const right = node.right;
      if (right.type !== "Literal" || typeof right.value !== "string") return;
      const value = right.value;
      if (value.length < 8) return; // too short to be a real credential
      if (PLACEHOLDER_RE.test(value.trim())) return;

      ctx.report(
        node,
        `\`process.env.${name}\` falls back to a hardcoded secret — it works everywhere and never fails loudly, so production silently uses a value committed to source.`,
      );
    },
  }),
});
