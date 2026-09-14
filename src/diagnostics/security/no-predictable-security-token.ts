import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getCalleeName, isSecurityShaped, securityValueName } from "../../core/ast.ts";

/**
 * A security value built from a PREDICTABLE source. Sibling to
 * `no-math-random-for-token`, which owns `Math.random()`; this one owns the two
 * sources that look cryptographic and are not — a time- or name-based UUID, and a
 * clock read.
 *
 *   ❌ const resetToken = uuidv1();          // timestamp + this host's MAC address
 *   ❌ const apiKey = uuid.v5(email, NS);    // a hash of the email, which they have
 *   ❌ const sessionId = Date.now().toString(36);
 *   ✅ const resetToken = crypto.randomUUID();        // v4, from a CSPRNG
 *   ✅ const resetToken = crypto.randomBytes(32).toString("hex");
 *
 * The UUID half is the one worth measuring, because "it's a UUID" is exactly why
 * nobody looks twice. MEASURED against uuid 14.0.2, three `v1()` calls in a row:
 *
 *   776c28c0-b008-11f1-941c-09e2f413dcbe
 *   776c4fd0-b008-11f1-941c-09e2f413dcbe
 *   776c4fd1-b008-11f1-941c-09e2f413dcbe
 *
 * Every one of them ends `941c-09e2f413dcbe` — the clock sequence and the node
 * id, which is this host's MAC address and does not change. Of the 128 bits, 80
 * are CONSTANT across the process's lifetime. The only part that moves is the
 * leading `776c28c0 → 776c4fd0 → 776c4fd1`, and that is the low 32 bits of a
 * 100-nanosecond timestamp. An attacker who has seen a single v1 value from the
 * service — one they were legitimately issued — knows the suffix forever and has
 * only a narrow time window left to search.
 *
 * v3 and v5 are worse, because they are not random at all. Measured, the same
 * input twice:
 *
 *   v5("alice@example.com", NIL) → 090a5d35-6bcb-5988-b58b-88ae22e184c4
 *   v5("alice@example.com", NIL) → 090a5d35-6bcb-5988-b58b-88ae22e184c4   identical
 *
 * They are namespaced hashes (SHA-1 for v5, MD5 for v3) of a name the attacker
 * usually supplies. A "token" computed from someone's email address is a token
 * they can compute themselves. v4 is the CSPRNG version and is never reported.
 *
 * **v6 was going to be on the list and the measurement took it off.** It is
 * documented as a field-reordered v1, so it looked like the same defect. It is
 * not, in uuid 14.0.2 — three consecutive values shared NO suffix:
 *
 *   1f1b008e-63d2-65b2-823b-13b3d0991ce8
 *   1f1b008e-63d2-65b3-8175-f7454d25fbb4
 *   1f1b008e-63d2-65b4-8cbc-b71ed9f43916
 *
 * The node id is re-randomised per call rather than taken from the MAC, so the
 * tail carries real entropy; only the timestamp prefix is public. v7 behaves the
 * same way. Neither is reported.
 *
 * The clock half needs no measurement to state, but it got one anyway — three
 * `Date.now().toString(36)` calls in a row returned the byte-identical string
 * `mu0vurf2`, because millisecond resolution means two tokens issued in the same
 * millisecond ARE the same token. So this source does not merely leak; it
 * collides.
 *
 * PRECISION MODEL. Both halves need the value to be security material, decided by
 * `securityValueName` — the shared helper `no-math-random-for-token` also uses, so
 * a value one rule treats as a token cannot be invisible to the next. It reads
 * the assignment target first (`const resetToken = …`), then falls back to the
 * enclosing function's name (`function generateApiKey() { return … }`), and is
 * segment-aware, so `tokenize` and `saltedButter` do not match.
 *
 * The two halves are then deliberately NOT held to the same standard:
 *
 *   - **UUID** takes both paths. `uuidv1()` inside `generateResetToken()` is the
 *     defect whether or not the result is named. The call must resolve to the
 *     `uuid` package — a named import, an alias, a namespace member, the CommonJS
 *     forms, or the legacy deep import `uuid/v1` — so a local `v1` helper is not
 *     mistaken for it.
 *   - **The clock** takes ONLY the binding path, and additionally refuses any
 *     time-shaped name. `const tokenExpiry = Date.now() + 3600_000` is correct
 *     code that a name check alone would report, because `token_expiry` contains
 *     `token`; so `expiry`, `expires`, `ttl`, `iat`, `issuedAt`, `deadline` and
 *     their neighbours all silence it. Dropping the enclosing-function path here
 *     is the same caution: a `Date.now()` used for a log line or an expiry inside
 *     `generateToken()` is not the token.
 *
 * Deliberately NOT claimed: `crypto.randomBytes(n)` with a small `n`. It looked
 * like the obvious third clause, but 12 bytes is the CORRECT size for a
 * GCM nonce and a short random id is a product decision rather than a defect, so
 * the clause could not be made precise without a length-versus-purpose judgement
 * this analyzer has no basis for. The two clauses here are categorical — the
 * source is predictable, whatever length it is — which is a different and
 * defensible claim.
 */

