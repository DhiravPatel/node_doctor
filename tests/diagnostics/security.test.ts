import { describe, test } from "node:test";
import { expectFires, expectSilent } from "../helpers.ts";

describe("no-exec-with-interpolation", () => {
  test("silent: execFile with argument array", () => {
    expectSilent("no-exec-with-interpolation", `execFile("tar", ["-czf", "backup.tgz", dir]);`);
  });
  test("silent: static command string", () => {
    expectSilent("no-exec-with-interpolation", `exec("ls -la");`);
  });
  test("fires: template interpolation", () => {
    expectFires("no-exec-with-interpolation", `exec(\`tar -czf backup.tgz \${req.body.directory}\`);`);
  });
  test("fires: string concatenation", () => {
    expectFires("no-exec-with-interpolation", `exec("convert " + filename + " out.png");`);
  });
  test("escalates message to injection when tainted", () => {
    const [finding] = expectFires(
      "no-exec-with-interpolation",
      `app.post("/x", (req, res) => { const d = req.body.dir; exec(\`tar \${d}\`); });`,
    );
    if (!/command injection/i.test(finding!.message)) {
      throw new Error(`expected injection message, got: ${finding!.message}`);
    }
  });
});

describe("no-sql-template-interpolation", () => {
  test("silent: parameterized query", () => {
    expectSilent("no-sql-template-interpolation", `db.query("SELECT * FROM users WHERE email = $1", [email]);`);
  });
  test("silent: Prisma tagged template", () => {
    expectSilent("no-sql-template-interpolation", "db.$queryRaw`SELECT * FROM users WHERE id = ${id}`;");
  });
  test("silent: interpolated non-SQL string on ambiguous method", () => {
    expectSilent("no-sql-template-interpolation", `logger.query(\`/api/\${id}\`);`);
  });
  test("fires: interpolated query()", () => {
    expectFires("no-sql-template-interpolation", `db.query(\`SELECT * FROM users WHERE email = '\${email}'\`);`);
  });
  test("fires: $queryRawUnsafe with interpolation", () => {
    expectFires("no-sql-template-interpolation", `db.$queryRawUnsafe(\`SELECT * FROM users WHERE id = \${id}\`);`);
  });
  test("fires: concatenation with a SQL keyword", () => {
    expectFires("no-sql-template-interpolation", `db.execute("DELETE FROM sessions WHERE token = " + token);`);
  });
});

describe("secret-in-env-fallback", () => {
  test("silent: non-secret var with a default", () => {
    expectSilent("secret-in-env-fallback", `const port = process.env.PORT || "3000";`);
  });
  test("silent: obvious placeholder", () => {
    expectSilent("secret-in-env-fallback", `const key = process.env.API_KEY || "changeme";`);
  });
  test("silent: validate-and-throw, no fallback", () => {
    expectSilent(
      "secret-in-env-fallback",
      `if (!process.env.JWT_SECRET) throw new Error("required"); const s = process.env.JWT_SECRET;`,
    );
  });
  test("fires: secret with a real hardcoded fallback (||)", () => {
    expectFires("secret-in-env-fallback", `const JWT_SECRET = process.env.JWT_SECRET || "super-secret-dev-key-123";`);
  });
  test("fires: secret with a real hardcoded fallback (??)", () => {
    expectFires("secret-in-env-fallback", `const apiKey = process.env.API_KEY ?? "sk_live_fallback_value";`);
  });
});

