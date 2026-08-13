/**
 * §42 — pre-push hooks.
 *
 * Two hooks, deliberately different. `pre-commit` scans staged files only,
 * because a commit happens dozens of times a day and a full scan there is a tax
 * people uninstall rather than pay. `pre-push` scans the whole project, because
 * a push is rare and is the last point before the code becomes somebody else's
 * problem.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { installGitHook } from "../../src/install/git-hook.ts";
import { parseArgs } from "../../src/cli/args.ts";

const run = promisify(execFile);
const makeRepo = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "nd-hook-"));
  await run("git", ["init", "-q"], { cwd: dir });
  return dir;
};

describe("git hooks — each gets the scan that suits how often it runs", () => {
  test("pre-push scans the WHOLE project", async () => {
    const dir = await makeRepo();
    try {
      const result = await installGitHook({ cwd: dir, hook: "pre-push" });
      assert.equal(result.hook, "pre-push");
      assert.equal(result.action, "created");
      assert.match(result.path, /\.git\/hooks\/pre-push$/);
      const body = await readFile(result.path, "utf8");
      assert.match(body, /--blocking error/);
      assert.doesNotMatch(body, /--staged/);
      assert.match(body, /never blocks the push/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("pre-commit scans STAGED files only, and stays the default", async () => {
    const dir = await makeRepo();
    try {
      // A bare `--git-hook` keeps the behaviour it has always had.
      const result = await installGitHook({ cwd: dir });
      assert.equal(result.hook, "pre-commit");
      const body = await readFile(result.path, "utf8");
      assert.match(body, /--staged --blocking warning/);
      assert.match(body, /never blocks the commit/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("both can coexist, each in its own file", async () => {
    const dir = await makeRepo();
    try {
      await installGitHook({ cwd: dir, hook: "pre-commit" });
      await installGitHook({ cwd: dir, hook: "pre-push" });
      assert.match(await readFile(join(dir, ".git/hooks/pre-commit"), "utf8"), /--staged/);
      assert.match(await readFile(join(dir, ".git/hooks/pre-push"), "utf8"), /--blocking error/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("git hooks — existing content survives", () => {
  test("re-running updates the block in place and leaves the rest alone", async () => {
    const dir = await makeRepo();
    try {
      const path = join(dir, ".git", "hooks", "pre-push");
      await mkdir(join(dir, ".git", "hooks"), { recursive: true });
      await writeFile(path, "#!/bin/sh\necho mine\n");
      const first = await installGitHook({ cwd: dir, hook: "pre-push" });
      assert.equal(first.action, "updated");
      const second = await installGitHook({ cwd: dir, hook: "pre-push" });
      assert.equal(second.action, "updated");
      const body = await readFile(path, "utf8");
      assert.match(body, /echo mine/, "the user's own line survives");
      assert.equal(body.match(/>>> node-doctor >>>/g)?.length, 1, "the block is replaced, not appended twice");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("husky's directory is preferred when the project uses it", async () => {
    const dir = await makeRepo();
    try {
      await mkdir(join(dir, ".husky"), { recursive: true });
      const result = await installGitHook({ cwd: dir, hook: "pre-push" });
      assert.match(result.path, /\.husky\/pre-push$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("git hooks — CLI parsing", () => {
  test("the kind is optional and validated", () => {
    assert.equal(parseArgs(["install", "--git-hook"]).gitHookKind, undefined);
    assert.equal(parseArgs(["install", "--git-hook", "pre-push"]).gitHookKind, "pre-push");
    assert.equal(parseArgs(["install", "--git-hook", "pre-commit"]).gitHookKind, "pre-commit");
    assert.match(parseArgs(["install", "--git-hook", "pre-merge"]).errors[0] ?? "", /pre-commit, pre-push/);
  });

  test("a directory after the flag is still the positional, not a kind", () => {
    const args = parseArgs(["install", "--git-hook", "./packages/api"]);
    assert.equal(args.gitHookKind, undefined);
    assert.deepEqual(args.positionals, ["./packages/api"]);
  });
});
