import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { expectFires, expectSilent, findingsFor } from "../helpers.ts";

const ID = "no-constant-condition";

// ---------------------------------------------------------------------------
// Literal tests — if / ternary
// ---------------------------------------------------------------------------

describe("no-constant-condition: literal branches", () => {
  test("fires on if (true)", () => {
    expectFires(ID, `if (true) { start(); }`);
  });

  test("fires on if (false)", () => {
    expectFires(ID, `if (false) { start(); } else { stop(); }`);
  });

  test("fires on if (0)", () => {
    expectFires(ID, `if (0) { start(); }`);
  });

  test("fires on if (1)", () => {
    expectFires(ID, `if (1) { start(); }`);
  });

  test("fires on a string-literal condition", () => {
    expectFires(ID, `if ("debug") { log(); }`);
  });

  test("fires on if (null)", () => {
    expectFires(ID, `if (null) { log(); }`);
  });

  test("fires on an else-if with a literal test", () => {
    expectFires(ID, `if (ready) { go(); } else if (true) { fallback(); }`);
  });

  test("fires on a constant ternary test", () => {
    expectFires(ID, `const port = true ? 3000 : 8080;`);
  });

  test("fires on a falsy ternary test", () => {
    expectFires(ID, `const port = 0 ? 3000 : 8080;`);
  });

  test("reports the truthy direction distinctly from the falsy one", () => {
    const truthy = findingsFor(ID, `if (true) { go(); }`);
    const falsy = findingsFor(ID, `if (false) { go(); }`);
    assert.equal(truthy.length, 1);
    assert.equal(falsy.length, 1);
    assert.match(truthy[0]!.message, /always truthy/);
    assert.match(falsy[0]!.message, /always falsy/);
  });

  test("is deterministic — identical input yields identical findings", () => {
    const src = `if (true) { a(); }\nif (0) { b(); }`;
    assert.deepEqual(findingsFor(ID, src), findingsFor(ID, src));
  });
});

// ---------------------------------------------------------------------------
// Structurally-truthy literals
// ---------------------------------------------------------------------------

describe("no-constant-condition: object/array/function literals", () => {
  test("fires on an object literal condition", () => {
    expectFires(ID, `if ({ enabled: flag }) { go(); }`);
  });

  test("fires on an array literal condition", () => {
    expectFires(ID, `if ([]) { go(); }`);
  });

  test("fires on an arrow-function condition", () => {
    expectFires(ID, `if (() => ready) { go(); }`);
  });

  test("fires on a function-expression condition", () => {
    expectFires(ID, `if (function () { return ready; }) { go(); }`);
  });
});

// ---------------------------------------------------------------------------
// Unary ! / void
// ---------------------------------------------------------------------------

describe("no-constant-condition: unary operators", () => {
  test("fires on if (!true)", () => {
    expectFires(ID, `if (!true) { go(); }`);
  });

  test("fires on if (!!0)", () => {
    expectFires(ID, `if (!!0) { go(); }`);
  });

  test("fires on if (!{})", () => {
    expectFires(ID, `if (!{}) { go(); }`);
  });

  test("fires on if (void 0)", () => {
    expectFires(ID, `if (void 0) { go(); }`);
  });

  test("silent on ! applied to a runtime value", () => {
    expectSilent(ID, `if (!ready) { go(); }`);
  });

  test("silent on ! applied to a call", () => {
    expectSilent(ID, `if (!isReady(config)) { go(); }`);
  });

  test("silent on void applied to a call (operand may have side effects)", () => {
    expectSilent(ID, `if (void flush()) { go(); }`);
  });

  test("silent on typeof, which this rule deliberately does not model", () => {
    expectSilent(ID, `if (typeof handler) { go(); }`);
  });
});

// ---------------------------------------------------------------------------
// Assignment used as a condition (`=` vs `===`)
// ---------------------------------------------------------------------------

