/**
 * §159 — Suspicious-Change-Shape Detection.
 *
 * This report makes no claim about correctness, so it cannot produce a false
 * positive in the finding sense. What it CAN do is cry wolf — and a review
 * signal that fires on ordinary edits is worse than no signal, because the next
 * reviewer learns to skip it. So the silent cases are the specification: every
 * one is an edit that genuinely does not deserve a second pair of eyes.
 *
 * Every test drives a real git repository through the real `git diff`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { buildChangeShapeReport } from "../../src/core/change-shape.ts";

const run = promisify(execFile);

/** A repo with a base commit and then one more commit; diffed HEAD~1...HEAD. */
const makeChange = async (
  before: Record<string, string>,
  after: Record<string, string | null>,
): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "nd-shape-"));
  await run("git", ["init", "-q"], { cwd: dir });
  await run("git", ["config", "user.email", "dev@example.com"], { cwd: dir });
  await run("git", ["config", "user.name", "Dev"], { cwd: dir });
  const write = async (files: Record<string, string>): Promise<void> => {
    for (const [rel, content] of Object.entries(files)) {
      const full = join(dir, rel);
      await mkdir(join(full, ".."), { recursive: true });
      await writeFile(full, content);
    }
  };
  await write(before);
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", ["commit", "-q", "-m", "base"], { cwd: dir });

  for (const [rel, content] of Object.entries(after)) {
    if (content === null) await rm(join(dir, rel), { force: true });
    else await write({ [rel]: content });
  }
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", ["commit", "-q", "-m", "change"], { cwd: dir });
  return dir;
};

