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

/**
 * `no-prototype-pollution` was built on a premise that is false, and a hand-audit
 * of all 76 findings in one backend found **1 true positive and 75 false** — while
 * the rule was more than half of every Security finding in that project.
 *
 * The premise, disproved by running it:
 *
 *   const o = {}; o["__proto__"] = { polluted: 1 };
 *   ({}).polluted   // undefined — `o` was merely RE-PARENTED
 *
 *   const b = {}; b["__proto__"]["p2"] = 42;
 *   ({}).p2         // 42 — THIS is the vulnerability
 *
 * A single-level `obj[key] = value` sets an own property. If the key is
 * `__proto__` it changes that object's prototype and nothing else — no other
 * object in the process is affected. So the rule now fires only where the write
 * can actually reach `Object.prototype`. Corpus: 403 findings across five
 * projects → 33, with the one real gadget kept.
 */
describe("no-prototype-pollution — only writes that can reach the prototype", () => {
  test("fires: an ESCALATING write, where the key is written through", () => {
    expectFires(
      "no-prototype-pollution",
      `app.post("/x", (req, res) => { const k = req.body.k; target[k].sub = req.body.v; });`,
    );
    expectFires(
      "no-prototype-pollution",
      `app.post("/x", (req, res) => { const k = req.body.k; target[k][req.body.k2] = 1; });`,
    );
  });

  test("fires: the recursive deep-merge gadget, in every spelling", () => {
    // The shape behind lodash.merge / deep-extend / merge-deep CVEs. Verified by
    // running the corpus's own `_deepMergeInto` against `{"__proto__":{"x":1}}`.
    const decl = `function merge(target, source){ for (const k of Object.keys(source)) { if (typeof source[k] === "object") { if(!target[k]) target[k]={}; merge(target[k], source[k]); } else { target[k] = source[k]; } } }`;
    const method = `class S { _deepMergeInto(target, source){ for (const k in source) { const sv = source[k]; const tv = target[k]; if (sv && typeof sv === "object" && tv) { this._deepMergeInto(tv, sv); } else { target[k]=sv; } } } }`;
    const arrow = `const merge = (target, source) => { for (const k of Object.keys(source)) { if (typeof source[k]==="object") { if(!target[k]) target[k]={}; merge(target[k], source[k]); } else { target[k]=source[k]; } } };`;
    for (const source of [decl, method, arrow]) expectFires("no-prototype-pollution", source);
  });

  test("fires: the walked-pointer path setter (lodash.set / dot-prop CVE shape)", () => {
    // Narrowing to escalating writes alone would silence this entire class — an
    // adversarial review caught that, which is why the clause exists.
    expectFires(
      "no-prototype-pollution",
      `app.post("/s", (req, res) => {
         const segs = req.body.path.split(".");
         let node = obj;
         for (const s of segs.slice(0, -1)) { node = node[s]; }
         node[segs[segs.length - 1]] = req.body.v;
       });`,
    );
  });

  test("fires: a computed literal write to a prototype key", () => {
    expectFires("no-prototype-pollution", `o["__proto__"] = payload;`);
  });

  describe("silence — shapes that cannot pollute under any input", () => {
    test("a single-level caller-keyed write only re-parents that object", () => {
      expectSilent(
        "no-prototype-pollution",
        `app.post("/x", (req, res) => { const k = req.body.k; target[k] = req.body.v; });`,
      );
      // `a.b[k] = v` is still single-level — "two or more links total" would
      // wrongly readmit it, which is why the test is "a link AFTER the computed one".
      expectSilent(
        "no-prototype-pollution",
        `app.post("/x", (req, res) => { const k = req.body.k; rights.column_preferences[k] = { visible: true }; });`,
      );
    });

    test("a group-by accumulator keyed on a database row field", () => {
      // The single largest false class: 45 of the 76 findings in one backend.
      expectSilent(
        "no-prototype-pollution",
        `app.get("/x", (req, res) => {
           const id = req.query.id;
           const rows = await db.find({ id });
           rows.reduce((acc, user) => { acc[user.user_id] = { name: user.name }; return acc; }, {});
         });`,
      );
    });

    test("a numeric key — a number can never be the string `__proto__`", () => {
      expectSilent(
        "no-prototype-pollution",
        `app.post("/x", (req, res) => { const v = req.body.v; const i = slabs.findIndex((s) => s.b === v); if (i !== -1) { slabs[i].qty = v; } });`,
      );
      expectSilent(
        "no-prototype-pollution",
        `app.get("/x", (req, res) => { let counter = 0; out.items[counter]["it_id"] = req.query.x; });`,
      );
    });

    test("a JSON reviver is recursive and walks keys but is not a merge", () => {
      // `json2.js`'s `walk` has every surface trait of a merge gadget. The
      // discriminator is that a merge recurses into computed reads of BOTH
      // parameters; a reviver passes a value and a KEY. Removed 72 findings.
      expectSilent(
        "no-prototype-pollution",
        `function walk(holder, key) { var v, value = holder[key]; if (value && typeof value === "object") { for (var k in value) { v = walk(value, k); if (v !== undefined) { value[k] = v; } } } return reviver.call(holder, key, value); }`,
      );
    });

    test("ordinary prototype assignment is not pollution", () => {
      expectSilent("no-prototype-pollution", `o.__proto__ = Base.prototype;`);
      expectSilent("no-prototype-pollution", `Foo.prototype = { greet() {} };`);
    });

    test("a non-recursive two-parameter copy helper", () => {
      expectSilent(
        "no-prototype-pollution",
        `function copy(target, source){ for (const k of Object.keys(source)) { target[k] = source[k]; } }`,
      );
    });
  });
});