describe("no-constant-condition: assignment in a condition", () => {
  test("fires on if (x = 1)", () => {
    const found = expectFires(ID, `let x = 0;\nif (x = 1) { go(); }`);
    assert.match(found[0]!.message, /assigns instead of comparing/);
  });

  test("fires on if (status = \"ok\")", () => {
    expectFires(ID, `let status = "";\nif (status = "ok") { go(); }`);
  });

  test("fires on a constant assignment to a member expression", () => {
    expectFires(ID, `if (user.role = "admin") { grant(); }`);
  });

  test("fires on a falsy constant assignment in a while", () => {
    expectFires(ID, `let x;\nwhile (x = 0) { drain(); }`);
  });

  test("fires on a constant assignment in a for test", () => {
    expectFires(ID, `let flag;\nfor (let i = 0; flag = true; i++) { visit(i); }`);
  });

  test("fires on a constant assignment in a do…while", () => {
    expectFires(ID, `let done;\ndo { step(); } while (done = false);`);
  });

  // --- the idiom sweep: assigning a *runtime* value is deliberate everywhere ---

  test("silent on while (m = re.exec(s)) — the classic scan idiom", () => {
    expectSilent(ID, `let m;\nwhile (m = re.exec(s)) { use(m); }`);
  });

  test("silent on while (r = stack.pop())", () => {
    expectSilent(ID, `let r;\nwhile (r = stack.pop()) { close(r); }`);
  });

  test("silent on a for-test assignment of a call result", () => {
    expectSilent(ID, `let node;\nfor (let i = 0; node = next(i); i++) { visit(node); }`);
  });

  test("silent on a do…while parent-walk assignment", () => {
    expectSilent(ID, `let scope = start;\ndo { visit(scope); } while (scope = scope.parent);`);
  });

  test("silent on if (_ = accept(x)) — deliberate assign-and-test", () => {
    expectSilent(ID, `let _;\nif (_ = accept(result.get)) { use(_); }`);
  });

  test("silent when the assignment's value is a comparison", () => {
    expectSilent(ID, `let done;\nif (done = index < 0) { stop(); }`);
  });

  test("silent when the assignment's value is awaited", () => {
    expectSilent(ID, `async function run() { let m; while (m = await next()) { use(m); } }`);
  });

  test("silent on a chained assignment", () => {
    expectSilent(ID, `let a, b;\nif (a = b = compute()) { go(); }`);
  });

  // --- destructuring is never a `===` typo ---

  test("silent on an array-destructuring condition", () => {
    expectSilent(ID, `let a, b;\nwhile ([a, b] = pop()) { use(a, b); }`);
  });

  test("silent on an object-destructuring condition", () => {
    expectSilent(ID, `let a;\nif ({ a } = next()) { use(a); }`);
  });

  // --- the extra-paren escape hatch, and everything the scan cannot read ---

  test("silent when a constant assignment is wrapped in extra parens", () => {
    expectSilent(ID, `let x;\nwhile ((x = 0)) { drain(); }`);
  });

  test("silent on an extra-paren constant assignment in an if", () => {
    expectSilent(ID, `let x;\nif ((x = 1)) { use(x); }`);
  });

  test("silent on an extra-paren constant assignment in a for test", () => {
    expectSilent(ID, `let flag;\nfor (let i = 0; (flag = true); i++) { visit(i); }`);
  });

  test("silent when a block comment sits between the parens", () => {
    expectSilent(ID, `let x;\nif (/* deliberate */ (x = 1)) { use(x); }`);
  });

  test("silent when a line comment sits between the parens", () => {
    expectSilent(ID, `let x;\nwhile ( // deliberate\n  (x = 1)) { drain(); }`);
  });

  test("silent when a comment sits inside the parens of a for test", () => {
    expectSilent(ID, `let n;\nfor (let i = 0; ( /* ok */ n = 1); i++) { use(n); }`);
  });

  test("silent on a compound assignment (cannot be an == typo)", () => {
    expectSilent(ID, `let x = 0;\nif (x += 1) { go(); }`);
  });

  test("silent on a logical assignment", () => {
    expectSilent(ID, `let x = 0;\nif (x ||= fallback) { go(); }`);
  });

  test("silent on a comparison that assigns nothing", () => {
    expectSilent(ID, `let m;\nwhile ((m = re.exec(s)) !== null) { use(m); }`);
  });

  test("silent on an assignment that is only part of the condition", () => {
    expectSilent(ID, `let m;\nif (ok && (m = 1)) { use(m); }`);
  });

  test("silent on an assignment outside a condition", () => {
    expectSilent(ID, `let x;\nswitch (x = 1) { case 1: break; }\nfoo(x = 2);`);
  });
});

// ---------------------------------------------------------------------------
// Infinite-loop idioms — the false positives that matter most
// ---------------------------------------------------------------------------

describe("no-constant-condition: infinite-loop idioms stay silent", () => {
  test("silent on while (true)", () => {
    expectSilent(ID, `while (true) { const job = queue.pop(); if (!job) break; run(job); }`);
  });

  test("silent on while (1)", () => {
    expectSilent(ID, `while (1) { if (done()) break; tick(); }`);
  });

  test("silent on for (;;)", () => {
    expectSilent(ID, `for (;;) { if (done()) break; tick(); }`);
  });

  test("silent on for (; true;)", () => {
    expectSilent(ID, `for (let i = 0; true; i++) { if (i > 10) break; }`);
  });

  test("silent on do … while (true)", () => {
    expectSilent(ID, `do { const job = queue.pop(); if (!job) break; } while (true);`);
  });

  test("silent on do … while (1)", () => {
    expectSilent(ID, `do { if (done()) break; } while (1);`);
  });

  test("silent on while (!false)", () => {
    expectSilent(ID, `while (!false) { if (done()) break; }`);
  });

  test("silent on a truthy-object loop test", () => {
    expectSilent(ID, `while ({}) { if (done()) break; }`);
  });
});

// ---------------------------------------------------------------------------
// Falsy loop tests — the body provably never runs
// ---------------------------------------------------------------------------