const shapesFor = async (
  before: Record<string, string>,
  after: Record<string, string | null>,
): Promise<string[]> => {
  const dir = await makeChange(before, after);
  try {
    const r = await buildChangeShapeReport(dir, { base: "HEAD~1" });
    assert.equal(r.available, true, r.unavailableReason ?? "");
    return r.notes.map((n) => n.shape);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe("change-shape — a diff that cannot be read is not a clean diff", () => {
  test("a directory that is not a repository reports unavailable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-shape-bare-"));
    try {
      const r = await buildChangeShapeReport(dir);
      assert.equal(r.available, false);
      assert.equal(r.unavailableReason, "not a git work tree");
      assert.deepEqual(r.notes, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an unreachable base ref is unavailable, not clean", async () => {
    const dir = await makeChange({ "a.ts": "1\n" }, { "a.ts": "2\n" });
    try {
      const r = await buildChangeShapeReport(dir, { base: "no-such-branch" });
      assert.equal(r.available, false);
      assert.match(r.unavailableReason!, /base ref/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("change-shape — .env.example keys", () => {
  test("a removed key is flagged", async () => {
    const shapes = await shapesFor(
      { ".env.example": "DATABASE_URL=\nSTRIPE_KEY=\nPORT=3000\n" },
      { ".env.example": "DATABASE_URL=\nPORT=3000\n" },
    );
    assert.deepEqual(shapes, ["env-example-key-removed"]);
  });

  test("a RENAMED key is not a removal", async () => {
    const shapes = await shapesFor(
      { ".env.example": "STRIPE_KEY=\n" },
      { ".env.example": "STRIPE_KEY=\nSTRIPE_SECRET_KEY=\n" },
    );
    assert.deepEqual(shapes, [], "adding alongside is not removing");
  });

  test("adding a key, reordering, and editing a value are all ordinary", async () => {
    assert.deepEqual(await shapesFor({ ".env.example": "A=\n" }, { ".env.example": "A=\nB=\n" }), []);
    assert.deepEqual(await shapesFor({ ".env.example": "A=\nB=\n" }, { ".env.example": "B=\nA=\n" }), []);
    assert.deepEqual(await shapesFor({ ".env.example": "A=1\n" }, { ".env.example": "A=2\n" }), []);
  });

  test("a real `.env` is not a template and is not examined for this shape", async () => {
    assert.deepEqual(await shapesFor({ ".env": "A=\nB=\n" }, { ".env": "A=\n" }), []);
  });

  test("a comment line is not a key", async () => {
    assert.deepEqual(
      await shapesFor({ ".env.example": "# STRIPE_KEY=\nA=\n" }, { ".env.example": "A=\n" }),
      [],
    );
  });
});

describe("change-shape — dependency specs", () => {
  const pkg = (deps: Record<string, string>) =>
    JSON.stringify({ name: "app", version: "1.0.0", dependencies: deps }, null, 2) + "\n";

  test("pinned → floating is flagged", async () => {
    const shapes = await shapesFor(
      { "package.json": pkg({ express: "4.19.2" }) },
      { "package.json": pkg({ express: "latest" }) },
    );
    assert.deepEqual(shapes, ["dependency-unpinned"]);
  });

  test("a range → a git spec is flagged", async () => {
    const shapes = await shapesFor(
      { "package.json": pkg({ lib: "^2.0.0" }) },
      { "package.json": pkg({ lib: "github:acme/lib#main" }) },
    );
    assert.deepEqual(shapes, ["dependency-unpinned"]);
  });

  test("ordinary version bumps are silent", async () => {
    assert.deepEqual(
      await shapesFor({ "package.json": pkg({ express: "4.19.2" }) }, { "package.json": pkg({ express: "4.20.0" }) }),
      [],
    );
    assert.deepEqual(
      await shapesFor({ "package.json": pkg({ express: "^4.19.2" }) }, { "package.json": pkg({ express: "~4.19.2" }) }),
      [],
    );
  });

  test("a workspace or file protocol is deliberate, not floating", async () => {
    assert.deepEqual(
      await shapesFor({ "package.json": pkg({ core: "1.0.0" }) }, { "package.json": pkg({ core: "workspace:*" }) }),
      [],
    );
    assert.deepEqual(
      await shapesFor({ "package.json": pkg({ core: "1.0.0" }) }, { "package.json": pkg({ core: "file:../core" }) }),
      [],
    );
  });

  test("adding a floating dependency is not UN-pinning one", async () => {
    // The shape is a loosening. A new dependency has no previous state to
    // loosen, and `no-unpinned-dependency` already reports it as a finding.
    assert.deepEqual(
      await shapesFor({ "package.json": pkg({ a: "1.0.0" }) }, { "package.json": pkg({ a: "1.0.0", b: "*" }) }),
      [],
    );
  });

  test("a lockfile churning is never examined", async () => {
    assert.deepEqual(
      await shapesFor({ "package-lock.json": `{"a":"1.0.0"}\n` }, { "package-lock.json": `{"a":"*"}\n` }),
      [],
    );
  });
});

describe("change-shape — small edits to the auth path", () => {
  const AUTH = `export const requireAuth = (req, res, next) => {\n  if (!req.user) return res.status(401).end();\n  next();\n};\n`;

  test("a one-line change to an auth file is flagged", async () => {
    const shapes = await shapesFor(
      { "src/middleware/auth.ts": AUTH },
      { "src/middleware/auth.ts": AUTH.replace("!req.user", "!req.user && !req.apiKey") },
    );
    assert.deepEqual(shapes, ["small-auth-edit"]);
  });

  test("a comment-only or blank-line change is not a substantive edit", async () => {
    assert.deepEqual(
      await shapesFor(
        { "src/auth.ts": AUTH },
        { "src/auth.ts": `// updated 2026\n${AUTH}` },
      ),
      [],
    );
    assert.deepEqual(await shapesFor({ "src/auth.ts": AUTH }, { "src/auth.ts": `\n${AUTH}` }), []);
  });

  test("an import-only change is not a substantive edit", async () => {
    assert.deepEqual(
      await shapesFor({ "src/auth.ts": AUTH }, { "src/auth.ts": `import { x } from "./x.ts";\n${AUTH}` }),
      [],
    );
  });

  test("a LARGE rewrite of an auth file is not this shape", async () => {
    // The shape is "small edit, easy to skim past". A visible rewrite gets
    // read on its own merits.
    const big = Array.from({ length: 20 }, (_, i) => `const line${i} = ${i};`).join("\n");
    assert.deepEqual(await shapesFor({ "src/auth.ts": AUTH }, { "src/auth.ts": `${AUTH}${big}\n` }), []);
  });

  test("a file whose name merely contains a hint substring is not the auth path", async () => {
    // `authors`, `canonical`, `roles-page` — segment-anchored matching.
    assert.deepEqual(
      await shapesFor({ "src/authors.ts": "export const a = 1;\n" }, { "src/authors.ts": "export const a = 2;\n" }),
      [],
    );
    assert.deepEqual(
      await shapesFor({ "src/canonical.ts": "export const a = 1;\n" }, { "src/canonical.ts": "export const a = 2;\n" }),
      [],
    );
  });

  test("an ordinary one-line change to an ordinary file is silent", async () => {
    assert.deepEqual(
      await shapesFor({ "src/orders.ts": "export const a = 1;\n" }, { "src/orders.ts": "export const a = 2;\n" }),
      [],
    );
  });

  test("a NEW auth file is not a small edit to an existing one", async () => {
    assert.deepEqual(await shapesFor({ "src/x.ts": "1\n" }, { "src/auth.ts": AUTH }), []);
  });
});

describe("change-shape — migrations mixed with feature work", () => {
  test("a migration changed alongside source is notable", async () => {
    const shapes = await shapesFor(
      { "src/orders.ts": "export const a = 1;\n" },
      {
        "src/orders.ts": "export const a = 2;\n",
        "migrations/20240101_add_column.sql": "ALTER TABLE orders ADD COLUMN x int;\n",
      },
    );
    assert.deepEqual(shapes, ["migration-with-feature-work"]);
  });

  test("a migration on its own is exactly the right shape", async () => {
    assert.deepEqual(
      await shapesFor({ "README.md": "x\n" }, { "migrations/20240101_a.sql": "ALTER TABLE t ADD COLUMN x int;\n" }),
      [],
    );
  });

  test("source on its own is ordinary", async () => {
    assert.deepEqual(
      await shapesFor({ "src/a.ts": "export const a = 1;\n" }, { "src/a.ts": "export const a = 2;\n" }),
      [],
    );
  });

  test("one note per change set, not one per file", async () => {
    const dir = await makeChange(
      { "src/a.ts": "1\n" },
      {
        "src/a.ts": "2\n",
        "src/b.ts": "3\n",
        "migrations/1_a.sql": "ALTER TABLE t ADD COLUMN x int;\n",
        "migrations/2_b.sql": "ALTER TABLE t ADD COLUMN y int;\n",
      },
    );
    try {
      const r = await buildChangeShapeReport(dir, { base: "HEAD~1" });
      assert.equal(r.notes.filter((n) => n.shape === "migration-with-feature-work").length, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("change-shape — determinism and scoping", () => {
  test("identical input yields identical output", async () => {
    const dir = await makeChange(
      {
        ".env.example": "A=\nB=\n",
        "package.json": `{\n  "dependencies": {\n    "x": "1.0.0"\n  }\n}\n`,
      },
      {
        ".env.example": "A=\n",
        "package.json": `{\n  "dependencies": {\n    "x": "latest"\n  }\n}\n`,
      },
    );
    try {
      const a = await buildChangeShapeReport(dir, { base: "HEAD~1" });
      const b = await buildChangeShapeReport(dir, { base: "HEAD~1" });
      assert.equal(JSON.stringify(a), JSON.stringify(b));
      assert.equal(a.notes.length, 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("scanning a subdirectory sees only its own changes", async () => {
    const dir = await makeChange(
      { "packages/api/.env.example": "A=\nB=\n", "packages/web/.env.example": "C=\nD=\n" },
      { "packages/api/.env.example": "A=\n", "packages/web/.env.example": "C=\n" },
    );
    try {
      const r = await buildChangeShapeReport(join(dir, "packages/api"), { base: "HEAD~1" });
      assert.equal(r.notes.length, 1, "the sibling package's change is not this scan's business");
      assert.equal(r.notes[0]!.normalizedFilePath, ".env.example", "paths are rebased onto the scan root");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a staged change set is readable", async () => {
    const dir = await makeChange({ ".env.example": "A=\nB=\nC=\n" }, { ".env.example": "A=\nB=\n" });
    try {
      await writeFile(join(dir, ".env.example"), "A=\n");
      await run("git", ["add", "-A"], { cwd: dir });
      const r = await buildChangeShapeReport(dir, { staged: true });
      assert.equal(r.available, true);
      assert.deepEqual(
        r.notes.map((n) => n.shape),
        ["env-example-key-removed"],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("change-shape — hardened against the adversarial hunt", () => {
  const pkg = (extra: Record<string, unknown>) =>
    JSON.stringify({ name: "app", version: "1.0.0", ...extra }, null, 2) + "\n";

  test("only a real dependency entry can be un-pinned", async () => {
    // The first version fired on any `"key": "value"` line: an npm script, an
    // `engines` entry, `repository` metadata. The manifest is now read so the
    // section is a fact rather than a guess.
    assert.deepEqual(
      await shapesFor(
        { "package.json": pkg({ scripts: { test: "node --test" } }) },
        { "package.json": pkg({ scripts: { test: "*" } }) },
      ),
      [],
      "an npm script is not a dependency",
    );
    assert.deepEqual(
      await shapesFor(
        { "package.json": pkg({ engines: { node: ">=20" } }) },
        { "package.json": pkg({ engines: { node: "*" } }) },
      ),
      [],
      "an engines range is not a dependency",
    );
    assert.deepEqual(
      await shapesFor(
        { "package.json": pkg({ repository: "git+https://github.com/a/b.git" }) },
        { "package.json": pkg({ repository: "github:a/b" }) },
      ),
      [],
      "repository metadata is not a dependency",
    );
  });

  test("un-pinning two dependencies in one hunk reports both", async () => {
    const shapes = await shapesFor(
      { "package.json": pkg({ dependencies: { a: "1.0.0", b: "2.0.0" } }) },
      { "package.json": pkg({ dependencies: { a: "latest", b: "*" } }) },
    );
    assert.deepEqual(shapes, ["dependency-unpinned", "dependency-unpinned"]);
  });

  test("ordinary paths are no longer called the authentication path", async () => {
    // Twelve of eighteen ordinary paths matched the first vocabulary.
    const AUTH = `export const f = (req, res, next) => {\n  if (!req.user) return res.status(401).end();\n  next();\n};\n`;
    for (const path of [
      "src/retry-policy.ts",
      "src/policies/refund.ts",
      "src/session-storage.ts",
      "src/router/guards.ts",
      "src/admin-dashboard/index.ts",
      "src/roles-dropdown.tsx",
      "src/permissions-table.tsx",
      "src/can-i-help.ts",
      "src/authors/index.ts",
      "src/canonical-url.ts",
    ]) {
      assert.deepEqual(
        await shapesFor({ [path]: AUTH }, { [path]: AUTH.replace("401", "403") }),
        [],
        `expected ${path} not to be treated as the auth path`,
      );
    }
  });

  test("a real auth path is still flagged", async () => {
    const AUTH = `export const requireAuth = (req, res, next) => {\n  if (!req.user) return res.status(401).end();\n  next();\n};\n`;
    for (const path of ["src/middleware/auth.ts", "src/authorize.ts", "src/jwt-verify.ts", "src/oauth/callback.ts"]) {
      assert.deepEqual(
        await shapesFor({ [path]: AUTH }, { [path]: AUTH.replace("!req.user", "!req.user && !req.apiKey") }),
        ["small-auth-edit"],
        `expected ${path} to be treated as the auth path`,
      );
    }
  });

  test("git's `@@` heading is a guess and no longer gates the auth shape", async () => {
    const src = `export function canSubmit(form) {\n  return form.valid;\n}\n`;
    assert.deepEqual(
      await shapesFor({ "src/forms.ts": src }, { "src/forms.ts": src.replace("form.valid", "form.ok") }),
      [],
    );
  });

  test("a key moved to another template file is not a removal", async () => {
    assert.deepEqual(
      await shapesFor(
        { ".env.example": "A=\nSTRIPE_KEY=\n" },
        { ".env.example": "A=\n", ".env.sample": "STRIPE_KEY=\n" },
      ),
      [],
      "removed here, added there — a split, not a removal",
    );
  });

  test("a key commented out is still documented", async () => {
    assert.deepEqual(
      await shapesFor({ ".env.example": "A=\nSTRIPE_KEY=\n" }, { ".env.example": "A=\n# STRIPE_KEY=\n" }),
      [],
    );
  });

  test("a migration and its own test are one change, not mixed work", async () => {
    assert.deepEqual(
      await shapesFor(
        { "README.md": "x\n" },
        {
          "migrations/1_add.sql": "ALTER TABLE t ADD COLUMN x int;\n",
          "tests/migrations/1_add.test.ts": "test('migrates', () => {});\n",
        },
      ),
      [],
    );
  });

  test("untracked files are counted, so a green result cannot mean `all clear`", async () => {
    const dir = await makeChange({ "a.ts": "1\n" }, { "a.ts": "2\n" });
    try {
      await writeFile(join(dir, "brand-new.ts"), "export const x = 1;\n");
      const r = await buildChangeShapeReport(dir);
      assert.equal(r.available, true);
      assert.equal(r.summary.untrackedFilesNotExamined, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
