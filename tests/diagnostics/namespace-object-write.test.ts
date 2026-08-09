/**
 * §188 — `no-namespace-object-write`.
 *
 * A module namespace object is sealed, and ES module code is strict, so a write
 * to one of its properties throws. The module system has to be PROVEN, because
 * the identical sealed object silently no-ops instead of throwing when a
 * CommonJS caller — sloppy mode — is the one doing the writing.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noNamespaceObjectWrite } from "../../src/diagnostics/bugs/no-namespace-object-write.ts";

const ESM_PROJECT = new Set(["node", "esm", "typescript"]);
const CJS_PROJECT = new Set(["node", "cjs", "typescript"]);

const findings = (source: string, filePath = "/repo/src/a.mjs", capabilities = ESM_PROJECT) =>
  lintSource({ filePath, sourceText: source, diagnostics: [noNamespaceObjectWrite], capabilities }).findings.filter(
    (f) => f.diagnostic === "no-namespace-object-write",
  );

const fires = (source: string, filePath?: string, capabilities?: Set<string>) => {
  const found = findings(source, filePath, capabilities);
  assert.ok(found.length > 0, `expected a FIRE on:\n${source}`);
  return found;
};

const silent = (source: string, filePath?: string, capabilities?: Set<string>): void => {
  const found = findings(source, filePath, capabilities);
  assert.equal(found.length, 0, `expected SILENCE, got ${found.length}:\n${source}`);
};

describe("no-namespace-object-write — fires", () => {
  test("the realistic shape: monkeypatching a builtin", () => {
    // `require("node:fs").readFile = wrapped` is legal CommonJS and is how a
    // generation of APM shims was written. Its ESM translation throws.
    const [f] = fires(`import * as fs from "node:fs";\nfs.readFile = instrumented;`);
    assert.match(f!.message, /sealed/);
    assert.match(f!.message, /TypeError/);
    assert.match(f!.message, /createRequire/);
  });

  test("every write form", () => {
    fires(`import * as NS from "./m.mjs";\nNS.fn = () => 2;`);
    fires(`import * as NS from "./m.mjs";\nNS.brandNew = 1;`);
    fires(`import * as NS from "./m.mjs";\nNS.count += 1;`);
    fires(`import * as NS from "./m.mjs";\nNS.count++;`);
    fires(`import * as NS from "./m.mjs";\ndelete NS.fn;`);
    fires(`import * as NS from "./m.mjs";\nNS[key] = 1;`);
  });

  test("a `.js` file in a `type: module` package", () => {
    fires(`import * as NS from "./m.js";\nNS.fn = 1;`, "/repo/src/a.js");
  });
});

describe("no-namespace-object-write — silent", () => {
  test("reads of every kind", () => {
    silent(`import * as NS from "./m.mjs";\nNS.fn();\nconst { a } = NS;\nexport const c = { ...NS };\nuse(NS);`);
  });

  test("a default or named import is an ordinary value", () => {
    silent(`import NS from "./m.mjs";\nNS.fn = 1;`);
    silent(`import { cfg } from "./m.mjs";\ncfg.a = 1;`);
  });

  test("a write THROUGH the namespace lands on an ordinary object", () => {
    silent(`import * as NS from "./m.mjs";\nNS.default.x = 1;`);
    silent(`import * as NS from "./m.mjs";\nNS.config.a = 2;`);
  });

  test("a shadowed name is a different binding", () => {
    silent(`import * as NS from "./m.mjs";\nexport function f(NS) { NS.fn = 1; }`);
  });

  test("a module system that is not proven ESM", () => {
    // Transpiled to CommonJS the write SUCCEEDS, and a `.ts` file's output
    // format is a tsconfig question this cannot see.
    silent(`import * as NS from "./m.ts";\nNS.fn = 1;`, "/repo/src/a.ts");
    silent(`import * as NS from "./m.mjs";\nNS.fn = 1;`, "/repo/src/a.cjs");
    silent(`import * as NS from "./m.js";\nNS.fn = 1;`, "/repo/src/a.js", CJS_PROJECT);
  });

  test("a TEST FILE gets a runner-synthesised mutable object", () => {
    // Under `vi.mock`, or a CJS test transform, `import * as mod` binds a plain
    // object and `mod.fn = vi.fn()` genuinely works.
    silent(
      `import * as NS from "./m.mjs";\nimport { it, vi } from "vitest";\nit("x", () => { NS.fn = vi.fn(); });`,
      "/repo/src/a.test.mjs",
    );
  });

  test("a tool config or a bundler marker means a loader is involved", () => {
    silent(`import * as NS from "./m.mjs";\nNS.fn = 1;`, "/repo/vite.config.mjs");
    silent(`import * as NS from "./m.mjs";\nconst d = import.meta.env.DEV;\nNS.fn = 1;`);
  });

  test("`Object.assign` needs value analysis and is deliberately not matched", () => {
    // `Object.assign(NS, {})` copies nothing, performs no [[Set]], and does not
    // throw — so the claim would have to know the source is non-empty.
    silent(`import * as NS from "./m.mjs";\nObject.assign(NS, src);`);
    silent(`import * as NS from "./m.mjs";\nObject.defineProperty(NS, "x", d);`);
  });
});

describe("no-namespace-object-write — determinism", () => {
  test("identical source yields identical findings", () => {
    const source = `import * as NS from "./m.mjs";\nNS.a = 1;\nNS.b = 2;`;
    assert.equal(JSON.stringify(findings(source)), JSON.stringify(findings(source)));
    assert.equal(findings(source).length, 2);
  });
});
