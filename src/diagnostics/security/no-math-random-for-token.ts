import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getCalleeName, findEnclosingFunction, staticMemberPath } from "../../core/ast.ts";

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
 */

const SECURITY_RE =
  /(^|[._-])(token|secret|otp|nonce|salt|session|csrf|api[_-]?key|password|passwd|pwd)([._-]|$)|(session|auth|user|account)[_-]?id$/i;

/** Split camelCase so word boundaries are visible to the segment-aware regex. */
const isSecurityShaped = (name: string | null): boolean =>
  !!name && SECURITY_RE.test(name.replace(/([a-z0-9])([A-Z])/g, "$1_$2"));

/** A readable name for a function node (declaration, or assigned arrow/expr). */
const functionName = (fn: AstNode | null): string | null => {
  if (!fn) return null;
  if (fn.id?.type === "Identifier") return fn.id.name;
  const parent = fn.parent;
  if (!parent) return null;
  if (parent.type === "VariableDeclarator" && parent.id?.type === "Identifier") return parent.id.name;
  if (parent.type === "AssignmentExpression") {
    const path = staticMemberPath(parent.left);
    return path ? path.split(".").pop()! : null;
  }
  if ((parent.type === "Property" || parent.type === "MethodDefinition") && !parent.computed) {
    const key = parent.key;
    if (key?.type === "Identifier") return key.name;
    if (key?.type === "Literal" && typeof key.value === "string") return key.value;
  }
  return null;
};

/** The binding name Math.random() is assigned/returned into, if security-shaped. */
const targetName = (node: AstNode): string | null => {
  let cur: AstNode | null = node;
  let parent: AstNode | null | undefined = node.parent;
  // Walk up through wrapping expressions (member calls like .toString(), math ops).
  while (parent) {
    switch (parent.type) {
      case "VariableDeclarator":
        return parent.init === cur && parent.id?.type === "Identifier" ? parent.id.name : null;
      case "AssignmentExpression": {
        if (parent.right !== cur) return null;
        const path = staticMemberPath(parent.left);
        return path ? path.split(".").pop()! : null;
      }
      case "Property":
        if (parent.value === cur && !parent.computed) {
          const key = parent.key;
          if (key?.type === "Identifier") return key.name;
          if (key?.type === "Literal" && typeof key.value === "string") return key.value;
        }
        return null;
      case "CallExpression":
      case "MemberExpression":
      case "BinaryExpression":
      case "TemplateLiteral":
      case "ChainExpression":
        cur = parent;
        parent = parent.parent;
        continue;
      default:
        return null;
    }
  }
  return null;
};

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

      const name = targetName(node);
      if (isSecurityShaped(name)) {
        ctx.report(node, `\`Math.random()\` feeds the security value \`${name}\` — its output is predictable and can be guessed.`);
        return;
      }

      const fnName = functionName(findEnclosingFunction(node));
      if (isSecurityShaped(fnName)) {
        ctx.report(node, `\`Math.random()\` is used inside \`${fnName}\` to build security material — use a CSPRNG instead.`);
      }
    },
  }),
});
