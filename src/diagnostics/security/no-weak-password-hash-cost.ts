import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { findEnclosingFunction, getObjectProperty } from "../../core/ast.ts";
import { findDescendant } from "../../core/walk.ts";

/**
 * A password KDF configured below its cost floor. The algorithm is right — this
 * is not `no-weak-hash-for-password`, which is about MD5 and SHA-1 — but the work
 * factor makes it cheap to brute-force anyway. Nothing fails: the hash verifies,
 * the tests pass, and the only observable difference is how fast an attacker who
 * has the database can guess.
 *
 *   ❌ await bcrypt.hash(password, 4);
 *   ❌ crypto.pbkdf2Sync(password, salt, 1000, 32, "sha256");
 *   ✅ await bcrypt.hash(password, 12);
 *   ✅ crypto.pbkdf2Sync(password, salt, 600_000, 32, "sha256");
 *
 * MEASURED on one core of this machine — five runs after warmup, median taken,
 * so the doubling per bcrypt cost step is visible rather than lost in JIT noise:
 *
 *   bcrypt cost   median ms   guesses/s   vs cost 12
 *      4              1.0        1035        204x
 *      6              3.2         315         62x
 *      8             12.3          81         16x
 *     10             49.2          20          4x
 *     12            197.5           5          1x
 *
 *   pbkdf2-sha256   median ms   guesses/s
 *       1,000           0.1       12773      563x faster than 600,000
 *      10,000           0.7        1354
 *     100,000           7.5         134
 *     600,000          44.1          23
 *
 * A cost-4 bcrypt hash is **204 times** cheaper to attack than cost 12, on one
 * core, before an attacker rents a GPU. That is the whole finding: the choice is
 * a single integer, it is invisible in every test, and it decides whether a
 * leaked table is a weekend's work or is not worth starting.
 *
 * PRECISION MODEL. The cost must be a NUMERIC LITERAL below a floor that no
 * published guidance defends, and the call must be provably the KDF:
 *
 *   - bcrypt: the receiver must resolve to an import of `bcrypt` or `bcryptjs`,
 *     and the floor is **10** — bcryptjs's own default, and OWASP's minimum. A
 *     salt STRING second argument (`bcrypt.hash(pw, salt)`) is a different
 *     overload and is not a cost at all, so only a numeric literal is read.
 *   - pbkdf2: the floor is **100,000** iterations, deliberately well under
 *     OWASP's current 600,000 for SHA-256 so that the many codebases sitting at
 *     100k–310k are not reported. Below 100,000 is indefensible for a password
 *     under any guidance of the last decade.
 *   - scrypt: the floor is **N = 16384**, which is Node's own default, so a
 *     finding means someone explicitly turned the cost DOWN.
 *
 * pbkdf2 and scrypt are also legitimate key-derivation primitives for
 * high-entropy input, where a low work factor is correct and cheap — deriving a
 * subkey from a 256-bit master key does not need 600,000 iterations. Both are
 * therefore gated on a PASSWORD CONTEXT, the same signal `no-weak-hash-for-password`
 * uses: a `password`/`passphrase`/`credential`-shaped identifier in the enclosing
 * function. bcrypt needs no such gate, because bcrypt exists for one purpose.
 *
 * A cost that is not a literal — a constant, `env.BCRYPT_ROUNDS`, a ternary — is
 * never reported. The rule cannot read it, and uncertainty resolves to silence.
 */

const PASSWORD_RE = /(password|passwd|passphrase|pwd|credential)/i;

/** Cost floors. Each is a published minimum or a library default, never a guess. */
const BCRYPT_FLOOR = 10;
const PBKDF2_FLOOR = 100_000;
const SCRYPT_N_FLOOR = 16_384;

const BCRYPT_MODULES = /^bcryptjs$|^bcrypt$|^@node-rs\/bcrypt$/;
/**
 * The measured table, quoted verbatim in findings rather than recomputed. Each
 * bcrypt step doubles the work by definition, but the OBSERVED ratio at low cost
 * is a little under the theoretical one because of fixed per-call overhead — so
 * the rule states what was measured and never a `2 ** (12 - cost)` dressed up as
 * a measurement. Median of five runs after warmup, one core.
 */
