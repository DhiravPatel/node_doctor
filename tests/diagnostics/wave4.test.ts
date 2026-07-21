import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectFires, expectSilent } from "../helpers.ts";
import { scanProject } from "../../src/core/scan.ts";

// ---------------------------------------------------------------------------
// no-prototype-pollution
// ---------------------------------------------------------------------------

describe("no-prototype-pollution", () => {
  test("fires on a caller-controlled computed key write", () => {
    expectFires(
      "no-prototype-pollution",
      `app.post("/x", (req, res) => { const target = {}; target[req.body.key] = req.body.value; });`,
    );
  });
  test("fires on a literal __proto__ write", () => {
    expectFires("no-prototype-pollution", `const o = {}; o["__proto__"] = payload;`);
  });
  test("silent on a static safe key", () => {
    expectSilent("no-prototype-pollution", `const o = {}; o["name"] = value; o.count = 1;`);
  });
  test("silent on a non-tainted dynamic key", () => {
    expectSilent("no-prototype-pollution", `const o = {}; for (let i = 0; i < 3; i++) { o[i] = i; }`);
  });
});

// ---------------------------------------------------------------------------
// no-unsafe-deserialization
// ---------------------------------------------------------------------------

describe("no-unsafe-deserialization", () => {
  test("fires on node-serialize unserialize of request data", () => {
    expectFires(
      "no-unsafe-deserialization",
      `import serialize from "node-serialize";
       app.post("/x", (req, res) => { const o = serialize.unserialize(req.body.data); res.json(o); });`,
    );
  });
  test("fires on js-yaml load of request data", () => {
    expectFires(
      "no-unsafe-deserialization",
      `import yaml from "js-yaml";
       app.post("/x", (req, res) => { const cfg = yaml.load(req.body.yaml); res.json(cfg); });`,
    );
  });
  test("silent on JSON.parse", () => {
    expectSilent("no-unsafe-deserialization", `app.post("/x", (req, res) => { const o = JSON.parse(req.body.data); res.json(o); });`);
  });
  test("silent when the payload is not caller-controlled", () => {
    expectSilent("no-unsafe-deserialization", `import yaml from "js-yaml"; const cfg = yaml.load(readFileSync("config.yml", "utf8"));`);
  });
});

// ---------------------------------------------------------------------------
// jwt-missing-expiration
// ---------------------------------------------------------------------------

describe("jwt-missing-expiration", () => {
  test("fires on a 2-arg sign with an object payload lacking exp", () => {
    expectFires("jwt-missing-expiration", `import jwt from "jsonwebtoken"; export const t = (id, s) => jwt.sign({ sub: id }, s);`);
  });
  test("fires when options are present but lack expiresIn", () => {
    expectFires("jwt-missing-expiration", `import jwt from "jsonwebtoken"; export const t = (id, s) => jwt.sign({ sub: id }, s, { issuer: "api" });`);
  });
  test("silent with expiresIn", () => {
    expectSilent("jwt-missing-expiration", `import jwt from "jsonwebtoken"; export const t = (id, s) => jwt.sign({ sub: id }, s, { expiresIn: "15m" });`);
  });
  test("silent with an exp claim in the payload", () => {
    expectSilent("jwt-missing-expiration", `import jwt from "jsonwebtoken"; export const t = (id, s, e) => jwt.sign({ sub: id, exp: e }, s);`);
  });
  test("silent when the payload is a variable (can't prove)", () => {
    expectSilent("jwt-missing-expiration", `import jwt from "jsonwebtoken"; export const t = (payload, s) => jwt.sign(payload, s);`);
  });
});

// ---------------------------------------------------------------------------
// no-error-leak-to-client
// ---------------------------------------------------------------------------

describe("no-error-leak-to-client", () => {
  test("fires when err.stack is sent in the response", () => {
    expectFires(
      "no-error-leak-to-client",
      `app.get("/x", (req, res) => { try { work(); } catch (err) { res.status(500).send(err.stack); } });`,
    );
  });
  test("fires when the raw caught error is sent", () => {
    expectFires("no-error-leak-to-client", `app.get("/x", (req, res) => { try { work(); } catch (e) { res.json(e); } });`);
  });
  test("silent on a generic error message", () => {
    expectSilent(
      "no-error-leak-to-client",
      `app.get("/x", (req, res) => { try { work(); } catch (err) { log(err); res.status(500).json({ error: "Internal error" }); } });`,
    );
  });
});

// ---------------------------------------------------------------------------
// max-function-length / deep-nesting / high-cyclomatic-complexity (opt-in)
// ---------------------------------------------------------------------------

describe("max-function-length", () => {
  test("fires on a function longer than the threshold", () => {
    const long = `function f() {\n${"  let a = 0;\n".repeat(65)}}`;
    expectFires("max-function-length", long);
  });
  test("silent on a short function", () => {
    expectSilent("max-function-length", `function f() { return 1 + 2; }`);
  });
});

describe("deep-nesting", () => {
  test("fires on control flow nested 5 levels deep", () => {
    expectFires(
      "deep-nesting",
      `function f(a) { if (a) { for (;;) { while (a) { if (a) { if (a) { work(); } } } } } }`,
    );
  });
  test("silent on a long else-if chain (same level)", () => {
    expectSilent("deep-nesting", `function f(a) { if (a===1){} else if (a===2){} else if (a===3){} else if (a===4){} else if (a===5){} }`);
  });
  test("silent at 4 levels", () => {
    expectSilent("deep-nesting", `function f(a) { if (a) { for (;;) { while (a) { work(); } } } }`);
  });
});

describe("high-cyclomatic-complexity", () => {
  test("fires when there are many decision points", () => {
    const branches = Array.from({ length: 16 }, (_, i) => `if (x === ${i}) work();`).join(" ");
    expectFires("high-cyclomatic-complexity", `function f(x) { ${branches} }`);
  });
  test("silent on a simple function", () => {
    expectSilent("high-cyclomatic-complexity", `function f(x) { if (x) return 1; return 2; }`);
  });
});

// ---------------------------------------------------------------------------
// no-circular-imports (project-scope)
// ---------------------------------------------------------------------------

describe("no-circular-imports", () => {
  test("flags both files in a two-module import cycle, and leaves an acyclic import alone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-cycle-"));
    try {
      await writeFile(join(dir, "a.ts"), `import { b } from "./b.ts"; export const a = () => b();`);
      await writeFile(join(dir, "b.ts"), `import { a } from "./a.ts"; export const b = () => a();`);
      await writeFile(join(dir, "c.ts"), `import { a } from "./a.ts"; export const c = () => a();`);
      const report = await scanProject({ rootDirectory: dir });
      const cyc = report.findings.filter((f) => f.diagnostic === "no-circular-imports");
      const files = new Set(cyc.map((f) => f.normalizedFilePath));
      assert.deepEqual([...files].sort(), ["a.ts", "b.ts"], "only the two files in the cycle are flagged");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