describe("no-timing-unsafe-secret-compare", () => {
  test("silent: comparing against a literal (sentinel)", () => {
    expectSilent("no-timing-unsafe-secret-compare", `if (token === "") return;`);
  });
  test("silent: non-secret comparison", () => {
    expectSilent("no-timing-unsafe-secret-compare", `if (a.length === b.length) doThing();`);
  });
  test("fires: signature === expectedSignature", () => {
    expectFires("no-timing-unsafe-secret-compare", `if (signature === expectedSignature) grant();`);
  });
  test("fires: header api key !== apiKey", () => {
    expectFires("no-timing-unsafe-secret-compare", `if (req.headers["x-api-key"] !== apiKey) return res.status(401).end();`);
  });

  /**
   * The abbreviated `sig`. Webhook verification is where this rule matters most,
   * and it is routinely written with one operand spelled out and one shortened —
   * `signature !== expectedSig`. Since BOTH operands must look secret-shaped, the
   * abbreviation on either side used to silence the whole comparison. Measured on
   * the corpus, this token recovers 5 real sites: four `signature !== expectedSig`
   * webhook checks in one backend, plus cal.com's Help Scout handler.
   */
  test("fires: signature !== expectedSig — the shape found in real webhook handlers", () => {
    expectFires("no-timing-unsafe-secret-compare", `if (signature !== expectedSig) return { valid: false };`);
  });
  test("fires: hsSignature !== calculatedSig", () => {
    expectFires("no-timing-unsafe-secret-compare", `if (hsSignature !== calculatedSig) return deny();`);
  });
  test("fires: snake_case keeps its word boundary", () => {
    // `SECRET_RE` reads a separator-free name, but the `sig` token is tested on
    // the ORIGINAL name — stripping would make `expected_sig` into `expectedsig`
    // and destroy the boundary the pattern depends on.
    expectFires("no-timing-unsafe-secret-compare", `if (expected_sig !== req_sig) return deny();`);
  });
  test("fires: a bare `sig` on both sides", () => {
    expectFires("no-timing-unsafe-secret-compare", `if (sig !== otherSig) return deny();`);
  });

  test("silent: words that merely contain the letters s-i-g", () => {
    // A bare substring `sig` would match every one of these, which is why the
    // token is word-boundary anchored.
    for (const source of [
      `if (config !== design) return;`,
      `if (assign !== signal) return;`,
      `if (signIn !== signup) return;`,
      `if (sigma !== origSize) return;`,
      `if (significant !== designation) return;`,
    ]) {
      expectSilent("no-timing-unsafe-secret-compare", source);
    }
  });
  test("silent: only one operand is secret-shaped and the other is nothing in particular", () => {
    expectSilent("no-timing-unsafe-secret-compare", `if (sig !== other) return;`);
  });

  /**
   * The COUNTERPART shapes. Requiring BOTH operands to look like secrets made the
   * rule quietest on exactly the code it exists for: a webhook HMAC check has a
   * header on one side and a template literal on the other, and an API-key gate
   * has an env lookup. Seventeen such sites in the corpus, every one a
   * byte-at-a-time prefix oracle an attacker uses to forge a signature.
   */
  test("fires: HMAC header against the wire format (n8n WhatsApp/Facebook triggers)", () => {
    expectFires(
      "no-timing-unsafe-secret-compare",
      "if (headerData['x-hub-signature-256'] !== `sha256=${computedSignature}`) return;",
    );
  });
  test("fires: API key against an env lookup (AdonisJS auth middleware)", () => {
    expectFires("no-timing-unsafe-secret-compare", `if (!apiKey || apiKey !== env.get('INTERNAL_API_KEY')) return;`);
  });
  test("fires: a header getter naming the signature (cal.com daily-video webhook)", () => {
    expectFires(
      "no-timing-unsafe-secret-compare",
      `if (headersList.get("x-webhook-signature") !== computed_signature) return;`,
    );
  });
  test("fires: `expected`/`provided` counterparts", () => {
    expectFires("no-timing-unsafe-secret-compare", `if (token !== expected) return;`);
    expectFires("no-timing-unsafe-secret-compare", `if (provided !== secret) return;`);
  });

  /**
   * Password confirmation has no oracle. Both operands come from the SAME
   * submitter in the same request, so learning that their own two strings differ
   * teaches an attacker nothing, and there is no stored value to recover.
   * Fifteen corpus findings were this.
   */
  test("silent: a password-confirmation pair", () => {
    expectSilent("no-timing-unsafe-secret-compare", `if (password !== confirmPassword) throw new Error("x");`);
    expectSilent("no-timing-unsafe-secret-compare", `if (newPassword !== confirmNewPassword) return;`);
    expectSilent("no-timing-unsafe-secret-compare", `if (body.password !== body.confirmPassword) return;`);
  });
  test("fires: a STORED secret against a submitted one is not a confirmation pair", () => {
    // Both conditions are load-bearing — the name test alone would silence this.
    expectFires("no-timing-unsafe-secret-compare", `if (user.passwordHash !== req.body.password) deny();`);
  });
  test("fires: confirmationToken vs token is a real check, not a confirmation pair", () => {
    expectFires("no-timing-unsafe-secret-compare", `if (confirmationToken !== token) deny();`);
  });
  test("silent: words that merely contain `pass`", () => {
    for (const source of [`if (bypass !== other) return;`, `if (passenger !== compass) return;`]) {
      expectSilent("no-timing-unsafe-secret-compare", source);
    }
  });
});

