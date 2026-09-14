import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { isSensitiveName, normalizePropertyName } from "../../core/ast.ts";

/**
 * A credential put inside a JWT payload. A JWT is **signed, not encrypted**: the
 * payload is base64url text that anyone holding the token can read with no key
 * at all. Signing proves integrity — that nobody changed it — and says nothing
 * about confidentiality.
 *
 *   ❌ jwt.sign({ id, email, passwordHash }, secret);
 *   ❌ jwt.sign({ userId, apiKey: user.apiKey }, secret, { expiresIn: "1h" });
 *   ✅ jwt.sign({ sub: user.id, role: user.role }, secret, { expiresIn: "1h" });
 *
 * MEASURED against jsonwebtoken 9.0.3. Signing
 * `{ id, email, role, passwordHash, ssn }` with a server-side secret and then
 * decoding the middle segment **with no secret whatsoever**:
 *
 *   Buffer.from(token.split(".")[1], "base64url").toString("utf8")
 *   → {"id":"u1","email":"a@b.c","role":"admin",
 *      "passwordHash":"$2b$12$KIXQ9bT1s0eTk0Xz3mJ8Iu","ssn":"123-45-6789",
 *      "iat":1789371205,"exp":1789374805}
 *
 * `jwt.decode(token)` with no key returns the same object. The bcrypt hash and
 * the SSN are in the clear, in a string the browser stores in `localStorage` and
 * sends on every request — so they are also in every proxy log, every error
 * report, and every browser extension that reads storage.
 *
 * The hash is the worst of them. It is not the password, which is why a hash in a
 * LOG line is only a near-miss; but a hash handed to the person it belongs to is
 * an offline cracking target with unlimited attempts and no rate limit, and
 * `no-weak-password-hash-cost` exists precisely because that attack is cheap when
 * the cost factor is low.
 *
 * PRECISION MODEL. Both halves are literal, so nothing is inferred:
 *
 *   - The call must be `jwt.sign(…)` / a `sign` bound from `jsonwebtoken`. That
 *     library is the one measured, and the restriction matters: `jose` ships
 *     `EncryptJWT` alongside `SignJWT`, and a JWE payload really is encrypted, so
 *     a library-blind rule would report correct code. `jose` is a known gap
 *     rather than an oversight.
 *   - The payload must be an OBJECT LITERAL with a statically readable key that
 *     names a credential. `jwt.sign(user, secret)` is not reported — the rule
 *     cannot see `user`'s keys, and guessing would be the release-blocking
 *     direction. A spread (`{ ...user, role }`) hides keys the same way, so only
 *     the keys written out are judged, never the spread.
 *
 * The name list is the shared credential set, plus the names this rule is
 * STRICTER about than `no-sensitive-data-in-logs`: `passwordHash`,
 * `hashedPassword`, `passwordSalt`, `mfaSecret`, `totpSecret`, `recoveryCodes`,
 * `cardNumber`. The log rule deliberately treats a hash as a near-miss and pins
 * that in a test; this rule layers its extras on top rather than widening the
 * shared set, so that decision is left where it was made.
 */

/**
 * Names this rule treats as credentials that `no-sensitive-data-in-logs` does
 * not. A token is handed to the user and lives in their storage forever, so a
 * value that is merely untidy in a log is a real disclosure here.
 */
const TOKEN_ONLY_SENSITIVE = new Set([
  "passwordhash",
  "hashedpassword",
  "passwordsalt",
  "mfasecret",
  "totpsecret",
  "recoverycodes",
  "backupcodes",
  "cardnumber",
]);

const isTokenSensitive = (name: string): boolean =>
  isSensitiveName(name) || TOKEN_ONLY_SENSITIVE.has(normalizePropertyName(name));

