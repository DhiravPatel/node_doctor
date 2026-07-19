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