/**
 * `require-secure-cookie-flags` matched any `<x>.cookie(name, …)` with an
 * auth-shaped name, which caught things that are not cookie WRITES at all — an
 * AdonisJS `request.cookie(...)` read (legal with two arguments, so an
 * argument-count heuristic cannot save it) and client-side `$.cookie(...)`.
 * A read cannot be missing `httpOnly`.
 */
describe("require-secure-cookie-flags — only a response sets a cookie", () => {
  test("fires: a response sets an auth cookie with no options", () => {
    expectFires("require-secure-cookie-flags", `res.cookie("session_token", t);`);
    expectFires("require-secure-cookie-flags", `response.cookie("auth_token", t);`);
    expectFires("require-secure-cookie-flags", `reply.cookie("sid", t);`);
  });
  test("fires: missing one of the two flags", () => {
    expectFires("require-secure-cookie-flags", `res.cookie("jwt", t, { httpOnly: true });`);
  });
  test("silent: both flags present", () => {
    expectSilent("require-secure-cookie-flags", `res.cookie("session_token", t, { httpOnly: true, secure: true });`);
  });
  test("silent: an AdonisJS cookie READ, including the two-argument form", () => {
    expectSilent("require-secure-cookie-flags", `const t = request.cookie("refresh_token");`);
    expectSilent("require-secure-cookie-flags", `const t = request.cookie("refresh_token", null);`);
  });
  test("silent: client-side jQuery cookie helpers", () => {
    expectSilent("require-secure-cookie-flags", `$.cookie("auth_token", null);`);
    expectSilent("require-secure-cookie-flags", `if ($.cookie("auth_token") == "x") {}`);
  });
});

/**
 * `ScopeResolver` attaches the declarator's whole initializer to every name a
 * pattern binds, so `const { id } = req.body` records `initNode = req.body` for
 * `id`. Following that alias reported passing a single scalar field as passing
 * the whole body — which is the fix this rule recommends, reported as the bug.
 */
describe("no-mass-assignment — a destructured field is not the body", () => {
  test("silent: a single field destructured out", () => {
    expectSilent(
      "no-mass-assignment",
      `app.patch("/u", (req, res) => { const { id } = req.params; User.update(id, { name: "x" }); });`,
    );
    expectSilent(
      "no-mass-assignment",
      `app.patch("/u", (req, res) => { const { email } = req.body; User.update(1, { email }); });`,
    );
  });
  test("fires: `...rest` still carries every attacker-settable key", () => {
    // The load-bearing half — silencing this would remove the rule's best finding.
    expectFires(
      "no-mass-assignment",
      `app.patch("/u", (req, res) => { const { id, ...rest } = req.body; User.update(id, rest); });`,
    );
  });
  test("fires: a whole-body alias and a direct pass-through", () => {
    expectFires("no-mass-assignment", `app.patch("/u", (req, res) => { const body = req.body; User.update(1, body); });`);
    expectFires("no-mass-assignment", `app.patch("/u", (req, res) => { User.update(1, req.body); });`);
  });
});

describe("no-jwt-decode-as-verify", () => {
  test("silent: jwt.verify used", () => {
    expectSilent(
      "no-jwt-decode-as-verify",
      `const claims = jwt.verify(token, SECRET); if (claims.role !== "admin") deny();`,
    );
  });
  test("silent: decoding for exp only", () => {
    expectSilent("no-jwt-decode-as-verify", `const { exp } = jwt.decode(token); if (exp * 1000 < Date.now()) refresh();`);
  });
  test("silent: not a jwt project", () => {
    expectSilent(
      "no-jwt-decode-as-verify",
      `const claims = jwt.decode(token); if (claims.role !== "admin") deny();`,
      { capabilities: ["node", "esm"] },
    );
  });
  test("fires: decoded claims drive authorization", () => {
    expectFires(
      "no-jwt-decode-as-verify",
      `const claims = jwt.decode(req.headers.authorization); if (claims.role !== "admin") return res.status(403).end();`,
    );
  });
  test("fires: destructured authz field", () => {
    expectFires("no-jwt-decode-as-verify", `const { role } = jwt.decode(token); if (role === "admin") grant();`);
  });
});

