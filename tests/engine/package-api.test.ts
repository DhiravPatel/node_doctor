/**
 * §206 — Hallucinated-API Detection.
 *
 * The claim is "this package does not export that name", and it is false the
 * moment the surface is not fully readable. So every silence below is a surface
 * this cannot enumerate — and it abstains for the WHOLE package, never for a
 * single name, because a partially-read surface makes every absent name suspect.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseArgs } from "../../src/cli/args.ts";
import { buildPackageApiReport } from "../../src/core/package-api.ts";

/** A project with one installed package `lib` and one source file. */
const makeProject = async (spec: {
  entry?: string;
  files?: Record<string, string>;
  manifest?: Record<string, unknown>;
  installed?: boolean;
}): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "nd-apicheck-"));
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "app", version: "1.0.0", type: "module", dependencies: { lib: "^1.0.0" } }),
  );
  if (spec.installed !== false) {
    const pkgDir = join(dir, "node_modules", "lib");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "lib", version: "1.0.0", main: "index.js", ...(spec.manifest ?? {}) }),
    );
    await writeFile(join(pkgDir, "index.js"), spec.entry ?? "export const parse = () => 1;\n");
  }
  for (const [rel, src] of Object.entries(spec.files ?? {})) {
    const full = join(dir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, src);
  }
  return dir;
};