/**
 * UUID versions measured to be predictable. v4, v6 and v7 are not on this list,
 * and v6's absence is a correction the measurement forced — see the docblock.
 */
const PREDICTABLE_UUID = new Map([
  ["v1", "a 48-bit timestamp plus this host's MAC address"],
  ["v3", "an MD5 hash of the namespace and name, so the same input always gives the same UUID"],
  ["v5", "a SHA-1 hash of the namespace and name, so the same input always gives the same UUID"],
]);

/** Clock reads. Every one is public, monotonic and guessable. */
const CLOCK_CALLS = new Map([
  ["Date.now", "the current millisecond"],
  ["performance.now", "milliseconds since the process started"],
  ["process.hrtime.bigint", "nanoseconds since an arbitrary process-local origin"],
]);

/**
 * Names that mean "this is a moment in time", which is a legitimate use of the
 * clock even on a security-shaped value. `const tokenExpiry = Date.now() + ttl`
 * is correct code, and `token_expiry` contains `token`.
 */
const TIME_NAME_RE =
  /(^|[._-])(exp|expiry|expires|expired|expiration|ttl|iat|nbf|timestamp|time|date|at|since|until|deadline|age|duration|start|started|end|ended|ms|seconds|secs)([._-]|$)/i;

const isTimeShaped = (name: string): boolean =>
  TIME_NAME_RE.test(name.replace(/([a-z0-9])([A-Z])/g, "$1_$2"));

