/**
 * §185 — the `exports` map checked against the files on disk.
 *
 * Every finding is a resolution that FAILS for a consumer and succeeds for the
 * author — the author has the whole source tree and never loads through the
 * map. So the bar is the runtime's own bar: does the target exist, and can the
 * requesting module system actually load it? Anything the resolver treats as
 * "maybe" is a silence.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { parseArgs } from "../../src/cli/args.ts";
import { buildExportsCheckReport } from "../../src/core/exports-map.ts";
import type { ExportProblem } from "../../src/core/exports-map.ts";

/** A package directory: a manifest plus whatever files it claims to ship. */
const makePackage = async (
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "nd-exports-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "lib", version: "1.0.0", ...manifest }));
  for (const [rel, source] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, source);
  }
  return dir;
};

const problems = async (
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
): Promise<ExportProblem[]> => {
  const dir = await makePackage(manifest, files);
  try {
    const report = await buildExportsCheckReport(dir);
    return report.findings.map((f) => f.problem);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const ESM = "export const go = () => 1;\n";
const CJS = "module.exports.go = () => 1;\n";

describe("exports-check — fires", () => {
  test("a target that is not on disk", async () => {
    assert.deepEqual(await problems({ exports: { ".": "./dist/index.js" } }), ["missing-target"]);
  });

  test("`require` pointing at an ES module", async () => {
    // `type: module` makes every bare .js an ES module: require() throws
    // ERR_REQUIRE_ESM on the Node versions most consumers are still on.
    assert.deepEqual(
      await problems(
        { type: "module", exports: { ".": { require: "./index.js", default: "./index.js" } } },
        { "index.js": ESM },
      ),
      ["require-points-at-esm"],
    );
  });

  test("`require` pointing at ESM SYNTAX even where `type` says commonjs", async () => {
    // Whichever way the nearest `type` reads, this file cannot be require()d:
    // either it is an ES module, or it is a syntax error waiting to happen.
    assert.deepEqual(
      await problems(
        { type: "commonjs", exports: { ".": { require: "./index.js", default: "./index.js" } } },
        { "index.js": ESM },
      ),
      ["require-points-at-esm"],
    );
  });

  test("`import` pointing at a `.cjs` file", async () => {
    assert.deepEqual(
      await problems({ exports: { ".": { import: "./index.cjs", default: "./index.cjs" } } }, { "index.cjs": CJS }),
      ["import-points-at-cjs"],
    );
  });

  test("`types` placed after `default`", async () => {
    // Conditions match in written order, so `default` wins first and `types`
    // is never reached: every consumer silently loses the type surface. One
    // finding, not two — being after `default` is the strictly worse framing
    // of "not first", and reporting both says the same thing twice.
    assert.deepEqual(
      await problems(
        { exports: { ".": { default: "./index.js", types: "./index.d.ts" } } },
        { "index.js": CJS, "index.d.ts": "export declare const go: () => number;\n" },
      ),
      ["types-after-default"],
    );
  });

  test("`types` not first among its siblings", async () => {
    assert.deepEqual(
      await problems(
        { exports: { ".": { import: "./index.js", types: "./index.d.ts", default: "./index.js" } } },
        { "index.js": ESM, "index.d.ts": "export declare const go: () => number;\n" },
      ),
      ["types-condition-not-first"],
    );
  });

  test("a wildcard subpath that matches nothing", async () => {
    assert.deepEqual(await problems({ exports: { "./x/*": "./src/x/*.js" } }, { "index.js": CJS }), ["dead-wildcard"]);
  });

  test("`main` disagreeing with the `.` export", async () => {
    // Bundlers and older tooling read `main`; Node reads `exports`. Two
    // different files answer `require("lib")` depending on who is asking.
    assert.deepEqual(
      await problems(
        { main: "./legacy.js", exports: { ".": "./index.js" } },
        { "index.js": CJS, "legacy.js": CJS },
      ),
      ["main-disagrees-with-exports"],
    );
  });
});

describe("exports-check — silent", () => {
  test("a correct dual package", async () => {
    assert.deepEqual(
      await problems(
        {
          exports: {
            ".": { types: "./index.d.ts", import: "./index.mjs", require: "./index.cjs", default: "./index.cjs" },
          },
        },
        { "index.mjs": ESM, "index.cjs": CJS, "index.d.ts": "export declare const go: () => number;\n" },
      ),
      [],
    );
  });

  test("`require` pointing at a real CommonJS file", async () => {
    assert.deepEqual(
      await problems({ exports: { ".": { require: "./index.js", default: "./index.js" } } }, { "index.js": CJS }),
      [],
    );
  });

  test("a file whose module system cannot be settled", async () => {
    // No extension signal, no `type` field, no import/export and no require:
    // the resolver's answer is unknowable from here, so there is no claim.
    assert.deepEqual(
      await problems({ exports: { ".": { require: "./index.js", default: "./index.js" } } }, { "index.js": "const a = 1;\n" }),
      [],
    );
  });

  test("a live wildcard", async () => {
    assert.deepEqual(await problems({ exports: { "./x/*": "./src/x/*.js" } }, { "src/x/a.js": CJS }), []);
  });

  test("`main` agreeing with the `.` export", async () => {
    assert.deepEqual(await problems({ main: "./index.js", exports: { ".": "./index.js" } }, { "index.js": CJS }), []);
    assert.deepEqual(await problems({ main: "index.js", exports: { ".": "./index.js" } }, { "index.js": CJS }), []);
  });

  test("no `exports` map at all", async () => {
    const dir = await makePackage({ main: "./index.js" }, { "index.js": CJS });
    try {
      const report = await buildExportsCheckReport(dir);
      assert.equal(report.hasExportsMap, false);
      assert.deepEqual(report.findings, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a bare re-export target is another package's problem", async () => {
    // `"./x": "some-pkg/x"` resolves through that package's own map.
    assert.deepEqual(await problems({ exports: { "./x": "other-pkg/x" } }), []);
  });

  test("a `types` target is not judged for module system", async () => {
    // A `.d.ts` is neither ESM nor CJS at runtime; it is never loaded.
    assert.deepEqual(
      await problems(
        { exports: { ".": { types: "./index.d.ts", default: "./index.cjs" } } },
        { "index.cjs": CJS, "index.d.ts": "export declare const go: () => number;\n" },
      ),
      [],
    );
  });

  test("a `null` target is a deliberate block, not a break", async () => {
    assert.deepEqual(await problems({ exports: { ".": "./index.js", "./internal/*": null } }, { "index.js": CJS }), []);
  });

  test("an unreadable or non-object manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-exports-"));
    try {
      await writeFile(join(dir, "package.json"), "{ not json");
      const report = await buildExportsCheckReport(dir);
      assert.equal(report.hasExportsMap, false);
      assert.deepEqual(report.findings, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("exports-check — report shape", () => {
  test("the summary counts what was walked, and findings carry a condition path", async () => {
    const dir = await makePackage(
      { exports: { ".": { require: "./missing.cjs", default: "./index.js" }, "./x": "./x.js" } },
      { "index.js": CJS, "x.js": CJS },
    );
    try {
      const report = await buildExportsCheckReport(dir);
      assert.equal(report.packageName, "lib");
      assert.equal(report.manifestPath, "package.json");
      assert.equal(report.hasExportsMap, true);
      assert.equal(report.summary.subpaths, 2);
      assert.ok(report.summary.conditions >= 3);
      assert.equal(report.summary.findings, report.findings.length);
      const [f] = report.findings;
      assert.equal(f!.problem, "missing-target");
      assert.equal(f!.subpath, ".");
      assert.match(f!.conditionPath, /require/);
      assert.equal(f!.target, "./missing.cjs");
      assert.ok(f!.message.length > 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("identical input yields identical output", async () => {
    const dir = await makePackage(
      { exports: { "./b": "./b.js", "./a": "./a.js", ".": "./gone.js" } },
      { "a.js": CJS, "b.js": CJS },
    );
    try {
      const a = await buildExportsCheckReport(dir);
      const b = await buildExportsCheckReport(dir);
      assert.equal(JSON.stringify(a), JSON.stringify(b));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("exports-check — CLI wiring", () => {
  test("the command and its aliases parse", () => {
    assert.equal(parseArgs(["exports-check"]).command, "exports-check");
    assert.equal(parseArgs(["exports-map"]).command, "exports-check");
    assert.equal(parseArgs(["dual-package"]).command, "exports-check");
  });

  test("`exports` still means the semver surface, as it always has", () => {
    assert.equal(parseArgs(["exports"]).command, "semver");
  });
});

describe("exports-check — hardened by the adversarial hunt", () => {
  test("a `.` export carrying only `types` cannot disagree with `main`", async () => {
    // `types` names no runtime file, so `main` is the only answer to
    // "what gets loaded" — there is no second audience to split from.
    assert.deepEqual(
      await problems({ main: "./index.js", exports: { ".": { types: "./index.d.ts" } } }, { "index.js": CJS, "index.d.ts": "declare const x: 1;\n" }),
      [],
    );
    assert.deepEqual(
      await problems({ main: "./index.js", exports: { ".": { node: { types: "./index.d.ts" } } } }, { "index.js": CJS, "index.d.ts": "declare const x: 1;\n" }),
      [],
    );
  });

  test("a subpath NAMED like a condition is not read as one", () => {
    // Conditions are tracked structurally as the map is walked; recovering
    // them from the printed path would be string surgery on user-chosen keys.
    return (async () => {
      assert.deepEqual(await problems({ exports: { "./require": "./r.mjs" } }, { "r.mjs": ESM }), []);
      assert.deepEqual(
        await problems({ exports: { "./x.import": { require: "./e.mjs", default: "./e.mjs" } } }, { "e.mjs": ESM }),
        ["require-points-at-esm"],
      );
    })();
  });

  test("a fallback array under a condition inherits that condition", async () => {
    assert.deepEqual(
      await problems({ exports: { ".": { require: ["./index.mjs"], default: "./index.mjs" } } }, { "index.mjs": ESM }),
      ["require-points-at-esm"],
    );
  });

  test("the tshy dual-package shape is clean", async () => {
    assert.deepEqual(
      await problems(
        {
          main: "./dist/commonjs/index.js",
          exports: {
            ".": {
              import: { types: "./dist/esm/index.d.ts", default: "./dist/esm/index.js" },
              require: { types: "./dist/commonjs/index.d.ts", default: "./dist/commonjs/index.js" },
            },
          },
        },
        {
          "dist/esm/index.js": ESM,
          "dist/esm/index.d.ts": "declare const x: 1;\n",
          "dist/commonjs/index.js": CJS,
          "dist/commonjs/index.d.ts": "declare const x: 1;\n",
        },
      ),
      [],
    );
  });

  test("a nested `type: module` makes a bare .js an ES module", async () => {
    assert.deepEqual(
      await problems({ exports: { ".": { require: "./esm/index.js", default: "./esm/index.js" } } }, {
        "esm/index.js": ESM,
        "esm/package.json": '{"type":"module"}',
      }),
      ["require-points-at-esm"],
    );
  });

  test("a `main` that does not exist is a different problem, not a split", async () => {
    assert.deepEqual(await problems({ main: "./gone.js", exports: { ".": "./index.js" } }, { "index.js": CJS }), []);
  });
});
