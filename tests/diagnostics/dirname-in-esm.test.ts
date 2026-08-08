/**
 * §199 — `no-dirname-in-esm`.
 *
 * The claim is "this file is an ES module", and being wrong about that turns
 * correct CommonJS into a false report — so the module system is PROVEN, never
 * inferred, and every way the name could still exist is a silence.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noDirnameInEsm } from "../../src/diagnostics/bugs/no-dirname-in-esm.ts";

const ESM_PROJECT = new Set(["node", "esm", "typescript"]);
const CJS_PROJECT = new Set(["node", "cjs", "typescript"]);

const findings = (source: string, filePath = "/repo/src/a.mjs", capabilities = ESM_PROJECT) =>
  lintSource({ filePath, sourceText: source, diagnostics: [noDirnameInEsm], capabilities }).findings.filter(
    (f) => f.diagnostic === "no-dirname-in-esm",
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

describe("no-dirname-in-esm — fires", () => {
  test("`.mjs` is conclusive by extension", () => {
    const [f] = fires(`import { join } from "node:path";\nexport const t = join(__dirname, "templates");`);
    assert.match(f!.message, /ReferenceError: __dirname is not defined/);
    assert.match(f!.message, /fileURLToPath/);
  });

  test("`import.meta` anywhere is conclusive by syntax", () => {
    fires(`export const u = import.meta.url;\nexport const t = __dirname;`, "/repo/src/a.ts");
  });

  test("a `.js` file in a `type: module` package", () => {
    fires(`import x from "y";\nexport const t = __dirname;`, "/repo/src/a.js");
  });

  test("`__filename` too, with its own advice", () => {
    const [f] = fires(`export const t = __filename;`, "/repo/src/a.mjs");
    assert.match(f!.message, /import\.meta\.filename/);
  });

  test("a computed key really does read the binding", () => {
    fires(`export const o = { [__dirname]: 1 };`);
  });
});

describe("no-dirname-in-esm — silent", () => {
  test("`.cjs` is CommonJS, with no appeal", () => {
    silent(`export const t = __dirname;`, "/repo/src/a.cjs");
  });

  test("a `.ts` file's emitted module format is a tsconfig question", () => {
    silent(`import x from "y";\nexport const t = __dirname;`, "/repo/src/a.ts");
  });

  test("a `.js` file in a CommonJS package", () => {
    silent(`import x from "y";\nexport const t = __dirname;`, "/repo/src/a.js", CJS_PROJECT);
  });

  test("a `.js` file with no module syntax at all", () => {
    silent(`const t = __dirname;`, "/repo/src/a.js");
  });

  test("the `fileURLToPath` shim declares its own", () => {
    silent(
      `import { fileURLToPath } from "node:url";\nimport { dirname, join } from "node:path";\nconst __dirname = dirname(fileURLToPath(import.meta.url));\nexport const t = join(__dirname, "x");`,
    );
  });

  test("`import.meta.dirname` is the real thing", () => {
    silent(`export const t = import.meta.dirname;`);
  });

  test("a property or parameter that merely shares the name", () => {
    silent(`export const o = { __dirname: 1 };\nexport const u = import.meta.url;`);
    silent(`export const t = cfg.__dirname;\nexport const u = import.meta.url;`);
    silent(`export function f(__dirname) { return __dirname; }`);
  });
});

describe("no-dirname-in-esm — hardened by the adversarial hunt", () => {
  test("a `typeof` guard makes the file dual-mode, and the rule steps back", () => {
    // `typeof` is the one operator that may name an undeclared binding without
    // throwing, and the branch it protects only runs where the name exists.
    silent(
      `import path from "node:path";\nimport { fileURLToPath } from "node:url";\nconst _dirname = typeof __dirname === 'undefined' ? path.dirname(fileURLToPath(import.meta.url)) : __dirname;`,
    );
    silent(`let base;\nif (typeof __dirname !== "undefined") { base = __dirname; } else { base = process.cwd(); }`);
  });

  test("the guard is per NAME, not per file", () => {
    fires(`const f = typeof __filename === "undefined" ? import.meta.url : __filename;\nexport const d = __dirname;`);
  });

  test("a tool CONFIG file is loaded by the tool, not by Node", () => {
    // Vite and friends bundle the config through esbuild with `__dirname`,
    // `__filename` and `import.meta.url` defined.
    silent(`import { resolve } from 'node:path';\nexport default { root: resolve(__dirname, '.') };`, "/repo/vite.config.js");
    silent(`export default { root: __dirname };`, "/repo/vitest.config.mts");
    silent(`export const c = __dirname;\nexport const u = import.meta.url;`, "/repo/src/app.config.js");
  });

  test("a bundler MARKER is the same story without the filename", () => {
    // `import.meta.env` and `import.meta.hot` do not exist in Node at all, so
    // the file is compiled before it runs — and those compilers define
    // `__dirname` in a Node-targeted build.
    silent(
      `import { join } from "node:path";\nconst isDev = import.meta.env?.DEV ?? false;\nexport const preload = join(__dirname, "../preload/index.js");`,
      "/repo/src/main/index.ts",
    );
    silent(`if (import.meta.hot) import.meta.hot.accept();\nexport const p = __dirname;`, "/repo/src/svc.ts");
  });

  test("only a REFERENCE counts — a name in a declaration reads nothing", () => {
    silent(`export interface G { __dirname: string; __filename: string; }\nexport const u = import.meta.url;`, "/repo/src/host.ts");
    silent(`type D = { __dirname: string };\nexport const u = import.meta.url;`, "/repo/scripts/build.mts");
    silent(`export class C { __dirname = "x"; }`, "/repo/src/c.mjs");
    silent(`export class C { get __dirname() { return "x"; } }`, "/repo/src/c.mjs");
    silent(`export { __dirname, __filename } from "./esm-shim.js";`, "/repo/src/index.mjs");
    silent(`import { __dirname as root } from "./shim.js";\nexport const d = root;`, "/repo/src/p.mjs");
    silent(`const dir = "x";\nexport { dir as __dirname };`, "/repo/src/shim.mjs");
    silent(`export class R { constructor(private readonly __dirname: string) {} }\nexport const m = import.meta.url;`, "/repo/src/r.mts");
  });
});

describe("no-dirname-in-esm — determinism", () => {
  test("identical source yields identical findings", () => {
    const source = `export const a = __dirname;\nexport const b = __filename;`;
    assert.equal(JSON.stringify(findings(source)), JSON.stringify(findings(source)));
    assert.equal(findings(source).length, 2);
  });
});