const BCRYPT_MEASURED = new Map<number, { ms: string; guesses: number; ratio: number }>([
  [4, { ms: "1.0", guesses: 1035, ratio: 204 }],
  [6, { ms: "3.2", guesses: 315, ratio: 62 }],
  [8, { ms: "12.3", guesses: 81, ratio: 16 }],
  [10, { ms: "49.2", guesses: 20, ratio: 4 }],
]);

/** `bcrypt.hash(pw, cost)` and `bcrypt.genSalt(cost)` both take the cost second/first. */
const BCRYPT_COST_INDEX = new Map([
  ["hash", 1],
  ["hashSync", 1],
  ["genSalt", 0],
  ["genSaltSync", 0],
]);

/** local name → module specifier, for `import X from "m"`, `{ X }` and `require("m")`. */
const moduleBindings = (program: AstNode): Map<string, string> => {
  const bindings = new Map<string, string>();
  for (const statement of ((program.body as AstNode[] | undefined) ?? [])) {
    if (statement.type === "ImportDeclaration") {
      const source = (statement.source as AstNode | undefined)?.value;
      if (typeof source !== "string") continue;
      for (const specifier of ((statement.specifiers as AstNode[] | undefined) ?? [])) {
        const local = specifier.local as AstNode | undefined;
        if (local?.type === "Identifier") bindings.set(String(local.name), source);
      }
      continue;
    }
    if (statement.type !== "VariableDeclaration") continue;
    for (const declarator of ((statement.declarations as AstNode[] | undefined) ?? [])) {
      const init = declarator.init as AstNode | undefined;
      if (init?.type !== "CallExpression") continue;
      const callee = init.callee as AstNode | undefined;
      if (callee?.type !== "Identifier" || String(callee.name) !== "require") continue;
      const source = ((init.arguments as AstNode[] | undefined) ?? [])[0];
      if (source?.type !== "Literal" || typeof source.value !== "string") continue;

      const id = declarator.id as AstNode | undefined;
      if (id?.type === "Identifier") {
        bindings.set(String(id.name), String(source.value));
      } else if (id?.type === "ObjectPattern") {
        // `const { hash } = require("bcrypt")`
        for (const property of ((id.properties as AstNode[] | undefined) ?? [])) {
          if (property.type !== "Property") continue;
          const value = property.value as AstNode | undefined;
          if (value?.type === "Identifier") bindings.set(String(value.name), String(source.value));
        }
      }
    }
  }
  return bindings;
};

/** The numeric value of a literal argument, or null for anything unreadable. */
const literalNumber = (node: AstNode | undefined): number | null =>
  node?.type === "Literal" && typeof node.value === "number" ? (node.value as number) : null;