/**
 * `no-static-cipher-iv`.
 *
 * An IV exists to make the same plaintext encrypt differently every time. Fix it
 * and the cipher becomes a deterministic function of the plaintext — measured on
 * the same key twice: CBC with a fixed IV produced byte-identical ciphertext, and
 * two messages sharing a prefix shared 32 hex characters of ciphertext. For GCM
 * it is a break rather than a leak: a repeated nonce repeats the keystream, so
 * `ct1 XOR ct2 === pt1 XOR pt2` exactly (measured: both `030303…`).
 *
 * Found in the corpus at a `static encrypt()` holding a hardcoded key AND a
 * hardcoded 16-character IV, copied across a monorepo's variants. node.doctor
 * reported NOTHING on that file before this rule — `no-weak-cipher` judges the
 * algorithm, and `aes-256-cbc` is a fine algorithm.
 */
describe("no-static-cipher-iv", () => {
  test("fires: the corpus shape — a literal IV", () => {
    expectFires("no-static-cipher-iv", `const cipher = crypto.createCipheriv('aes-256-cbc', key, '1234567812345678');`);
  });
  test("fires: Buffer.alloc, the most fixed IV there is", () => {
    expectFires("no-static-cipher-iv", `const c = crypto.createCipheriv('aes-256-gcm', key, Buffer.alloc(12));`);
  });
  test("fires: through a const binding", () => {
    expectFires(
      "no-static-cipher-iv",
      `const IV = '1234567812345678';\nconst c = crypto.createCipheriv('aes-256-cbc', key, IV);`,
    );
    expectFires("no-static-cipher-iv", `const IV = Buffer.alloc(16);\nconst c = createCipheriv('aes-256-cbc', key, IV);`);
  });

  describe("silence", () => {
    test("the correct form — a fresh IV per message", () => {
      expectSilent("no-static-cipher-iv", `const c = crypto.createCipheriv('aes-256-cbc', key, crypto.randomBytes(16));`);
      expectSilent(
        "no-static-cipher-iv",
        `const iv = crypto.randomBytes(16);\nconst c = crypto.createCipheriv('aes-256-cbc', key, iv);`,
      );
    });
    test("an IV the file cannot decide is silence", () => {
      expectSilent("no-static-cipher-iv", `function enc(key, iv) { return crypto.createCipheriv('aes-256-cbc', key, iv); }`);
      expectSilent("no-static-cipher-iv", `const c = crypto.createCipheriv('aes-256-cbc', key, deriveIv(msg));`);
      expectSilent("no-static-cipher-iv", `const c = crypto.createCipheriv('aes-256-cbc', key, cfg.iv);`);
    });
    test("a `let` may hold a fresh IV by the time it runs", () => {
      expectSilent(
        "no-static-cipher-iv",
        `let iv = '1234567812345678';\niv = crypto.randomBytes(16);\nconst c = crypto.createCipheriv('aes-256-cbc', key, iv);`,
      );
    });
    test("a null IV is ECB — `no-weak-cipher`'s subject, not this one's", () => {
      expectSilent("no-static-cipher-iv", `const c = crypto.createCipheriv('aes-128-ecb', key, null);`);
    });
    test("DEcryption must reuse the IV the ciphertext was made with", () => {
      // A literal here is a consequence of the defect, not the defect.
      expectSilent("no-static-cipher-iv", `const d = crypto.createDecipheriv('aes-256-cbc', key, '1234567812345678');`);
    });
  });
});