describe("no-weak-hash-for-password", () => {
  test("silent: md5 for a non-secret ETag", () => {
    expectSilent("no-weak-hash-for-password", `function etagFor(body) { return crypto.createHash("md5").update(body).digest("hex"); }`);
  });
  test("silent: argon2 for passwords", () => {
    expectSilent("no-weak-hash-for-password", `async function hashPassword(password) { return argon2.hash(password); }`);
  });
  test("fires: md5 in a password function", () => {
    expectFires(
      "no-weak-hash-for-password",
      `function hashPassword(password) { return crypto.createHash("md5").update(password).digest("hex"); }`,
    );
  });
  test("fires: sha1 with a password identifier in scope", () => {
    expectFires(
      "no-weak-hash-for-password",
      `function store(user) { const pwd = user.password; return crypto.createHash("sha1").update(pwd).digest("hex"); }`,
    );
  });
});

describe("no-path-traversal", () => {
  test("silent: containment guard present", () => {
    expectSilent(
      "no-path-traversal",
      `app.get("/f/:name", (req, res) => { const root = path.resolve("./up"); const full = path.resolve(root, req.params.name); if (!full.startsWith(root + path.sep)) return res.status(400).end(); res.sendFile(full); });`,
    );
  });
  test("silent: basename strips traversal", () => {
    expectSilent(
      "no-path-traversal",
      `app.get("/f/:name", (req, res) => { const full = path.join("./up", path.basename(req.params.name)); res.sendFile(full); });`,
    );
  });
  test("silent: no caller-controlled segment", () => {
    expectSilent("no-path-traversal", `const full = path.join("./up", "fixed.txt");`);
  });
  test("fires: caller-controlled join without a guard", () => {
    expectFires(
      "no-path-traversal",
      `app.get("/f/:name", (req, res) => { const full = path.join("./uploads", req.params.name); res.sendFile(full); });`,
    );
  });
});

/**
 * `no-nosql-object-injection` branch (b) gated on the file-global, name-keyed
 * taint set, so every locally-built filter object in a file that touched the
 * request anywhere was reported. Measured: 21 of 21 first-party findings false,
 * all of them spreads of objects the author assembled with literal keys — which
 * is the fix, reported as the bug.
 *
 * What matters for injection is PROVENANCE OF THE KEYS: `$ne`/`$gt` reach the
 * driver only if the caller decides which keys exist. So the gate is syntactic,
 * and it is a PREFIX test — the caller owns the key set at every depth below a
 * request container, not only at `req.body` exactly.
 */
describe("no-nosql-object-injection — who chose the keys", () => {
  test("fires: a spread of the request, at any depth", () => {
    expectFires("no-nosql-object-injection", `app.get("/m", (req, res) => { Member.find({ ...req.body, orgId: 1 }); });`);
    expectFires(
      "no-nosql-object-injection",
      `app.get("/m", (req, res) => { Member.find({ ...req.body.filter, orgId: 1 }); });`,
    );
    expectFires(
      "no-nosql-object-injection",
      `app.get("/m", (req, res) => { Member.find({ ...req.query.where.inner, orgId: 1 }); });`,
    );
  });
  test("fires: through a const alias, and through an object that spreads the request", () => {
    expectFires(
      "no-nosql-object-injection",
      `app.get("/m", (req, res) => { const where = req.query.where; Member.find({ ...where, orgId: 1 }); });`,
    );
    expectFires(
      "no-nosql-object-injection",
      `app.get("/m", (req, res) => { const copy = { ...req.query }; Member.find({ ...copy, orgId: 1 }); });`,
    );
  });
  test("silent: the author chose the keys", () => {
    expectSilent(
      "no-nosql-object-injection",
      `app.get("/m", (req, res) => { const q = { orgId: req.query.org, active: true }; Member.find({ ...q }); });`,
    );
  });
  test("silent: a name that merely collides with a request-derived binding", () => {
    // The whole 21-finding false-positive class, in one line.
    expectSilent(
      "no-nosql-object-injection",
      `app.get("/m", (req, res) => { const body = buildFilter(); const other = req.body; Member.find({ ...body }); });`,
    );
  });
});
