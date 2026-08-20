/**
 * Taint is keyed by BINDING, not by name.
 *
 * The set used to be a file-global `Set<string>` of names, and
 * `looksCallerControlled` asked only "does this expression mention such a name?".
 * One tainted binding therefore contaminated every same-named binding in the
 * file. Measured on one 28k-line controller: **908 of its 2,232 distinct
 * identifiers (41%) were tainted**, including bare `user`, `key`, `row`, `item`
 * and `id`. A small, well-factored file measured 0%.
 *
 * That single defect was worked around three separate times before the substrate
 * itself was fixed — in `no-nosql-object-injection` (21 of 21 findings false), in
 * `no-open-redirect` (5 error-severity false positives, from a `state` local
 * colliding with a `state` destructured from `request.query` in a DIFFERENT
 * handler), and in `no-prototype-pollution`.
 *
 * Measured effect of the change across five corpus backends: 1,315 findings →
 * 1,300. Twenty-one lost, six gained. The three lost path traversals are provably
 * false — one reads `filename`, declared a string literal on the line above; one
 * joins only literals. The three gained are real, and include an uploaded
 * filename reaching `path.join` and a `removed_img` used for DELETION, i.e.
 * arbitrary file delete. Performance improved (7.8s vs 8.3s on the largest
 * project), because `enclosingScope` is now memoized.
 *
 * These tests pin the behaviour, including the propagation variants that were
 * measured and REJECTED, so nobody re-adds them.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noPathTraversal } from "../../src/diagnostics/security/no-path-traversal.ts";
import { noUnsafeRegexpFromInput } from "../../src/diagnostics/security/no-unsafe-regexp-from-input.ts";

const CAPS = new Set(["node", "esm", "typescript", "express"]);
const findings = (source: string, rules: unknown[] = [noPathTraversal]) =>
  lintSource({ filePath: "/repo/src/h.ts", sourceText: source, diagnostics: rules as never, capabilities: CAPS })
    .findings;

describe("taint keyed by binding", () => {
  test("multi-hop propagation still reaches the sink", () => {
    // The property the whole pass exists for. If a scope-keyed implementation
    // breaks this, the implementation is wrong, not the design.
    const found = findings(`
      app.get("/f", (req, res) => {
        const a = req.body.name;
        const b = a;
        res.sendFile(path.join("/srv", b));
      });
    `);
    assert.ok(found.length > 0, "const a = req…; const b = a; sink(b) must still be caller-controlled");
  });

  test("a same-named binding in ANOTHER function no longer inherits taint", () => {
    // The exact shape that produced five error-severity false positives in
    // `no-open-redirect`: two handlers, one `name` from the request, one local.
    const found = findings(`
      app.get("/a", (req, res) => {
        const name = req.query.name;
        use(name);
      });
      app.get("/b", (req, res) => {
        const name = "report.pdf";
        res.sendFile(path.join("/srv", name));
      });
    `);
    assert.equal(found.length, 0, "handler B's local `name` is not handler A's request value");
  });

  test("a request-root NAME that is a local const is not the request", () => {
    // `const context = lines.join("\\n")` in a diff utility read as caller data
    // to thirteen security rules.
    const found = findings(`
      function render(lines) {
        const context = lines.join("\\n");
        return path.join("/srv", context);
      }
    `);
    assert.equal(found.length, 0);
  });

  test("a request-root PARAMETER still seeds — including a bare `request`", () => {
    // The other half of the old hole: `locallyDeclared` inspected only
    // VariableDeclarator, so a `function f(request)` signature seeded the FILE.
    // Now it seeds its own function, and still seeds it.
    const found = findings(`
      function handle(request) {
        return path.join("/srv", request.query.file);
      }
    `);
    assert.ok(found.length > 0, "a request parameter is still the request");
  });

  test("`for…of` over caller data taints the element binding", () => {
    // Required companion rule: without it, scope-keying silently drops real
    // findings that the old substrate only caught by name collision.
    const found = findings(`
      app.post("/z", (req, res) => {
        for (const name of req.body.files) {
          fs.unlinkSync(path.join("/srv", name));
        }
      });
    `);
    assert.ok(found.length > 0, "the element of a caller-controlled iterable is caller-controlled");
  });

  test("`for…in` does NOT propagate — measured, and rejected", () => {
    // `for (const k in rows.data)` binds "0","1","2" — array indices, not caller
    // data. Propagating it added 75 false `no-prototype-pollution` findings in a
    // single file. Kept as a test so it is not re-added.
    const found = findings(`
      app.post("/z", (req, res) => {
        const rows = db.find({ id: req.body.id });
        for (const k in rows.data) {
          fs.readFileSync(path.join("/srv", k));
        }
      });
    `);
    assert.equal(found.length, 0);
  });

  test("a function VALUE is never caller data, whatever its body reads", () => {
    // Without this guard, `const esc = (v) => v.replace(…)` becomes tainted the
    // moment its parameter does, and then EVERY call of it reads as
    // caller-controlled — even on a literal.
    const found = findings(
      `app.get("/r", (req, res) => {
         const esc = (v) => v.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");
         const q = req.query.q;
         use(esc(q));
         const rx = new RegExp(esc("literal-pattern"), "i");
         res.json({ ok: rx.test("x") });
       });`,
      [noUnsafeRegexpFromInput],
    );
    assert.equal(found.length, 0, "a call of `esc` on a LITERAL is not caller-controlled");
  });
});
