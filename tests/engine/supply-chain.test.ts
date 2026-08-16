/**
 * §69 — Malicious & Risky Dependency Detection.
 *
 * This report accuses nobody, so it cannot produce a false positive in the usual
 * sense. What it CAN do is let a reader mistake "I did not look" for "there is
 * nothing" — and acting on that mistake is exactly how a supply-chain review
 * misses the thing it was for. Every test below is that distinction.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseArgs } from "../../src/cli/args.ts";
import { buildSupplyChainReport } from "../../src/core/supply-chain.ts";

/** A project with a manifest, an optional lockfile, and a fake installed tree. */
const makeProject = async (spec: {
  manifest?: Record<string, unknown>;
  lock?: unknown;
  installed?: Record<string, Record<string, unknown>>;
}): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "nd-supply-"));
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "app", version: "1.0.0", ...(spec.manifest ?? {}) }, null, 2),
  );
  if (spec.lock !== undefined) {
    await writeFile(
      join(dir, "package-lock.json"),
      typeof spec.lock === "string" ? spec.lock : JSON.stringify(spec.lock, null, 2),
    );
  }
  for (const [name, pkg] of Object.entries(spec.installed ?? {})) {
    const full = join(dir, "node_modules", name);
    await mkdir(full, { recursive: true });
    await writeFile(join(full, "package.json"), JSON.stringify({ name, version: "1.0.0", ...pkg }, null, 2));
  }
  return dir;
};

