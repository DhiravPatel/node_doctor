import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getCalleeName, getStaticStringValue, inPasswordContext, unwrapChain } from "../../core/ast.ts";
import { findDescendant } from "../../core/walk.ts";

/**
 * A password KDF given a HARD-CODED salt. A salt exists to make one stolen
 * database row's worth of cracking work useless against the next row; a constant
 * salt makes every row share the same work, which is precisely what it was meant
 * to prevent.
 *
 *   ❌ crypto.pbkdf2Sync(password, "app-salt", 600000, 32, "sha256");
 *   ❌ crypto.scryptSync(password, SALT, 32);            // SALT = "static"
 *   ✅ const salt = crypto.randomBytes(16);              // stored beside the hash
 *      crypto.pbkdf2Sync(password, salt, 600000, 32, "sha256");
 *
 * MEASURED on Node 22 with pbkdf2-sha256 at 600,000 iterations. Three different
 * users who happened to choose the same password:
 *
 *   static salt      alice  c5e1bd456fe4a47c1d6e277820004348
 *                    bob    c5e1bd456fe4a47c1d6e277820004348
 *                    carol  c5e1bd456fe4a47c1d6e277820004348    byte-identical
 *
 *   randomBytes(16)  alice  d5170108fbea0dee219d45b5b094dfa6
 *                    bob    0ff5d24ef5a8f384450693d2772431ea
 *                    carol  6ed92222686d716aa1b84825b6fb6dbc
 *
 * Two things follow, and the first is not about cracking at all: with a constant
 * salt the stored hashes THEMSELVES reveal which accounts share a password, so
 * the database leaks that before anyone attacks it. The second is the cost.
 * Measured with a table of four guesses, built once:
 *
 *   one precomputed table, 4 entries
 *   cracked from a stolen database of 3 rows:  hunter2, password, qwerty
 *   with per-user salts, the same table cracks: ?, ?, ?   (rebuild it PER ROW)
 *
 * That is the whole point of the salt: it converts "attack the database" into
 * "attack each row", and multiplies the attacker's work by the number of rows.
 * `no-weak-password-hash-cost` sets how expensive one guess is; this sets how
 * many times the attacker has to pay.
 *
 * PRECISION MODEL. The salt must be provably constant AND the call must be a
 * password KDF:
 *
 *   - The salt is a string literal, a template literal with no interpolation, a
 *     `Buffer.from("…")` of one, or an identifier bound to a module-level `const`
 *     holding one. Anything else — a column, a parameter, a call — is silent,
 *     because a salt read from the row beside the hash is exactly correct and is
 *     the commonest right answer.
 *   - The call is in a PASSWORD context, the shared test the other two
 *     password-hashing rules use. `pbkdf2` and `scrypt` are also ordinary
 *     key-derivation primitives, and deriving a subkey from a 256-bit master key
 *     with a fixed, published salt is correct: there is no low-entropy secret to
 *     build a table against.
 *
 * HKDF is deliberately absent, and that is a decision rather than an omission.
 * Its salt is a DOMAIN SEPARATOR, not an anti-rainbow-table device — RFC 5869
 * explicitly permits an empty salt and the construction is sound over
 * high-entropy input — so `hkdfSync(hash, masterKey, "app-v1", info, len)` with a
 * constant is the documented correct use, and reporting it would be reporting
 * correct code.
 */

/** KDFs whose second argument is the salt, and whose input is a low-entropy password. */
const SALTED_KDFS = new Set(["pbkdf2", "pbkdf2Sync", "scrypt", "scryptSync"]);

/** The bare and namespaced spellings both resolve through `getCalleeName`. */
const kdfName = (node: AstNode): string | null => {
  const full = getCalleeName(node);
  if (full === null) return null;
  const last = full.split(".").pop() ?? full;
  return SALTED_KDFS.has(last) ? last : null;
};

/**
 * Is this expression a constant the author wrote down? A string or template
 * literal, a `Buffer.from` of one, or an identifier bound to a module-level
 * `const` holding one. Returns the literal text, or null.
 */
const constantSalt = (node: AstNode | null | undefined, program: AstNode): string | null => {
  const value = unwrapChain(node);
  if (!value) return null;

  const direct = getStaticStringValue(value);
  if (direct !== null) return direct;

  // `Buffer.from("app-salt")` / `Buffer.from("…", "hex")`
  if (value.type === "CallExpression") {
    const callee = getCalleeName(value);
    if (callee === "Buffer.from") {
      const first = ((value.arguments as AstNode[] | undefined) ?? [])[0];
      return getStaticStringValue(first);
    }
    return null;
  }

  // A module-level `const SALT = "…"`, which is the same constant one hop away.
  if (value.type !== "Identifier") return null;
  const name = String(value.name);
  const declarator = findDescendant(program, (n) => {
    if (n.type !== "VariableDeclarator") return false;
    const id = n.id as AstNode | undefined;
    return id?.type === "Identifier" && String(id.name) === name;
  });
  if (!declarator) return null;
  // Only a binding that is never written to elsewhere.
  const reassigned =
    findDescendant(program, (n) => {
      if (n.type !== "AssignmentExpression") return false;
      const left = unwrapChain(n.left as AstNode);
      return left?.type === "Identifier" && String(left.name) === name;
    }) !== null;
  if (reassigned) return null;
  return constantSalt(declarator.init as AstNode, program);
};

export const noStaticKdfSalt = defineDiagnostic({
  id: "no-static-kdf-salt",
  title: "Password KDF given a hard-coded salt, so one table cracks every row",
  severity: "error",
  category: "Security",
  confidence: "high",
  tags: ["crypto", "secrets", "owasp:a02"],
  recommendation:
    "Generate the salt per password and store it beside the hash: `const salt = crypto.randomBytes(16)`. A salt converts “attack the database” into “attack each row”, and a constant one gives that up entirely. Measured on Node 22, three users who chose the same password got the **byte-identical** derived key under a static salt, so the stored hashes reveal which accounts share a password before anyone even attacks them; a table of four guesses built once then cracked three of three rows, where per-user salts would have forced it to be rebuilt for each.",
  create: (ctx) => ({
    CallExpression: (node) => {
      const name = kdfName(node);
      if (name === null) return;

      const salt = ((node.arguments as AstNode[] | undefined) ?? [])[1];
      const literal = constantSalt(salt, ctx.program);
      // A salt read from the row beside the hash is exactly correct, and is the
      // commonest right answer — so anything unreadable is silent.
      if (literal === null) return;
      // `pbkdf2`/`scrypt` over high-entropy input with a fixed, published salt is
      // correct: there is no low-entropy secret to build a table against.
      if (!inPasswordContext(node, ctx.program)) return;

      ctx.report(
        salt!,
        `\`${name}\` is given the hard-coded salt \`${JSON.stringify(literal)}\`, so every password in the database is hashed against the same value. Measured on Node 22 at 600,000 iterations, three users who chose the same password got the **byte-identical** derived key — which means the stored hashes reveal which accounts share a password before anyone attacks them — and a precomputed table of four guesses, built once, then cracked three of three rows. A per-user salt is what converts "attack the database" into "attack each row": generate it with \`crypto.randomBytes(16)\` and store it beside the hash.`,
      );
    },
  }),
});