/** local name → the uuid version it calls, for every import spelling. */
const uuidBindings = (program: AstNode): { versions: Map<string, string>; namespaces: Set<string> } => {
  const versions = new Map<string, string>();
  const namespaces = new Set<string>();

  /** `uuid`, `uuid/v1`, `node:uuid` — and the version a deep path names. */
  const uuidPath = (source: string): { isUuid: boolean; deep: string | null } => {
    const match = /^uuid(?:\/(v[0-9]+))?$/.exec(source);
    return { isUuid: match !== null, deep: match?.[1] ?? null };
  };

  for (const statement of ((program.body as AstNode[] | undefined) ?? [])) {
    if (statement.type === "ImportDeclaration") {
      const source = (statement.source as AstNode | undefined)?.value;
      if (typeof source !== "string") continue;
      const { isUuid, deep } = uuidPath(source);
      if (!isUuid) continue;
      for (const specifier of ((statement.specifiers as AstNode[] | undefined) ?? [])) {
        const local = specifier.local as AstNode | undefined;
        if (local?.type !== "Identifier") continue;
        const name = String(local.name);
        if (specifier.type === "ImportSpecifier") {
          const imported = specifier.imported as AstNode | undefined;
          if (imported?.type === "Identifier") versions.set(name, String(imported.name));
          continue;
        }
        // `import uuidv1 from "uuid/v1"` binds one version; a bare default or
        // namespace import of "uuid" binds the whole module.
        if (deep !== null) versions.set(name, deep);
        else namespaces.add(name);
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
      if (argument?.type !== "Literal" || typeof argument.value !== "string") continue;
      const { isUuid, deep } = uuidPath(String(argument.value));
      if (!isUuid) continue;

      const id = declarator.id as AstNode | undefined;
      if (id?.type === "Identifier") {
        if (deep !== null) versions.set(String(id.name), deep);
        else namespaces.add(String(id.name));
        continue;
      }
      if (id?.type !== "ObjectPattern") continue;
      for (const property of ((id.properties as AstNode[] | undefined) ?? [])) {
        if (property.type !== "Property" || property.computed) continue;
        const key = property.key as AstNode | undefined;
        const value = property.value as AstNode | undefined;
        if (key?.type === "Identifier" && value?.type === "Identifier") {
          versions.set(String(value.name), String(key.name));
        }
      }
    }
  }
  return { versions, namespaces };
};

export const noPredictableSecurityToken = defineDiagnostic({
  id: "no-predictable-security-token",
  title: "Security token built from a time-based UUID or a clock read, both predictable",
  severity: "error",
  category: "Security",
  confidence: "high",
  tags: ["crypto", "secrets", "owasp:a02"],
  recommendation:
    'Use a CSPRNG: `crypto.randomUUID()` (which is v4) or `crypto.randomBytes(32).toString("hex")`. Measured on uuid 14.0.2, three consecutive `v1()` values shared the suffix `941c-09e2f413dcbe` — the clock sequence and this host\'s MAC address — so 80 of the 128 bits are constant and only a 100-nanosecond timestamp moves. `v3`/`v5` are namespaced hashes and return the same UUID for the same input every time. And three `Date.now().toString(36)` calls in a row returned the identical string, so clock-derived tokens collide as well as leak.',
  create: (ctx) => {
    let uuid = { versions: new Map<string, string>(), namespaces: new Set<string>() };

    return {
      Program: (root) => {
        uuid = uuidBindings(root);
      },

      CallExpression: (node) => {
        const callee = node.callee as AstNode | undefined;

        // --- the UUID half: both the binding and the enclosing-function path.
        let version: string | undefined;
        if (callee?.type === "Identifier") {
          version = uuid.versions.get(String(callee.name));
        } else if (callee?.type === "MemberExpression" && !callee.computed) {
          const object = callee.object as AstNode | undefined;
          const property = callee.property as AstNode | undefined;
          if (object?.type === "Identifier" && property?.type === "Identifier" && uuid.namespaces.has(String(object.name))) {
            version = String(property.name);
          }
        }
        if (version !== undefined) {
          const why = PREDICTABLE_UUID.get(version);
          // v4, v6 and v7 all carry a measured random tail, so they are not this
          // rule's business even though v6 and v7 leak a timestamp prefix.
          if (why === undefined) return;
          const security = securityValueName(node);
          if (security === null) return;
          ctx.report(
            node,
            `\`uuid.${version}()\` is **${why}**, so \`${security.name}\` is predictable rather than random. Measured on uuid 14.0.2, three consecutive \`v1()\` values shared the suffix \`941c-09e2f413dcbe\` — 80 of the 128 bits are constant for the life of the process, and the only part that moves is the low 32 bits of a 100-nanosecond timestamp. Anyone who has been issued one value knows the rest. Use \`crypto.randomUUID()\`, which is v4 from a CSPRNG.`,
          );
          return;
        }

        // --- the clock half: the BINDING path only, and never a time-shaped name.
        const name = getCalleeName(node);
        const what = name === null ? undefined : CLOCK_CALLS.get(name);
        if (what === undefined) return;
        const security = securityValueName(node);
        // A `Date.now()` for an expiry or a log line inside `generateToken()` is
        // not the token, so the enclosing-function path is not taken here.
        if (security === null || security.via !== "binding") return;
        // `const tokenExpiry = Date.now() + ttl` is correct code.
        if (isTimeShaped(security.name)) return;
        if (!isSecurityShaped(security.name)) return;

        ctx.report(
          node,
          `\`${name}()\` returns ${what} — public, monotonic and guessable — so \`${security.name}\` is not a secret. It also COLLIDES: measured, three \`Date.now().toString(36)\` calls in a row returned the byte-identical string \`mu0vurf2\`, because two values produced in the same millisecond are the same value. Use \`crypto.randomBytes(32).toString("hex")\` or \`crypto.randomUUID()\`.`,
        );
      },
    };
  },
});
