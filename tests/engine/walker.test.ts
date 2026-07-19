import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseSource } from "../../src/core/parse.ts";
import { attachParents, findDescendant, collectDescendants, walk } from "../../src/core/walk.ts";
import { resolveScopes } from "../../src/core/scope.ts";

describe("walker", () => {
  test("attachParents wires up parent links", () => {
    const { program } = parseSource("a.js", "const x = f(1);");
    attachParents(program);
    let identifier: any = null;
    walk(program, {
      enter: (n) => {
        if (n.type === "Identifier" && n.name === "x") identifier = n;
      },
    });
    assert.ok(identifier);
    assert.equal(identifier.parent.type, "VariableDeclarator");
  });

  test("findDescendant prunes skipped subtrees", () => {
    const { program } = parseSource("a.js", "async function outer() { const inner = async () => { await g(); }; return 1; }");
    attachParents(program);
    const outer = (program.body as any[])[0];
    // Searching outer's body, skipping nested functions, finds NO await (the
    // only await is inside the nested arrow).
    const found = findDescendant(
      outer.body,
      (n) => n.type === "AwaitExpression",
      (n) => ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(n.type),
    );
    assert.equal(found, null);
  });

  test("collectDescendants returns matches in pre-order", () => {
    const { program } = parseSource("a.js", "f(); g(); h();");
    attachParents(program);
    const calls = collectDescendants(program, (n) => n.type === "CallExpression");
    const names = calls.map((c: any) => c.callee.name);
    assert.deepEqual(names, ["f", "g", "h"]);
  });
});

describe("scope resolver", () => {
  test("distinguishes module scope from function scope", () => {
    const { program } = parseSource("a.js", "const cache = new Map(); function f() { const local = 1; }");
    attachParents(program);
    const scope = resolveScopes(program);

    let localRef: any = null;
    walk(program, {
      enter: (n) => {
        if (n.type === "Identifier" && n.name === "local") localRef = n;
      },
    });

    assert.equal(scope.isModuleScoped("cache", program), true);
    assert.equal(scope.isModuleScoped("local", localRef), false);
  });

  test("resolves a binding to its initializer", () => {
    const { program } = parseSource("a.js", "const db = createClient();");
    attachParents(program);
    const scope = resolveScopes(program);
    const binding = scope.getBinding("db", program);
    assert.ok(binding);
    assert.equal(binding!.initNode?.type, "CallExpression");
  });
});