/** Local names bound to `jsonwebtoken` — the namespace, and a destructured `sign`. */
const jsonwebtokenBindings = (program: AstNode): { namespaces: Set<string>; signs: Set<string> } => {
  const namespaces = new Set<string>();
  const signs = new Set<string>();
  const isJwt = (source: unknown): boolean => source === "jsonwebtoken";

  for (const statement of ((program.body as AstNode[] | undefined) ?? [])) {
    if (statement.type === "ImportDeclaration") {
      if (!isJwt((statement.source as AstNode | undefined)?.value)) continue;
      for (const specifier of ((statement.specifiers as AstNode[] | undefined) ?? [])) {
        const local = specifier.local as AstNode | undefined;
        if (local?.type !== "Identifier") continue;
        if (specifier.type === "ImportSpecifier") {
          const imported = specifier.imported as AstNode | undefined;
          if (imported?.type === "Identifier" && String(imported.name) === "sign") signs.add(String(local.name));
        } else {
          namespaces.add(String(local.name));
        }
      }
      continue;
    }
    if (statement.type !== "VariableDeclaration") continue;
    for (const declarator of ((statement.declarations as AstNode[] | undefined) ?? [])) {
      const init = declarator.init as AstNode | undefined;
      if (init?.type !== "CallExpression") continue;
      const callee = init.callee as AstNode | undefined;
      if (callee?.type !== "Identifier" || String(callee.name) !== "require") continue;
      const argument = ((init.arguments as AstNode[] | undefined) ?? [])[0];
      if (argument?.type !== "Literal" || !isJwt(argument.value)) continue;

      const id = declarator.id as AstNode | undefined;
      if (id?.type === "Identifier") {
        namespaces.add(String(id.name));
        continue;
      }
      if (id?.type !== "ObjectPattern") continue;
      for (const property of ((id.properties as AstNode[] | undefined) ?? [])) {
        if (property.type !== "Property" || property.computed) continue;
        const key = property.key as AstNode | undefined;
        const value = property.value as AstNode | undefined;
        if (key?.type === "Identifier" && String(key.name) === "sign" && value?.type === "Identifier") {
          signs.add(String(value.name));
        }
      }
    }
  }
  return { namespaces, signs };
};

/** The static key of an object property, or null when it cannot be read. */
const propertyKey = (property: AstNode): string | null => {
  if (property.type !== "Property" || property.computed) return null;
  const key = property.key as AstNode | undefined;
  if (key?.type === "Identifier") return String(key.name);
  if (key?.type === "Literal" && typeof key.value === "string") return String(key.value);
  return null;
};

export const noSensitiveDataInJwtPayload = defineDiagnostic({
  id: "no-sensitive-data-in-jwt-payload",
  title: "Credential placed in a JWT payload, which is base64 text the holder can read",
  severity: "error",
  category: "Security",
  confidence: "high",
  requires: ["jsonwebtoken"],
  tags: ["jwt", "secrets", "owasp:a02"],
  recommendation:
    'Put only an identifier and the claims the client is allowed to see in the payload — `{ sub: user.id, role: user.role }` — and look the rest up server-side from that id. A JWT is signed, not encrypted: measured on jsonwebtoken 9.0.3, `Buffer.from(token.split(".")[1], "base64url").toString("utf8")` returns the whole payload with **no secret at all**, and `jwt.decode(token)` does the same. The token lives in the client\'s storage and travels on every request, so anything inside it is also in every proxy log and error report. If a value genuinely must travel encrypted, use JWE rather than JWS.',
  create: (ctx) => {
    let jwtNames = { namespaces: new Set<string>(), signs: new Set<string>() };

    return {
      Program: (root) => {
        jwtNames = jsonwebtokenBindings(root);
      },

      CallExpression: (node) => {
        const callee = node.callee as AstNode | undefined;
        let isSign = false;
        if (callee?.type === "Identifier") {
          isSign = jwtNames.signs.has(String(callee.name));
        } else if (callee?.type === "MemberExpression" && !callee.computed) {
          const object = callee.object as AstNode | undefined;
          const property = callee.property as AstNode | undefined;
          isSign =
            object?.type === "Identifier" &&
            jwtNames.namespaces.has(String(object.name)) &&
            property?.type === "Identifier" &&
            String(property.name) === "sign";
        }
        if (!isSign) return;

        const payload = ((node.arguments as AstNode[] | undefined) ?? [])[0];
        // `jwt.sign(user, secret)` — the keys are not visible, and guessing would
        // be the release-blocking direction.
        if (!payload || payload.type !== "ObjectExpression") return;

        for (const property of ((payload.properties as AstNode[] | undefined) ?? [])) {
          // A spread hides its keys; only what is written out is judged.
          if (property.type === "SpreadElement") continue;
          const key = propertyKey(property);
          if (key === null || !isTokenSensitive(key)) continue;
          ctx.report(
            property,
            `\`${key}\` is inside a JWT payload, which is **base64url text, not ciphertext** — a JWT is signed, not encrypted, so signing proves only that nobody changed it. Measured on jsonwebtoken 9.0.3, decoding the middle segment with **no secret at all** returned the whole payload including \`"passwordHash":"$2b$12$KIX…"\` and \`"ssn":"123-45-6789"\`, and \`jwt.decode(token)\` does the same. The token sits in the client's storage and travels on every request, so this value is also in every proxy log and error report. Put an identifier in the token and look the rest up server-side.`,
          );
        }
      },
    };
  },
});