describe("no-constant-condition: falsy loops", () => {
  test("fires on while (0)", () => {
    expectFires(ID, `while (0) { drain(); }`);
  });

  test("fires on while (false)", () => {
    expectFires(ID, `while (false) { drain(); }`);
  });

  test("fires on for (; false;)", () => {
    expectFires(ID, `for (let i = 0; false; i++) { drain(); }`);
  });

  test("fires on a do…while (false) wrapper with no break", () => {
    expectFires(ID, `do { drain(); } while (false);`);
  });

  test("silent on do … while (false) guarding a break (breakable-block idiom)", () => {
    expectSilent(ID, `do { if (!ok) break; commit(); } while (false);`);
  });

  test("silent on do … while (0) guarding a continue", () => {
    expectSilent(ID, `do { if (!ok) continue; commit(); } while (0);`);
  });

  test("silent on a bare-statement do…while body that is itself the break", () => {
    // Regression: findDescendant does not test the root node, so a body that IS
    // the `break` must be checked directly.
    expectSilent(ID, `do break; while (false);`);
  });

  test("silent on a labelled break out of a do…while (false)", () => {
    expectSilent(ID, `outer: do { if (!ok) break outer; commit(); } while (false);`);
  });

  test("silent on a do…while (false) block exited with return", () => {
    expectSilent(ID, `function save() { do { if (!ok) return null; commit(); } while (false); }`);
  });

  test("silent on a do…while (false) block exited with throw", () => {
    expectSilent(ID, `function save() { do { if (!ok) throw new Error("no"); commit(); } while (false); }`);
  });
});

// ---------------------------------------------------------------------------
// Runtime-valued conditions — the broad silent surface
// ---------------------------------------------------------------------------

describe("no-constant-condition: runtime conditions stay silent", () => {
  test("silent on an identifier", () => {
    expectSilent(ID, `if (ready) { go(); }`);
  });

  test("silent on a member expression", () => {
    expectSilent(ID, `if (config.debug) { go(); }`);
  });

  test("silent on process.env comparisons", () => {
    expectSilent(ID, `if (process.env.NODE_ENV === "production") { go(); }`);
  });

  test("silent on process.env truthiness", () => {
    expectSilent(ID, `if (process.env.DEBUG) { go(); }`);
  });

  test("silent on a call expression", () => {
    expectSilent(ID, `if (isEnabled("beta")) { go(); }`);
  });

  test("silent on comparisons against literals", () => {
    expectSilent(ID, `if (count > 0) { go(); }\nif (name === "root") { go(); }`);
  });

  test("silent on logical combinations", () => {
    expectSilent(ID, `if (a && b) { go(); }\nif (a || fallback) { go(); }`);
  });

  test("silent on optional chaining and nullish defaults", () => {
    expectSilent(ID, `if (req?.body?.id ?? null) { go(); }`);
  });

  test("silent on template literals", () => {
    expectSilent(ID, "if (`${prefix}-key`) { go(); }\nif (`literal`) { go(); }");
  });

  test("silent on an await expression", () => {
    expectSilent(ID, `async function run() { if (await isReady()) { go(); } }`);
  });

  test("silent on a runtime ternary", () => {
    expectSilent(ID, `const port = config.port ? config.port : 3000;`);
  });

  test("silent on runtime for/while loops", () => {
    expectSilent(
      ID,
      `for (let i = 0; i < items.length; i++) { use(items[i]); }
       while (queue.length > 0) { queue.pop(); }
       do { tick(); } while (pending());`,
    );
  });

  test("silent on a new expression condition", () => {
    expectSilent(ID, `if (new Set(values).size) { go(); }`);
  });

  test("silent on TypeScript-only condition syntax", () => {
    expectSilent(
      ID,
      `if (value!) { go(); }
       if (value as boolean) { go(); }
       if ((cfg satisfies object)) { go(); }`,
    );
  });

  test("silent on a switch(true) dispatch table", () => {
    expectSilent(ID, `switch (true) { case a > 1: go(); break; default: stop(); }`);
  });

  test("silent on a generator yield condition", () => {
    expectSilent(ID, `function* g() { while (yield) { tick(); } }`);
  });

  test("silent on class-method loops and fields", () => {
    expectSilent(
      ID,
      `class Runner {
         limit = () => (this.max ? this.max : 10);
         run() { while (true) { if (this.done) break; this.step(); } }
       }`,
    );
  });

  test("survives a pathological unary chain without reporting", () => {
    expectSilent(ID, `if (${"!".repeat(200)}ready) { go(); }`);
  });

  test("silent on a whole realistic handler", () => {
    expectSilent(
      ID,
      `export const handler = async (req, res) => {
         if (!req.body?.id) return res.status(400).json({ error: "bad request" });
         const user = await db.find(req.body.id);
         const name = user ? user.name : "anonymous";
         for (const role of user?.roles ?? []) { if (role === "admin") return res.json(user); }
         while (queue.length) { queue.shift()(); }
         return res.json({ name });
       };`,
    );
  });
});
