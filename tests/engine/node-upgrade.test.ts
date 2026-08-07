/**
 * §83 — Node Version Upgrade Checker.
 *
 * Both halves are claims about the reader's future, which makes a wrong one
 * expensive: they either do not upgrade because of a break that is not real, or
 * delete a package the built-in does not actually replace. The blocked cases
 * below are the specification.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildNodeUpgradeReport } from "../../src/core/node-upgrade.ts";
import { scanProject } from "../../src/core/scan.ts";
import type { Finding } from "../../src/core/types.ts";

const makeProject = async (
  files: Record<string, string>,
  pkg: Record<string, unknown> = {},
): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "nd-upgrade-"));
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "app", version: "1.0.0", type: "module", ...pkg }, null, 2),
  );
  for (const [rel, src] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, src);
  }
  return dir;
};

const withProject = async <T>(
  files: Record<string, string>,
  pkg: Record<string, unknown>,
  fn: (report: Awaited<ReturnType<typeof buildNodeUpgradeReport>>, dir: string) => T | Promise<T>,
  options: { target?: number; findings?: readonly Finding[] } = {},
): Promise<T> => {
  const dir = await makeProject(files, pkg);
  try {
    return await fn(await buildNodeUpgradeReport(dir, { target: options.target ?? 24, findings: options.findings ?? [] }), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const deps = (d: Record<string, string>) => ({ dependencies: d });

describe("node-upgrade — what breaks", () => {
  test("a removed API is a break at a target past its removal", async () => {
    const dir = await makeProject({
      "src/a.js": `import util from "node:util";\nexport const f = (x) => util.isString(x);\n`,
    });
    try {
      const scan = await scanProject({ rootDirectory: dir });
      const r = await buildNodeUpgradeReport(dir, { target: 24, findings: scan.findings });
      assert.equal(r.breaks.length, 1);
      assert.equal(r.breaks[0]!.api, "util.isString");
      assert.equal(r.breaks[0]!.removedIn, 23);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the same API is NOT a break at a target below its removal", async () => {
    const dir = await makeProject({
      "src/a.js": `import util from "node:util";\nexport const f = (x) => util.isString(x);\n`,
    });
    try {
      const scan = await scanProject({ rootDirectory: dir });
      const r = await buildNodeUpgradeReport(dir, { target: 22, findings: scan.findings });
      assert.deepEqual(r.breaks, [], "removed in 23 — Node 22 still has it");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a runtime deprecation warns but does not break", async () => {
    const dir = await makeProject({
      "src/a.js": `import util from "node:util";\nexport const f = (x) => util.isArray(x);\n`,
    });
    try {
      const scan = await scanProject({ rootDirectory: dir });
      assert.ok(
        scan.findings.some((f) => f.diagnostic === "no-deprecated-node-api"),
        "the rule did fire",
      );
      const r = await buildNodeUpgradeReport(dir, { target: 24, findings: scan.findings });
      assert.deepEqual(r.breaks, [], "a warning is not a break");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("with no findings supplied, the report says the break check did not run", async () => {
    // "I did not look" and "there is nothing" must not render the same.
    const dir = await makeProject({ "src/a.js": `export const x = 1;\n` });
    try {
      const r = await buildNodeUpgradeReport(dir, { target: 24 });
      assert.deepEqual(r.breaks, []);
      assert.ok(r.notes.some((n) => /breaks were not checked/.test(n)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("node-upgrade — what you can delete", () => {
  test("a clean uuid v4-only usage is redundant", async () => {
    await withProject(
      { "src/a.js": `import { v4 } from "uuid";\nexport const id = () => v4();\n` },
      deps({ uuid: "^9.0.0" }),
      (r) => {
        assert.equal(r.redundant.length, 1);
        assert.equal(r.redundant[0]!.package, "uuid");
        assert.match(r.redundant[0]!.caveat, /v4 only/i, "the caveat always ships");
      },
    );
  });

  test("uuid is NOT redundant when any other generator is used", async () => {
    for (const src of [
      `import { v4, v5 } from "uuid";\nexport const a = v4();\nexport const b = v5("x", ns);\n`,
      `import * as uuid from "uuid";\nexport const a = uuid.v4();\n`,
      `import uuid from "uuid";\nexport const a = uuid.v4();\n`,
      `import { v4, validate } from "uuid";\nexport const a = validate(v4());\n`,
    ]) {
      await withProject({ "src/a.js": src }, deps({ uuid: "^9.0.0" }), (r) => {
        assert.deepEqual(r.redundant, [], src);
        assert.ok(r.notes.some((n) => n.includes("uuid")), "and it says why");
      });
    }
  });

  test("rimraf is NOT redundant with a glob, options, or a CLI use", async () => {
    await withProject(
      { "src/a.js": `import { rimraf } from "rimraf";\nawait rimraf("dist/*.js");\n` },
      deps({ rimraf: "^5.0.0" }),
      (r) => assert.deepEqual(r.redundant, [], "fs.rm does not expand globs"),
    );
    await withProject(
      { "src/a.js": `import { rimraf } from "rimraf";\nawait rimraf("dist", { signal });\n` },
      deps({ rimraf: "^5.0.0" }),
      (r) => assert.deepEqual(r.redundant, []),
    );
    await withProject(
      { "src/a.js": `import { rimraf } from "rimraf";\nawait rimraf("dist");\n` },
      { ...deps({ rimraf: "^5.0.0" }), scripts: { clean: "rimraf dist" } },
      (r) => assert.deepEqual(r.redundant, [], "the CLI is not replaced by fs.rm"),
    );
  });

  test("a rimraf call with a LITERAL path is redundant", async () => {
    await withProject(
      { "src/a.js": `import { rimraf } from "rimraf";\nawait rimraf("dist");\n` },
      deps({ rimraf: "^5.0.0" }),
      (r) => assert.deepEqual(r.redundant.map((x) => x.package), ["rimraf"]),
    );
  });

  test("a rimraf path this cannot read is `unknown`, not `not a glob`", async () => {
    // `fs.rm` does not expand globs, and a variable may hold one. "I could not
    // evaluate this argument" is not the same answer as "there are no options".
    for (const call of ["rimraf(dir)", "rimraf(`${dir}/**/*.log`)"]) {
      await withProject(
        { "src/a.js": `import { rimraf } from "rimraf";\nawait ${call};\n` },
        deps({ rimraf: "^5.0.0" }),
        (r) => {
          assert.deepEqual(r.redundant, [], call);
          assert.ok(r.notes.some((n) => n.includes("rimraf")), "and it says why");
        },
      );
    }
  });

  test("dotenv is NOT redundant when it uses more than `config()`", async () => {
    await withProject(
      { "src/a.js": `import { config, parse } from "dotenv";\nconfig();\nparse(buf);\n` },
      deps({ dotenv: "^16.0.0" }),
      (r) => assert.deepEqual(r.redundant, []),
    );
    await withProject(
      { "src/a.js": `import { config } from "dotenv";\nconfig({ path: "./.env.local" });\n` },
      deps({ dotenv: "^16.0.0" }),
      (r) => assert.deepEqual(r.redundant, []),
    );
  });

  test("a version window with a gap is honoured, not treated as `>=`", async () => {
    // `--env-file` is stable on 22.21+ and 24.10+, but NOT on 23.x.
    const files = { "src/a.js": `import { config } from "dotenv";\nconfig();\n` };
    await withProject(files, deps({ dotenv: "^16.0.0" }), (r) => {
      assert.deepEqual(r.redundant.map((x) => x.package), ["dotenv"]);
    }, { target: 24 });
    await withProject(files, deps({ dotenv: "^16.0.0" }), (r) => {
      assert.deepEqual(r.redundant, [], "Node 23 does not have a stable --env-file");
    }, { target: 23 });
    await withProject(files, deps({ dotenv: "^16.0.0" }), (r) => {
      assert.deepEqual(r.redundant, [], "Node 20 does not either");
    }, { target: 20 });
  });

  test("a declared-but-never-imported dependency is not claimed", async () => {
    await withProject({ "src/a.js": `export const x = 1;\n` }, deps({ rimraf: "^5.0.0" }), (r) => {
      assert.deepEqual(r.redundant, []);
      assert.ok(r.notes.some((n) => /never imported/.test(n)));
    });
  });

  test("a browser or React Native target suppresses the fetch/AbortController entries", async () => {
    await withProject(
      { "src/a.js": `import fetch from "node-fetch";\nawait fetch(url);\n` },
      { ...deps({ "node-fetch": "^3.0.0" }), browser: "./dist/browser.js" },
      (r) => {
        assert.deepEqual(r.redundant, []);
        assert.ok(r.notes.some((n) => /browser or React Native/.test(n)));
      },
    );
  });

  test("node-fetch with a non-standard option is not redundant", async () => {
    await withProject(
      { "src/a.js": `import fetch from "node-fetch";\nawait fetch(url, { agent });\n` },
      deps({ "node-fetch": "^2.6.0" }),
      (r) => assert.deepEqual(r.redundant, []),
    );
  });

  test("a project with no package.json claims nothing, and says so", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-upgrade-bare-"));
    try {
      const r = await buildNodeUpgradeReport(dir, { findings: [] });
      assert.deepEqual(r.redundant, []);
      assert.ok(r.notes.some((n) => /No readable package\.json/.test(n)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("node-upgrade — determinism", () => {
  test("identical input yields identical output", async () => {
    const dir = await makeProject(
      {
        "src/a.js": `import { v4 } from "uuid";\nimport { rimraf } from "rimraf";\nexport const f = async () => { await rimraf("dist"); return v4(); };\n`,
      },
      deps({ uuid: "^9.0.0", rimraf: "^5.0.0" }),
    );
    try {
      const a = await buildNodeUpgradeReport(dir, { target: 24, findings: [] });
      const b = await buildNodeUpgradeReport(dir, { target: 24, findings: [] });
      assert.equal(JSON.stringify(a), JSON.stringify(b));
      assert.deepEqual(a.redundant.map((x) => x.package), ["rimraf", "uuid"], "sorted");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("node-upgrade — hardened against the adversarial hunt", () => {
  // Nine separate usage forms slipped past the collector and turned into a
  // confident "safe to delete". Enumerating forms is a losing game, so the gate
  // is inverted: an unreadable mention abstains for the whole package.
  test("a re-export is a usage, in every form", async () => {
    for (const reexport of [
      `export { v1, v5 } from "uuid";`,
      `export { v5 as five } from "uuid";`,
      `export * from "uuid";`,
      `export * as uuid from "uuid";`,
    ]) {
      await withProject(
        { "src/a.js": `import { v4 } from "uuid";\nexport const n = () => v4();\n`, "src/b.js": reexport },
        deps({ uuid: "^9.0.0" }),
        (r) => {
          assert.deepEqual(r.redundant, [], reexport);
          assert.ok(r.notes.some((n) => n.includes("uuid")));
        },
      );
    }
  });

  test("a dynamic import is a usage", async () => {
    await withProject(
      {
        "src/a.js": `import { v4 } from "uuid";\nexport const n = () => v4();\n`,
        "src/b.js": `export async function legacy() { const { v1 } = await import("uuid"); return v1(); }\n`,
      },
      deps({ uuid: "^9.0.0" }),
      (r) => assert.deepEqual(r.redundant, []),
    );
  });

  test("a computed specifier makes the whole file unreadable", async () => {
    await withProject(
      {
        "src/a.js": `import { v4 } from "uuid";\nexport const n = () => v4();\n`,
        "src/b.js": `const m = "uuid";\nexport const f = () => import(m);\n`,
      },
      deps({ uuid: "^9.0.0" }),
      (r) => {
        assert.deepEqual(r.redundant, []);
        assert.ok(r.notes.some((n) => /could not read/.test(n)));
      },
    );
  });

  test("a member call straight off require is a usage", async () => {
    await withProject(
      { "src/a.js": `module.exports = require("dotenv").parse(buf);\n` },
      deps({ dotenv: "^16.0.0" }),
      (r) => assert.deepEqual(r.redundant, []),
    );
    await withProject(
      { "src/a.js": `require("dotenv").config({ path: ".env.p", override: true });\n` },
      deps({ dotenv: "^16.0.0" }),
      (r) => assert.deepEqual(r.redundant, []),
    );
  });

  test("an options object hoisted into a variable is `unknown options`", async () => {
    await withProject(
      {
        "src/a.js": `import fetch from "node-fetch";\nconst o = { agent };\nexport const g = (u) => fetch(u, o);\n`,
      },
      deps({ "node-fetch": "^2.6.0" }),
      (r) => assert.deepEqual(r.redundant, []),
    );
  });

  test("a glob's static parts are read out of a template literal", async () => {
    await withProject(
      { "src/a.js": `import rimraf from "rimraf";\nexport const c = (d) => rimraf(\`\${d}/**/*.log\`);\n` },
      deps({ rimraf: "^3.0.2" }),
      (r) => assert.deepEqual(r.redundant, []),
    );
  });

  test("a negation pattern inside an array blocks glob", async () => {
    await withProject(
      {
        "src/a.js": `import { globSync } from "glob";\nexport const f = globSync(["src/**/*.ts", "!src/**/*.test.ts"]);\n`,
      },
      deps({ glob: "^10.0.0" }),
      (r) => assert.deepEqual(r.redundant, []),
    );
  });

  test("a file that cannot be parsed abstains for every package it mentions", async () => {
    await withProject(
      {
        "src/a.js": `import { v4 } from "uuid";\nexport const n = () => v4();\n`,
        "src/broken.js": `@@@ not javascript {{{ uuid\n`,
      },
      deps({ uuid: "^9.0.0" }),
      (r) => {
        assert.deepEqual(r.redundant, []);
        assert.ok(r.notes.some((n) => /could not read/.test(n)));
      },
    );
  });

  test("a companion package proves the built-in is not sufficient", async () => {
    await withProject(
      { "src/a.js": `import { config } from "dotenv";\nconfig();\n` },
      deps({ dotenv: "^16.0.0", "dotenv-expand": "^11.0.0" }),
      (r) => {
        assert.deepEqual(r.redundant, []);
        assert.ok(r.notes.some((n) => /dotenv-expand/.test(n)));
      },
    );
  });

  test("a workspace root says its packages were not assessed", async () => {
    const dir = await makeProject({}, { workspaces: ["packages/*"] });
    try {
      const r = await buildNodeUpgradeReport(dir, { target: 24, findings: [] });
      assert.ok(r.notes.some((n) => /workspace root/.test(n)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a target past the newest known release says so", async () => {
    const dir = await makeProject({});
    try {
      const r = await buildNodeUpgradeReport(dir, { target: 99, findings: [] });
      assert.ok(r.notes.some((n) => /past the newest release/.test(n)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