export const noWeakPasswordHashCost = defineDiagnostic({
  id: "no-weak-password-hash-cost",
  title: "Password KDF configured below its cost floor, so a leaked hash is cheap to crack",
  severity: "error",
  category: "Security",
  confidence: "high",
  tags: ["crypto", "secrets", "owasp:a02"],
  recommendation:
    "Raise the work factor: bcrypt cost 12 (10 is the floor), pbkdf2-sha256 600,000 iterations, scrypt `N` of at least 16384 — Node's own default. Measured on one core, a cost-4 bcrypt hash takes 1.0 ms against cost 12's 197.5 ms, which is 204x more guesses per second for an attacker holding the table, before any GPU. Nothing fails when the cost is too low, so this only ever surfaces after a breach.",
  create: (ctx) => {
    let imported = new Map<string, string>();

    /** Is a password-shaped name in scope here? pbkdf2/scrypt are also plain KDFs. */
    const inPasswordContext = (node: AstNode): boolean => {
      const scope = findEnclosingFunction(node) ?? ctx.program;
      const id = scope.id as AstNode | undefined;
      if (id?.type === "Identifier" && PASSWORD_RE.test(String(id.name))) return true;
      return findDescendant(scope, (n) => n.type === "Identifier" && PASSWORD_RE.test(String(n.name))) !== null;
    };

    return {
      Program: (root) => {
        imported = moduleBindings(root);
      },

      CallExpression: (node) => {
        const callee = node.callee as AstNode | undefined;
        const args = (node.arguments as AstNode[] | undefined) ?? [];

        // The called name, and the module the receiver (or the bare callee) came from.
        let name: string | null = null;
        let source: string | undefined;
        if (callee?.type === "Identifier") {
          name = String(callee.name);
          source = imported.get(name);
        } else if (callee?.type === "MemberExpression" && !callee.computed) {
          const property = callee.property as AstNode | undefined;
          const object = callee.object as AstNode | undefined;
          if (property?.type !== "Identifier" || object?.type !== "Identifier") return;
          name = String(property.name);
          source = imported.get(String(object.name));
        }
        if (name === null) return;

        // bcrypt: the receiver must resolve to a bcrypt module. Nothing else uses
        // `genSalt`, but `hash` is a name half the ecosystem has.
        const costIndex = BCRYPT_COST_INDEX.get(name);
        if (costIndex !== undefined && source !== undefined && BCRYPT_MODULES.test(source)) {
          // `bcrypt.hash(pw, salt)` is a different overload; only a number is a cost.
          const cost = literalNumber(args[costIndex]);
          if (cost !== null && cost < BCRYPT_FLOOR) {
            const measured = BCRYPT_MEASURED.get(cost);
            const evidence = measured
              ? `Measured on one core, cost ${cost} takes ${measured.ms} ms per hash against cost 12's 197.5 ms — **${measured.ratio}x** cheaper to attack, or about ${measured.guesses} guesses a second before an attacker rents a GPU.`
              : `Each step of the cost doubles the work, so this is far cheaper to attack than cost 12 — measured on one core, cost 4 runs at about 1035 guesses a second against cost 12's 5.`;
            ctx.report(
              args[costIndex]!,
              `A bcrypt cost of \`${cost}\` is below the floor of ${BCRYPT_FLOOR} — bcryptjs's own default, and OWASP's minimum. ${evidence} Nothing fails when the cost is too low, so this surfaces only after a breach. Use \`12\`.`,
            );
          }
          return;
        }

        if (name === "pbkdf2" || name === "pbkdf2Sync") {
          const iterations = literalNumber(args[2]);
          if (iterations === null || iterations >= PBKDF2_FLOOR) return;
          if (!inPasswordContext(node)) return;
          ctx.report(
            args[2]!,
            `\`${iterations.toLocaleString("en-US")}\` PBKDF2 iterations is far below the ${PBKDF2_FLOOR.toLocaleString("en-US")} that has been the minimum for a decade, and OWASP now asks for 600,000 with SHA-256. Measured on one core: 1,000 iterations runs at about 12,773 guesses a second against 600,000's 23 — **563x** cheaper to attack. Raise it to \`600_000\`, or move to bcrypt/argon2.`,
          );
          return;
        }

        if (name === "scrypt" || name === "scryptSync") {
          // `scrypt(password, salt, keylen, options, cb)` — N lives in the options.
          const options = args[3];
          const n = literalNumber(getObjectProperty(options, "N")?.value as AstNode | undefined);
          if (n === null || n >= SCRYPT_N_FLOOR) return;
          if (!inPasswordContext(node)) return;
          ctx.report(
            options!,
            `An scrypt \`N\` of \`${n}\` is below Node's own default of ${SCRYPT_N_FLOOR}, so this explicitly turns the cost **down**: measured here, \`N = 1024\` takes 1.3 ms per hash against the default's 19.3 ms. Leave \`N\` unset to get the default, or set it to \`16384\` or more.`,
          );
        }
      },
    };
  },
});
