import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTextScan } from "../../src/core/text-scan.ts";
import { noUnpinnedDependency } from "../../src/diagnostics/supplychain/index.ts";
import type { NodeDoctorConfig } from "../../src/core/config.ts";

// The diagnostic is opt-in (defaultEnabled: false), so every scan enables it.
const ON: NodeDoctorConfig = { diagnostics: { "no-unpinned-dependency": "warn" } };

/** Write a package.json with the given raw text and return the raw findings. */
const scanRaw = async (content: string) => {
  const dir = await mkdtemp(join(tmpdir(), "nd-supply-"));
  try {
    await writeFile(join(dir, "package.json"), content);
    return await runTextScan(dir, { textDiagnostics: [noUnpinnedDependency], config: ON });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** Names of the dependencies flagged, parsed out of each finding message, sorted. */
const flagged = async (deps: Record<string, string>, mapName = "dependencies"): Promise<string[]> => {
  const pkg = JSON.stringify({ name: "pkg", version: "1.0.0", [mapName]: deps }, null, 2);
  const findings = await scanRaw(pkg);
  return findings
    .map((f) => /dependency `([^`]+)`/.exec(f.message)?.[1] ?? "")
    .filter((n) => n.length > 0)
    .sort();
};

/** Does a single { name: spec } dependency fire? */
const fires = async (spec: string): Promise<boolean> => (await flagged({ dep: spec })).length > 0;

describe("no-unpinned-dependency — FIRES on git refs / URLs", () => {
  test("github: shorthand", async () => assert.equal(await fires("github:foo/bar"), true));
  test("git+https URL ending in .git", async () => assert.equal(await fires("git+https://x.git"), true));
  test("plain https tarball URL", async () => assert.equal(await fires("https://x/y.tgz"), true));
  test("git: protocol URL", async () => assert.equal(await fires("git://github.com/foo/bar"), true));
  test("gitlab: shorthand", async () => assert.equal(await fires("gitlab:foo/bar"), true));
  test("bitbucket: shorthand", async () => assert.equal(await fires("bitbucket:foo/bar"), true));
  test("owner/repo#ref shorthand", async () => assert.equal(await fires("foo/bar#semver:^1.0.0"), true));
});

describe("no-unpinned-dependency — FIRES on floating wildcards / dist-tags", () => {
  test("bare *", async () => assert.equal(await fires("*"), true));
  test("bare x", async () => assert.equal(await fires("x"), true));
  test("latest", async () => assert.equal(await fires("latest"), true));
  test("next", async () => assert.equal(await fires("next"), true));
  test("beta", async () => assert.equal(await fires("beta"), true));
  test("canary", async () => assert.equal(await fires("canary"), true));
  test("empty spec", async () => assert.equal(await fires(""), true));
});

describe("no-unpinned-dependency — DELIBERATE SILENCE on registry ranges", () => {
  test("caret range ^1.2.3", async () => assert.equal(await fires("^1.2.3"), false));
  test("tilde range ~1.0", async () => assert.equal(await fires("~1.0"), false));
  test("exact 1.2.3", async () => assert.equal(await fires("1.2.3"), false));
  test("comparator range >=1 <2", async () => assert.equal(await fires(">=1 <2"), false));
  test("x inside a range 1.2.x (pins the major/minor)", async () => assert.equal(await fires("1.2.x"), false));
  test("x inside a range 1.x", async () => assert.equal(await fires("1.x"), false));
});

describe("no-unpinned-dependency — DELIBERATE SILENCE on intentional protocols", () => {
  test("workspace:*", async () => assert.equal(await fires("workspace:*"), false));
  test("workspace:^", async () => assert.equal(await fires("workspace:^"), false));
  test("file:../local", async () => assert.equal(await fires("file:../local"), false));
  test("link:../local", async () => assert.equal(await fires("link:../local"), false));
  test("portal:../local", async () => assert.equal(await fires("portal:../local"), false));
  test("catalog: (pnpm catalog)", async () => assert.equal(await fires("catalog:"), false));
  test("npm: alias to a semver", async () => assert.equal(await fires("npm:other@^1"), false));
  test("file: path that happens to end in .git is not a git URL", async () =>
    assert.equal(await fires("file:../my-repo.git"), false));
});

describe("no-unpinned-dependency — the combined spec set", () => {
  test("flags exactly the offending entries and nothing else", async () => {
    const deps = {
      a: "github:foo/bar",
      b: "*",
      c: "latest",
      d: "git+https://x.git",
      e: "https://x/y.tgz",
      f: "^1.2.3",
      g: "~1.0",
      h: "1.2.x",
      i: "workspace:*",
      j: "file:../local",
      k: ">=1 <2",
      l: "npm:other@^1",
    };
    assert.deepEqual(await flagged(deps), ["a", "b", "c", "d", "e"]);
  });
});

describe("no-unpinned-dependency — map coverage & robustness", () => {
  test("scans devDependencies", async () => {
    assert.deepEqual(await flagged({ tool: "*" }, "devDependencies"), ["tool"]);
  });
  test("scans optionalDependencies", async () => {
    assert.deepEqual(await flagged({ opt: "latest" }, "optionalDependencies"), ["opt"]);
  });
  test("scans peerDependencies", async () => {
    assert.deepEqual(await flagged({ peer: "git+https://x.git" }, "peerDependencies"), ["peer"]);
  });
  test("ignores unrelated top-level fields (scripts, resolutions)", async () => {
    const pkg = JSON.stringify({
      name: "p",
      version: "1.0.0",
      scripts: { build: "latest" },
      dependencies: { real: "^1.0.0" },
    });
    assert.deepEqual((await scanRaw(pkg)).map((f) => f.diagnostic), []);
  });
  test("reports nothing on a malformed package.json", async () => {
    assert.deepEqual((await scanRaw("{ not: valid json ")).length, 0);
  });
  test("reports the line of the offending entry", async () => {
    const pkg = ['{', '  "name": "p",', '  "dependencies": {', '    "bad": "*"', "  }", "}"].join("\n");
    const findings = await scanRaw(pkg);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.line, 4); // the `"bad": "*"` line
    assert.match(findings[0]!.message, /floating tag/);
  });
});
