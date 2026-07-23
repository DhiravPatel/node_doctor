import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, getReceiverName, unwrapChain } from "../../core/ast.ts";

/**
 * A credential written to a log sink by value. Logs leave the process: they are
 * shipped to a third-party aggregator, read by on-call engineers and
 * contractors, and retained for years. A password on a log line is a credential
 * leak with a very long tail, and it is invisible in code review because the
 * call looks like every other log line.
 *
 * Only VALUE references are flagged — never string content. A message that
 * *mentions* a secret ("password reset requested") is not a leak, and matching
 * on literal text is the single biggest false-positive source in this rule.
 * Booleans, presence checks, lengths, and redacting calls are all silent.
 *
 * ❌ console.log("user login", password);
 * ❌ logger.info({ userId, token }, "issued");
 * ❌ console.error(`auth=${req.headers.authorization}`);
 * ✅ console.log("password reset requested", userId);   // literal text, not a value
 * ✅ console.log("has token:", !!token);                 // presence, not the secret
 * ✅ logger.info({ password: redact(password) });        // redacted
 * ✅ console.log(token.length, typeof token);            // shape, not the secret
 */

/** Receivers whose log methods are log sinks. `this.logger` matches on `logger`. */
const LOG_RECEIVERS = new Set(["console", "logger", "log", "winston", "pino", "bunyan"]);

const LOG_METHODS = new Set(["log", "info", "warn", "error", "debug", "trace", "fatal"]);

/**
 * Sensitive names, matched EXACTLY after normalization (lowercase, `_`/`-`
 * stripped) — never as a substring. Substring matching would flag `tokenizer`,
 * `tokenCount`, `nextPageToken`, and `passwordless`, and one such false
 * positive costs more than every true positive this rule finds.
 */
/**
 * Only names that are unambiguously credential material.
 *
 * Deliberately EXCLUDED, each because it produced a verified false positive on
 * real code: bare `token` (a CSS/JS lexer token — `for (const token of
 * tokenize(css)) logger.debug({ token })`), `sessionId` (used as a map key and
 * logged for request correlation, which is its intended use), and
 * `credential`/`credentials` (WebAuthn `PublicKeyCredential`, a fetch
 * `credentials` mode, an OAuth provider descriptor). The qualified forms below
 * carry the auth signal that those bare words do not.
 */
const SENSITIVE_NAMES = new Set([
  "password",
  "passwd",
  "secret",
  "apikey",
  "apitoken",
  "accesstoken",
  "refreshtoken",
  "authtoken",
  "idtoken",
  "bearertoken",
  "sessiontoken",
  "sessionsecret",
  "privatekey",
  "authorization",
  "creditcard",
  "ssn",
  "cvv",
]);

const normalize = (name: string): string => name.toLowerCase().replace(/[_-]/g, "");

const isSensitiveName = (name: string | null | undefined): boolean =>
  !!name && SENSITIVE_NAMES.has(normalize(name));

/** Strip TS-only wrappers and optional chaining so `token as string` still resolves. */
const unwrap = (node: AstNode | null | undefined): AstNode | null => {
  let cur = unwrapChain(node);
  while (
    cur &&
    (cur.type === "TSAsExpression" ||
      cur.type === "TSNonNullExpression" ||
      cur.type === "TSSatisfiesExpression" ||
      cur.type === "TSTypeAssertion")
  ) {
    cur = unwrapChain(cur.expression as AstNode);
  }
  return cur;
};

/** The property name of a member access, when it is statically known. */
const propertyName = (node: AstNode): string | null => {
  const key = node.property as AstNode | undefined;
  if (!key) return null;
  if (!node.computed && key.type === "Identifier") return key.name;
  if (node.computed && key.type === "Literal" && typeof key.value === "string") return key.value;
  return null;
};

