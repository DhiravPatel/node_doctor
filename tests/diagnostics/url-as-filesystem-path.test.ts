/**
 * §199 — `no-url-as-filesystem-path`.
 *
 * `import.meta.url` is a URL string. The finding is the raw node sitting in a
 * position where the string is rewritten or opened, so every correct form —
 * `fileURLToPath(…)`, `new URL(…)`, pure segment arithmetic — excludes itself.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noUrlAsFilesystemPath } from "../../src/diagnostics/bugs/no-url-as-filesystem-path.ts";

const findings = (source: string) =>
  lintSource({
    filePath: "/repo/src/a.ts",
    sourceText: source,
    diagnostics: [noUrlAsFilesystemPath],
    capabilities: new Set(["node", "esm", "typescript"]),
  }).findings.filter((f) => f.diagnostic === "no-url-as-filesystem-path");

const fires = (source: string) => {
  const found = findings(source);
  assert.ok(found.length > 0, `expected a FIRE on:\n${source}`);
  return found;
};

const silent = (source: string): void => {
  const found = findings(source);
  assert.equal(found.length, 0, `expected SILENCE, got ${found.length}:\n${source}`);
};

describe("no-url-as-filesystem-path — fires", () => {
  test("`join` collapses the scheme's slashes", () => {
    const [f] = fires(`import { join } from "node:path";\nexport const t = join(import.meta.url, "../templates");`);
    assert.match(f!.message, /URL string, not a path/);
    assert.match(f!.message, /fileURLToPath/);
  });

  test("`resolve`, `normalize` and `relative` rewrite it too", () => {
    fires(`import path from "node:path";\nexport const t = path.resolve(import.meta.url, "x");`);
    fires(`import { normalize } from "node:path";\nexport const t = normalize(import.meta.url);`);
    fires(`import { relative } from "node:path";\nexport const t = relative(process.cwd(), import.meta.url);`);
  });

  test("an `fs` call opens it and gets ENOENT", () => {
    fires(`import { readFileSync } from "node:fs";\nreadFileSync(import.meta.url);`);
    fires(`import fs from "node:fs/promises";\nawait fs.readFile(import.meta.url, "utf8");`);
  });

  test("the CJS require form binds the same way", () => {
    fires(`const { join } = require("path");\nconst t = join(import.meta.url, "x");`);
    fires(`const path = require("node:path");\nconst t = path.join(import.meta.url, "x");`);
  });
});

describe("no-url-as-filesystem-path — silent", () => {
  test("the correct conversions", () => {
    silent(
      `import { join } from "node:path";\nimport { fileURLToPath } from "node:url";\nexport const t = join(fileURLToPath(import.meta.url), "x");`,
    );
    silent(`import { readFileSync } from "node:fs";\nreadFileSync(new URL(import.meta.url));`);
    silent(`export const u = new URL("./t.json", import.meta.url);`);
  });

  test("`import.meta.dirname` is a real path", () => {
    silent(`import { join } from "node:path";\nexport const t = join(import.meta.dirname, "x");`);
  });

  test("a `path`-shaped object that is not `node:path`", () => {
    silent(`export const t = myPath.join(import.meta.url, "x");`);
  });

  test("argument 1 of an `fs` call is data, not a path", () => {
    silent(`import { writeFileSync } from "node:fs";\nwriteFileSync("./out", import.meta.url);`);
  });

  test("the URL used as a string", () => {
    silent(`export const id = import.meta.url;\nlog(import.meta.url);`);
    silent(`if (import.meta.url.startsWith("file:")) {}`);
  });
});

describe("no-url-as-filesystem-path — hardened by the adversarial hunt", () => {
  test("segment arithmetic works fine on a URL and is never reported", () => {
    // `basename("file:///a/b.js")` really is `"b.js"` on both platforms, and
    // `dirname` really does yield the parent URL — a module name, a log label
    // or a sibling URL built that way is correct code.
    silent(`import { basename } from "node:path";\nexport const module = basename(import.meta.url);`);
    silent(`import { dirname } from "node:path";\nexport const base = dirname(import.meta.url);`);
    silent(`import { extname, parse } from "node:path";\nexport const a = extname(import.meta.url), b = parse(import.meta.url).name;`);
    silent(`import { basename } from "node:path";\nif (basename(process.argv[1] ?? "") === basename(import.meta.url)) main();`);
  });

  test("`resolve` SHADOWED at the call site is not `node:path`'s", () => {
    // The single most-collided identifier in Node: a Promise executor's own
    // parameter, an injected resolver, and `import-meta-resolve`'s
    // `resolve(specifier, parentURL)` whose second argument really is a URL.
    silent(`import { resolve } from "node:path";\nexport const w = () => new Promise((resolve) => resolve(import.meta.url));`);
    silent(
      `import { resolve } from "node:path";\nexport async function f(s) { const { resolve } = await import("import-meta-resolve"); return resolve(s, import.meta.url); }`,
    );
  });

  test("a shadowed namespace or `fs` function is somebody else's API", () => {
    silent(`import path from "node:path";\nexport function assetUrl(path, ...s) { return path.join(import.meta.url, ...s); }`);
    silent(`import { readFile } from "node:fs/promises";\nexport function make(readFile) { return () => readFile(import.meta.url); }`);
  });

  test("the import still fires where nothing shadows it", () => {
    fires(`import { resolve } from "node:path";\nexport const a = resolve(import.meta.url, "x");\nexport const w = () => new Promise((resolve) => resolve(1));`);
  });
});

describe("no-url-as-filesystem-path — determinism", () => {
  test("identical source yields identical findings", () => {
    const source = `import { join } from "node:path";\nexport const a = join(import.meta.url, "x");\nexport const b = join("y", import.meta.url);`;
    assert.equal(JSON.stringify(findings(source)), JSON.stringify(findings(source)));
    assert.equal(findings(source).length, 2);
  });
});
