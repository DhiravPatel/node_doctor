import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseJsonc,
  loadConfigWithSource,
  globToRegExp,
  settingsForFile,
} from "../../src/core/config.ts";
import { scanProject } from "../../src/core/scan.ts";
import { applyConfigActions, parseConfigAction } from "../../src/cli/config-writer.ts";

/** A temp project root with a `.git` marker so config walk-up stops here. */
const makeProject = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "nd-cfg-"));
  await mkdir(join(dir, ".git"), { recursive: true });
  return dir;
};

// ---------------------------------------------------------------------------
// JSONC
// ---------------------------------------------------------------------------

describe("parseJsonc", () => {
  test("strips line + block comments and trailing commas", () => {
    const parsed = parseJsonc(`{
      // a line comment
      "diagnostics": { "no-eval-with-input": "off", }, /* trailing */
      "ignoreTags": ["security",],
    }`) as { diagnostics: Record<string, string>; ignoreTags: string[] };
    assert.equal(parsed.diagnostics["no-eval-with-input"], "off");
    assert.deepEqual(parsed.ignoreTags, ["security"]);
  });
  test("leaves // inside strings intact", () => {
    const parsed = parseJsonc(`{ "ignore": ["https://example.com/x"] }`) as { ignore: string[] };
    assert.deepEqual(parsed.ignore, ["https://example.com/x"]);
  });
});

// ---------------------------------------------------------------------------
// Config resolution: walk-up + formats
// ---------------------------------------------------------------------------

describe("loadConfigWithSource", () => {
  test("JSON config is found and its source + format reported", async () => {
    const dir = await makeProject();
    try {
      await writeFile(join(dir, "node-doctor.config.json"), `{ "blocking": "warning" }`);
      const loaded = await loadConfigWithSource(dir);
      assert.equal(loaded.format, "json");
      assert.equal(loaded.config.blocking, "warning");
      assert.ok(loaded.sourcePath?.endsWith("node-doctor.config.json"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("walks up from a nested directory to the repo-root config", async () => {
    const dir = await makeProject();
    try {
      await writeFile(join(dir, "node-doctor.config.json"), `{ "ignoreTags": ["maintainability"] }`);
      await mkdir(join(dir, "packages", "api"), { recursive: true });
      const loaded = await loadConfigWithSource(join(dir, "packages", "api"));
      assert.deepEqual(loaded.config.ignoreTags, ["maintainability"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("package.json#nodeDoctor is picked up", async () => {
    const dir = await makeProject();
    try {
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", nodeDoctor: { blocking: "none" } }));
      const loaded = await loadConfigWithSource(dir);
      assert.equal(loaded.format, "package");
      assert.equal(loaded.config.blocking, "none");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Glob + per-path settings
// ---------------------------------------------------------------------------

describe("globToRegExp + settingsForFile", () => {
  test("** crosses directories; * does not", () => {
    assert.ok(globToRegExp("**/*.test.js").test("src/a/b.test.js"));
    assert.ok(!globToRegExp("*.test.js").test("src/a/b.test.js"));
    assert.ok(globToRegExp("*.test.js").test("b.test.js"));
  });
  test("overrides layer on top of base diagnostics", () => {
    const config = {
      diagnostics: { "no-eval-with-input": "off" as const },
      overrides: [{ files: ["a.js"], diagnostics: { "no-eval-with-input": "error" as const } }],
    };
    assert.equal(settingsForFile(config, "a.js")["no-eval-with-input"], "error");
    assert.equal(settingsForFile(config, "b.js")["no-eval-with-input"], "off");
  });
});

// ---------------------------------------------------------------------------
// Engine: per-path overrides can re-enable a globally-off diagnostic
// ---------------------------------------------------------------------------

describe("scanProject — per-path overrides", () => {
  test("override re-enables a globally-off diagnostic for matching files only", async () => {
    const dir = await makeProject();
    try {
      await writeFile(join(dir, "a.js"), "const x = eval(input);\n");
      await writeFile(join(dir, "b.js"), "const y = eval(other);\n");
      const report = await scanProject({
        rootDirectory: dir,
        config: {
          diagnostics: { "no-eval-with-input": "off" },
          overrides: [{ files: ["a.js"], diagnostics: { "no-eval-with-input": "error" } }],
        },
      });
      const evalFindings = report.findings.filter((f) => f.diagnostic === "no-eval-with-input");
      assert.equal(evalFindings.length, 1);
      assert.equal(evalFindings[0]!.normalizedFilePath, "a.js");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Config writer
// ---------------------------------------------------------------------------

describe("parseConfigAction", () => {
  test("recognizes verbs and validates", () => {
    assert.deepEqual(parseConfigAction(["disable", "no-eval-with-input"]), { kind: "disable", id: "no-eval-with-input" });
    assert.deepEqual(parseConfigAction(["set", "x", "warn"]), { kind: "set", id: "x", setting: "warn" });
    assert.equal(parseConfigAction(["/some/dir"]), undefined); // a directory, not a verb
    assert.match((parseConfigAction(["set", "x", "loud"]) as { error: string }).error, /off\|warn\|error/);
  });
});

describe("applyConfigActions", () => {
  test("creates node-doctor.config.json with $schema and the change", async () => {
    const dir = await makeProject();
    try {
      const result = await applyConfigActions(dir, [{ kind: "disable", id: "no-eval-with-input" }]);
      assert.equal(result.ok, true);
      assert.ok(result.path?.endsWith("node-doctor.config.json"));
      const written = JSON.parse(await readFile(result.path!, "utf8"));
      assert.equal(written.diagnostics["no-eval-with-input"], "off");
      assert.ok(typeof written.$schema === "string");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("category action re-severities every diagnostic in the category", async () => {
    const dir = await makeProject();
    try {
      const result = await applyConfigActions(dir, [{ kind: "category", category: "Performance", setting: "off" }]);
      assert.equal(result.ok, true);
      const written = JSON.parse(await readFile(result.path!, "utf8"));
      const offCount = Object.values(written.diagnostics).filter((v) => v === "off").length;
      assert.ok(offCount >= 5, `expected several Performance diagnostics off, got ${offCount}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("unknown diagnostic id is rejected", async () => {
    const dir = await makeProject();
    try {
      const result = await applyConfigActions(dir, [{ kind: "set", id: "no-such-rule", setting: "warn" }]);
      assert.equal(result.ok, false);
      assert.match(result.messages[0]!, /unknown diagnostic/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("an executable JS config is not edited — the block is printed instead", async () => {
    const dir = await makeProject();
    try {
      await writeFile(join(dir, "node-doctor.config.js"), "export default { diagnostics: {} };\n");
      const result = await applyConfigActions(dir, [{ kind: "disable", id: "no-eval-with-input" }]);
      assert.equal(result.ok, false);
      assert.equal(result.exitCode, 1);
      assert.match(result.printBlock!, /no-eval-with-input.*off/s);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