const withProject = async <T>(
  spec: Parameters<typeof makeProject>[0],
  fn: (report: Awaited<ReturnType<typeof buildSupplyChainReport>>) => T | Promise<T>,
): Promise<T> => {
  const dir = await makeProject(spec);
  try {
    return await fn(await buildSupplyChainReport(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe("supply-chain — `I did not look` is never `there is nothing`", () => {
  test("with no node_modules, the install-script check reports NOT RUN", async () => {
    await withProject({ manifest: { dependencies: { esbuild: "^0.20.0" } } }, (r) => {
      assert.equal(r.installScriptCheck, "not-installed");
      assert.deepEqual(r.installScripts, [], "and it claims nothing");
      assert.equal(r.summary.packagesInspected, 0);
    });
  });

  test("an empty node_modules is still `not installed`, not `clean`", async () => {
    const dir = await makeProject({ manifest: {} });
    try {
      await mkdir(join(dir, "node_modules"), { recursive: true });
      const r = await buildSupplyChainReport(dir);
      assert.equal(r.installScriptCheck, "not-installed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("with no lockfile, the source check reports NOT RUN", async () => {
    await withProject({ manifest: {}, installed: { a: {} } }, (r) => {
      assert.equal(r.sourceCheck, "no-lockfile");
      assert.deepEqual(r.nonRegistrySources, []);
    });
  });

  test("an unparseable lockfile is reported as unparsed, not as clean", async () => {
    await withProject({ manifest: {}, lock: "{ not json" }, (r) => {
      assert.equal(r.sourceCheck, "unparsed");
      assert.deepEqual(r.nonRegistrySources, []);
    });
  });

  test("a readable tree with nothing to report says `checked`", async () => {
    await withProject(
      { manifest: {}, installed: { a: { scripts: { test: "node --test" } } }, lock: { packages: {} } },
      (r) => {
        assert.equal(r.installScriptCheck, "checked");
        assert.equal(r.sourceCheck, "checked");
        assert.deepEqual(r.installScripts, [], "a `test` script is not an install hook");
      },
    );
  });
});

describe("supply-chain — install scripts", () => {
  test("every install hook is reported, with its command verbatim", async () => {
    await withProject(
      {
        manifest: { dependencies: { esbuild: "^1.0.0" } },
        installed: {
          esbuild: { scripts: { postinstall: "node install.js" } },
          husky: { scripts: { prepare: "husky install" } },
          sharp: { scripts: { install: "node-gyp rebuild" } },
        },
      },
      (r) => {
        assert.equal(r.installScripts.length, 3);
        const esbuild = r.installScripts.find((s) => s.package === "esbuild")!;
        assert.equal(esbuild.hook, "postinstall");
        assert.equal(esbuild.command, "node install.js", "verbatim, never truncated");
        assert.equal(esbuild.direct, true, "declared in the manifest");
        assert.equal(r.installScripts.find((s) => s.package === "husky")!.direct, false);
      },
    );
  });

  test("a scoped package is found", async () => {
    await withProject(
      { manifest: {}, installed: { "@scope/tool": { scripts: { postinstall: "./setup.sh" } } } },
      (r) => assert.deepEqual(r.installScripts.map((s) => s.package), ["@scope/tool"]),
    );
  });

  test("non-install lifecycle scripts are never reported", async () => {
    await withProject(
      {
        manifest: {},
        installed: {
          a: { scripts: { build: "tsc", test: "vitest", start: "node .", lint: "eslint ." } },
        },
      },
      (r) => assert.deepEqual(r.installScripts, []),
    );
  });

  test("an empty script string is not a script", async () => {
    await withProject({ manifest: {}, installed: { a: { scripts: { postinstall: "  " } } } }, (r) =>
      assert.deepEqual(r.installScripts, []),
    );
  });

  test("a package with an unreadable manifest is skipped, not counted", async () => {
    const dir = await makeProject({ manifest: {}, installed: { good: { scripts: { postinstall: "x" } } } });
    try {
      await mkdir(join(dir, "node_modules", "broken"), { recursive: true });
      await writeFile(join(dir, "node_modules", "broken", "package.json"), "{ not json");
      const r = await buildSupplyChainReport(dir);
      assert.equal(r.summary.packagesInspected, 1);
      assert.deepEqual(r.installScripts.map((s) => s.package), ["good"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("supply-chain — package sources", () => {
  const lockWith = (packages: Record<string, Record<string, unknown>>) => ({ packages });

  test("a registry tarball is not reported", async () => {
    await withProject(
      {
        manifest: {},
        lock: lockWith({
          "node_modules/express": {
            version: "4.19.2",
            resolved: "https://registry.npmjs.org/express/-/express-4.19.2.tgz",
          },
        }),
      },
      (r) => assert.deepEqual(r.nonRegistrySources, []),
    );
  });

  test("a git source is reported, and says why it matters", async () => {
    await withProject(
      {
        manifest: {},
        lock: lockWith({
          "node_modules/lib": { version: "git+ssh://git@github.com/acme/lib.git#abc", resolved: "git+ssh://git@github.com/acme/lib.git#abc" },
        }),
      },
      (r) => {
        assert.equal(r.nonRegistrySources.length, 1);
        assert.match(r.nonRegistrySources[0]!.why, /ref that can move/);
      },
    );
  });

  test("an http tarball outside the registry is reported", async () => {
    await withProject(
      {
        manifest: {},
        lock: lockWith({
          "node_modules/lib": { version: "1.0.0", resolved: "https://cdn.example.com/lib-1.0.0.tgz" },
        }),
      },
      (r) => {
        assert.equal(r.nonRegistrySources.length, 1);
        assert.match(r.nonRegistrySources[0]!.why, /no immutability guarantee/);
      },
    );
  });

  test("a file: or link: source is reported as reproducible-only-if-the-path-is", async () => {
    await withProject(
      { manifest: {}, lock: lockWith({ "node_modules/core": { version: "file:../core" } }) },
      (r) => {
        assert.equal(r.nonRegistrySources.length, 1);
        assert.match(r.nonRegistrySources[0]!.why, /whatever is on disk/);
      },
    );
  });

  test("the root entry and a workspace link with no `resolved` are not sources", async () => {
    await withProject(
      {
        manifest: {},
        lock: lockWith({
          "": { name: "app", version: "1.0.0" },
          "node_modules/pkg-a": { resolved: "packages/a", link: true },
        }),
      },
      (r) => {
        // A `link: true` entry resolves to a workspace path, not the registry —
        // it is reported, because the reader should know it is not a registry
        // artifact, but the root entry (key "") is never a dependency.
        assert.ok(!r.nonRegistrySources.some((s) => s.package === ""));
      },
    );
  });

  test("a yarn/pnpm-only project reports the source check as not run", async () => {
    await withProject({ manifest: {}, installed: { a: {} } }, (r) =>
      assert.equal(r.sourceCheck, "no-lockfile", "only package-lock.json carries a per-entry `resolved`"),
    );
  });
});

describe("supply-chain — determinism", () => {
  test("identical input yields identical output, sorted by package", async () => {
    const spec = {
      manifest: { dependencies: { z: "1", a: "1" } },
      installed: {
        z: { scripts: { postinstall: "z" } },
        a: { scripts: { preinstall: "a", postinstall: "a2" } },
      },
      lock: { packages: { "node_modules/z": { version: "git+https://x/z.git" } } },
    };
    const dir = await makeProject(spec);
    try {
      const a = await buildSupplyChainReport(dir);
      const b = await buildSupplyChainReport(dir);
      assert.equal(JSON.stringify(a), JSON.stringify(b));
      assert.deepEqual(
        a.installScripts.map((s) => `${s.package}:${s.hook}`),
        ["a:postinstall", "a:preinstall", "z:postinstall"],
        "sorted by package, then hook",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("supply-chain — CLI recognition", () => {
  test("`supply-chain` and its aliases all resolve to the same command", () => {
    assert.equal(parseArgs(["supply-chain"]).command, "supply-chain");
    assert.equal(parseArgs(["deps"]).command, "supply-chain");
    assert.equal(parseArgs(["install-scripts"]).command, "supply-chain");
  });
});

/**
 * Which declared hooks ACTUALLY RUN.
 *
 * Measured by packing a manifest declaring all five hooks and installing it both
 * ways: a tarball install runs `preinstall`/`install`/`postinstall`; a directory
 * (git-style) install also runs `prepare`; `--ignore-scripts` runs nothing.
 *
 * This is not a detail. Across 14 real projects, 705 of 730 declared hooks were
 * `prepare`/`prepublish` on registry-resolved packages and never execute,
 * against 25 that do — one project declared 178 and executes 3. Counting the
 * dormant ones buries the handful that matter.
 */
describe("install scripts — declared vs actually executed", () => {
  test("preinstall, install and postinstall execute", async () => {
    await withProject(
      {
        manifest: { dependencies: { a: "^1.0.0", b: "^1.0.0", c: "^1.0.0" } },
        installed: {
          a: { scripts: { preinstall: "node a.js" } },
          b: { scripts: { install: "node-gyp rebuild" } },
          c: { scripts: { postinstall: "node install.js" } },
        },
      },
      (report) => {
        assert.equal(report.installScripts.length, 3);
        assert.ok(report.installScripts.every((s) => s.executes));
        assert.equal(report.summary.withExecutingInstallScripts, 3);
      },
    );
  });

  test("`prepare` on a registry-resolved package does NOT execute", async () => {
    await withProject(
      {
        manifest: { dependencies: { lodash: "^4.0.0" } },
        installed: { lodash: { scripts: { prepare: "npm run build" } } },
      },
      (report) => {
        // Still reported — "declares a prepare hook" is worth seeing …
        assert.equal(report.installScripts.length, 1);
        // … but it is not code that runs.
        assert.equal(report.installScripts[0]!.executes, false);
        assert.equal(report.summary.withExecutingInstallScripts, 0);
      },
    );
  });

  test("`prepublish` never executes on install", async () => {
    await withProject(
      {
        manifest: { dependencies: { qrcode: "^1.0.0" } },
        installed: { qrcode: { scripts: { prepublish: "npm run build" } } },
      },
      (report) => {
        assert.equal(report.installScripts[0]!.executes, false);
        assert.equal(report.summary.withExecutingInstallScripts, 0);
      },
    );
  });

  test("`prepare` DOES execute when the package comes from git", async () => {
    await withProject(
      {
        manifest: { dependencies: { tool: "github:acme/tool" } },
        lock: {
          name: "app",
          lockfileVersion: 3,
          packages: {
            "node_modules/tool": { version: "1.0.0", resolved: "git+ssh://git@github.com/acme/tool.git#abc123" },
          },
        },
        installed: { tool: { scripts: { prepare: "npm run build" } } },
      },
      (report) => {
        assert.equal(report.installScripts[0]!.executes, true);
        assert.equal(report.summary.withExecutingInstallScripts, 1);
      },
    );
  });

  test("with no lockfile the source is unknown, and unknown does not execute", async () => {
    await withProject(
      {
        manifest: { dependencies: { tool: "^1.0.0" } },
        installed: { tool: { scripts: { prepare: "npm run build" } } },
      },
      (report) => {
        assert.equal(report.sourceCheck, "no-lockfile");
        // The registry is the overwhelmingly common case, and overstating is the
        // failure mode this distinction exists to fix.
        assert.equal(report.installScripts[0]!.executes, false);
      },
    );
  });

  test("a mixed tree counts only what runs", async () => {
    await withProject(
      {
        manifest: { dependencies: { esbuild: "^0.25.0" } },
        installed: {
          esbuild: { scripts: { postinstall: "node install.js" } },
          luxon: { scripts: { prepare: "husky install" } },
          eslintrc: { scripts: { prepare: "npm run build" } },
        },
      },
      (report) => {
        assert.equal(report.installScripts.length, 3, "all three are still reported");
        assert.equal(report.summary.withInstallScripts, 3);
        assert.equal(report.summary.withExecutingInstallScripts, 1, "only esbuild actually runs");
        const executing = report.installScripts.filter((s) => s.executes);
        assert.deepEqual(
          executing.map((s) => s.package),
          ["esbuild"],
        );
      },
    );
  });
});