/**
 * Does this expression evaluate to a secret VALUE?
 *
 * Deliberately narrow: only bare identifiers, static member accesses, `+`
 * concatenation, template interpolation, and object-literal property values are
 * inspected. Anything else — a call, a comparison, a ternary, an index by a
 * variable — is treated as unknown and stays silent.
 */
const isSensitiveValue = (node: AstNode | null | undefined, depth = 0): boolean => {
  const n = unwrap(node);
  if (!n || depth > 4) return false;

  switch (n.type) {
    case "Identifier":
      return isSensitiveName(n.name);

    // Only the LAST segment counts: `user.password` leaks, `token.length` does not.
    case "MemberExpression":
      return isSensitiveName(propertyName(n));

    // `console.log("token=" + token)` — a concatenation dumps the value.
    case "BinaryExpression":
      return (
        n.operator === "+" &&
        (isSensitiveValue(n.left, depth + 1) || isSensitiveValue(n.right, depth + 1))
      );

    case "TemplateLiteral":
      // Quasis are text, never evidence — only the interpolated values are.
      return ((n.expressions as AstNode[]) ?? []).some((e) => isSensitiveValue(e, depth + 1));

    // The pino/winston shape: `logger.info({ userId, token }, "issued")`.
    case "ObjectExpression":
      return ((n.properties as AstNode[]) ?? []).some(
        (p) => p.type === "Property" && isSensitiveValue(p.value as AstNode, depth + 1),
      );

    default:
      // Calls (redact/mask/hash/Boolean/JSON.stringify), `!!token`, `typeof token`,
      // comparisons, ternaries: not a resolvable secret value. Stay silent.
      return false;
  }
};

/** A readable name for the leaked value, for the message. */
const describe = (node: AstNode | null | undefined, depth = 0): string | null => {
  const n = unwrap(node);
  if (!n || depth > 4) return null;
  switch (n.type) {
    case "Identifier":
      return isSensitiveName(n.name) ? n.name : null;
    case "MemberExpression":
      return isSensitiveName(propertyName(n)) ? propertyName(n) : null;
    case "BinaryExpression":
      return describe(n.left, depth + 1) ?? describe(n.right, depth + 1);
    case "TemplateLiteral":
      for (const e of (n.expressions as AstNode[]) ?? []) {
        const found = describe(e, depth + 1);
        if (found) return found;
      }
      return null;
    case "ObjectExpression":
      for (const p of (n.properties as AstNode[]) ?? []) {
        if (p.type !== "Property") continue;
        const found = describe(p.value as AstNode, depth + 1);
        if (found) return found;
      }
      return null;
    default:
      return null;
  }
};

export const noSensitiveDataInLogs = defineDiagnostic({
  id: "no-sensitive-data-in-logs",
  title: "Secret or credential written to a log",
  severity: "warn",
  category: "Security",
  tags: ["secrets", "logging", "info-leak"],
  confidence: "high",
  recommendation:
    "Never log the credential itself. Log a presence check or a fingerprint instead (`{ hasToken: Boolean(token) }`, `token.slice(-4)`), or run the payload through a redaction step — pino's `redact` option, or an explicit `redact()`/`mask()` helper.",
  create: (ctx) => ({
    CallExpression: (node) => {
      const method = getMethodName(node);
      if (!method || !LOG_METHODS.has(method)) return;

      // `console.error`, `logger.warn`, `this.logger.info` — the last receiver
      // segment is what identifies the sink.
      const receiver = getReceiverName(node);
      if (!receiver) return;
      const segments = receiver.split(".");
      const own = segments[segments.length - 1];
      if (!own || !LOG_RECEIVERS.has(normalize(own))) return;

      for (const arg of (node.arguments as AstNode[] | undefined) ?? []) {
        if (!isSensitiveValue(arg)) continue;
        const name = describe(arg) ?? "a credential";
        ctx.report(
          arg,
          `\`${name}\` is written to a log by value — logs are shipped to aggregators and retained for years, so this is a long-lived credential leak.`,
        );
        return; // one finding per log call
      }
    },
  }),
});