const report = async (spec: Parameters<typeof makeProject>[0]) => {
  const dir = await makeProject(spec);
  try {
    return await buildPackageApiReport(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const fires = async (spec: Parameters<typeof makeProject>[0]) => {
  const r = await report(spec);
  assert.ok(r.unknownMembers.length > 0, `expected a FIRE:\n${JSON.stringify(spec, null, 1)}`);
  return r;
};

const silent = async (spec: Parameters<typeof makeProject>[0]): Promise<void> => {
  const r = await report(spec);
  assert.equal(
    r.unknownMembers.length,
    0,
    `expected SILENCE, got ${r.unknownMembers.length}:\n` +
      r.unknownMembers.map((m) => `  - ${m.package}.${m.name}`).join("\n"),
  );
};

describe("api-check — fires on a name the package does not export", () => {
  test("a named import that does not exist, with a did-you-mean", async () => {
    const r = await fires({
      entry: `export const readJSON = () => 1;\nexport const writeJSON = () => 2;\n`,
      files: { "src/a.js": `import { readJson } from "lib";\nreadJson();\n` },
    });
    assert.equal(r.unknownMembers[0]!.name, "readJson");
    assert.equal(r.unknownMembers[0]!.suggestion, "readJSON", "the real export is one edit away");
  });

  test("a member read off a namespace import", async () => {
    const r = await fires({
      entry: `export const parse = () => 1;\n`,
      files: { "src/a.js": `import * as lib from "lib";\nlib.parseAll();\n` },
    });
    assert.equal(r.unknownMembers[0]!.name, "parseAll");
  });

  test("a CommonJS surface is read just as well", async () => {
    await fires({
      entry: `module.exports = { readJSON: () => 1 };\n`,
      files: { "src/a.js": `import { readJson } from "lib";\nreadJson();\n` },
    });
  });

  test("the finding carries a location", async () => {
    const r = await fires({
      entry: `export const parse = () => 1;\n`,
      files: { "src/deep/a.js": `\n\nimport { nope } from "lib";\nnope();\n` },
    });
    assert.equal(r.unknownMembers[0]!.normalizedFilePath, "src/deep/a.js");
    assert.equal(r.unknownMembers[0]!.line, 3);
  });
});

describe("api-check — silent whenever the surface is not fully readable", () => {
  test("a name that really is exported", async () => {
    await silent({
      entry: `export const parse = () => 1;\nexport function build() {}\nexport class Client {}\n`,
      files: { "src/a.js": `import { parse, build, Client } from "lib";\nparse(); build(); new Client();\n` },
    });
  });

  test("an unfollowable `export *` makes the whole package unprovable", async () => {
    const r = await report({
      entry: `export * from "./missing.js";\n`,
      files: { "src/a.js": `import { anything } from "lib";\nanything();\n` },
    });
    assert.deepEqual(r.unknownMembers, []);
    assert.ok(r.skipped.some((s) => s.package === "lib" && /enumerable/.test(s.reason)));
  });

  test("a runtime-built `module.exports` is opaque", async () => {
    await silent({
      entry: `module.exports = build();\n`,
      files: { "src/a.js": `import { anything } from "lib";\nanything();\n` },
    });
  });

  test("ONE computed access abstains for the entire package", async () => {
    // A `lib[name]` could be reaching any export, so no other name on that
    // package can be proven absent either.
    const r = await report({
      entry: `export const parse = () => 1;\n`,
      files: { "src/a.js": `import * as lib from "lib";\nlib[k]();\nlib.definitelyNotReal();\n` },
    });
    assert.deepEqual(r.unknownMembers, []);
    assert.ok(r.skipped.some((s) => s.package === "lib" && /computed or dynamic/.test(s.reason)));
  });

  test("a package that is not installed is reported as such, never as clean", async () => {
    const r = await report({
      installed: false,
      files: { "src/a.js": `import { nope } from "lib";\nnope();\n` },
    });
    assert.deepEqual(r.unknownMembers, []);
    assert.ok(r.skipped.some((s) => s.package === "lib" && /not installed/.test(s.reason)));
  });

  test("a types-only package is not judged from its declarations", async () => {
    // A `.d.ts` is a claim about the runtime, not the runtime itself.
    const r = await report({
      manifest: { main: "index.d.ts", types: "index.d.ts" },
      entry: `export declare const parse: () => number;\n`,
      files: { "src/a.js": `import { nope } from "lib";\nnope();\n` },
    });
    assert.deepEqual(r.unknownMembers, []);
  });

  test("a type-only import asserts nothing about the runtime surface", async () => {
    await silent({
      entry: `export const parse = () => 1;\n`,
      files: { "src/a.ts": `import type { Nope } from "lib";\nexport type X = Nope;\n` },
    });
    await silent({
      entry: `export const parse = () => 1;\n`,
      files: { "src/b.ts": `import { type Nope, parse } from "lib";\nparse();\n` },
    });
  });

  test("a deep import is a different surface and is skipped", async () => {
    await silent({
      entry: `export const parse = () => 1;\n`,
      files: { "src/a.js": `import { nope } from "lib/sub";\nnope();\n` },
    });
  });

  test("relative and builtin specifiers are not packages", async () => {
    await silent({
      entry: `export const parse = () => 1;\n`,
      files: {
        "src/a.js": `import { nope } from "./local.js";\nimport { alsoNope } from "node:fs";\nnope(); alsoNope();\n`,
        "src/local.js": `export const other = 1;\n`,
      },
    });
  });

  test("universal members of a namespace object are never the package's", async () => {
    await silent({
      entry: `export const parse = () => 1;\n`,
      files: { "src/a.js": `import * as lib from "lib";\nlib.toString();\nlib.hasOwnProperty("x");\n` },
    });
  });

  test("`default` and `__esModule` are interop, never named exports", async () => {
    await silent({
      entry: `export default { a: 1 };\nexport const parse = () => 1;\n`,
      files: { "src/a.js": `import lib, { parse } from "lib";\nparse();\nlib.anythingAtAll();\n` },
    });
  });

  test("a package exporting only a default has nothing to compare against", async () => {
    const r = await report({
      entry: `export default function () {}\n`,
      files: { "src/a.js": `import { nope } from "lib";\nnope();\n` },
    });
    assert.deepEqual(r.unknownMembers, []);
    assert.ok(r.skipped.some((s) => s.package === "lib" && /no named bindings/.test(s.reason)));
  });
});

describe("api-check — determinism", () => {
  test("identical input yields identical output", async () => {
    const dir = await makeProject({
      entry: `export const parse = () => 1;\n`,
      files: { "src/a.js": `import { nope, alsoNope } from "lib";\nnope(); alsoNope();\n` },
    });
    try {
      const a = await buildPackageApiReport(dir);
      const b = await buildPackageApiReport(dir);
      assert.equal(JSON.stringify(a), JSON.stringify(b));
      assert.deepEqual(a.unknownMembers.map((m) => m.name), ["alsoNope", "nope"], "sorted");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("api-check — CLI recognition", () => {
  test("`api-check` and its aliases all resolve to the same command", () => {
    assert.equal(parseArgs(["api-check"]).command, "api-check");
    assert.equal(parseArgs(["hallucinated"]).command, "api-check");
    assert.equal(parseArgs(["check-api"]).command, "api-check");
  });
});

describe("api-check — hardened proactively", () => {
  test("a local binding SHADOWS the namespace import", async () => {
    await silent({
      entry: `export const parse = () => 1;\n`,
      files: {
        "src/a.js": `import * as lib from "lib";\nexport function f() { const lib = { nope: 1 }; return lib.nope; }\n`,
      },
    });
  });

  test("a dual ESM/CJS package whose entries disagree is not authoritative", async () => {
    // Reading whichever entry resolved first would judge the import against the
    // wrong half of the package.
    const dir = await mkdtemp(join(tmpdir(), "nd-apicheck-dual-"));
    try {
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "app", type: "module", dependencies: { lib: "^1.0.0" } }),
      );
      const pkgDir = join(dir, "node_modules", "lib");
      await mkdir(pkgDir, { recursive: true });
      await writeFile(
        join(pkgDir, "package.json"),
        JSON.stringify({ name: "lib", version: "1.0.0", module: "esm.js", main: "cjs.js" }),
      );
      await writeFile(join(pkgDir, "esm.js"), `export const onlyEsm = () => 1;\n`);
      await writeFile(join(pkgDir, "cjs.js"), `module.exports = { onlyCjs: () => 1 };\n`);
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src", "a.js"), `import { onlyEsm } from "lib";\nonlyEsm();\n`);

      const r = await buildPackageApiReport(dir);
      assert.deepEqual(r.unknownMembers, []);
      assert.ok(r.skipped.some((s) => s.package === "lib" && /dual ESM\/CJS/.test(s.reason)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an aliased named import is checked under its SOURCE name", async () => {
    const r = await fires({
      entry: `export const readJSON = () => 1;\n`,
      files: { "src/a.js": `import { readJson as rj } from "lib";\nrj();\n` },
    });
    assert.equal(r.unknownMembers[0]!.name, "readJson", "the name the package would have to export");
  });
});

describe("api-check — hardened by the adversarial hunt", () => {
  test("a TypeScript type-only import written WITHOUT the `type` keyword is erased", async () => {
    // The release blocker the hunt found: the surface is read from the `.js`
    // entry and by design can never hold a type export, so checking a
    // type-position binding against it is a guaranteed false claim — and
    // `import axios, { AxiosRequestConfig } from "axios"` is the commonest
    // TypeScript idiom there is.
    const dir = await mkdtemp(join(tmpdir(), "nd-apicheck-ts-"));
    try {
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app", type: "module" }));
      const pkgDir = join(dir, "node_modules", "axios");
      await mkdir(pkgDir, { recursive: true });
      await writeFile(
        join(pkgDir, "package.json"),
        JSON.stringify({ name: "axios", version: "1.0.0", main: "index.js", types: "index.d.ts" }),
      );
      await writeFile(join(pkgDir, "index.js"), `const axios = 1, isAxiosError = () => 1;\nexport { axios as default, isAxiosError };\n`);
      await writeFile(join(pkgDir, "index.d.ts"), `export interface AxiosRequestConfig {}\n`);
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(
        join(dir, "src", "http.ts"),
        `import axios, { AxiosRequestConfig, isAxiosError } from "axios";\nexport function g(c: AxiosRequestConfig) { return isAxiosError(c) ? axios : c; }\n`,
      );

      const r = await buildPackageApiReport(dir);
      assert.deepEqual(r.unknownMembers, [], "the type binding is erased and asserts nothing");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the same name in a .js file IS a runtime binding and still fires", async () => {
    await fires({
      entry: `export const parse = () => 1;\n`,
      files: { "src/a.js": `import { AxiosRequestConfig } from "lib";\nAxiosRequestConfig();\n` },
    });
  });

  test("a bare builtin specifier resolves to the BUILT-IN, not a node_modules shim", async () => {
    // `events`/`util`/`buffer` shims are transitively installed by half the
    // ecosystem; Node loads the builtin regardless.
    const dir = await mkdtemp(join(tmpdir(), "nd-apicheck-shim-"));
    try {
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app", type: "module" }));
      const pkgDir = join(dir, "node_modules", "util");
      await mkdir(pkgDir, { recursive: true });
      await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name: "util", version: "0.12.5", main: "util.js" }));
      await writeFile(join(pkgDir, "util.js"), `module.exports = { inspect: 1 };\n`);
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src", "cli.js"), `import { parseArgs } from "util";\nparseArgs();\n`);

      const r = await buildPackageApiReport(dir);
      assert.deepEqual(r.unknownMembers, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a DECLARED entry that cannot be resolved abstains rather than guessing", async () => {
    const r = await report({
      manifest: { main: "dist/missing.js" },
      entry: `export const parse = () => 1;\n`,
      files: { "src/a.js": `import { nope } from "lib";\nnope();\n` },
    });
    assert.deepEqual(r.unknownMembers, [], "index.js is not what consumers load");
    assert.ok(r.skipped.some((s) => s.package === "lib"));
  });

  test("a manifest that parses to a non-object is not a manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-apicheck-null-"));
    try {
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app", type: "module" }));
      const pkgDir = join(dir, "node_modules", "weird");
      await mkdir(pkgDir, { recursive: true });
      await writeFile(join(pkgDir, "package.json"), "null");
      await writeFile(join(pkgDir, "index.js"), `export const x = 1;\n`);
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src", "a.js"), `import { nope } from "weird";\nnope();\n`);

      const r = await buildPackageApiReport(dir);
      assert.deepEqual(r.unknownMembers, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
