import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { buildSbom, collectComponents } from "../../src/core/sbom.ts";
import { scanGitHistoryForSecrets } from "../../src/core/git-history-secrets.ts";

// Assembled at runtime so this file never holds a scannable provider-key literal.
const LIVE_KEY = `sk_${"live"}_9aBcDeFgHiJkLmNoPqRsTuVw`;

const project = async (files: Record<string, string>): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "nd-w13-"));
  for (const [name, body] of Object.entries(files)) {
    const full = join(dir, name);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, body);
  }
  return dir;
};

// ---------------------------------------------------------------------------
// §67 SBOM
// ---------------------------------------------------------------------------

describe("SBOM (§67)", () => {
  test("classifies prod vs dev and resolves versions from package-lock", async () => {
    const dir = await project({
      "package.json": JSON.stringify({
        name: "app",
        dependencies: { express: "^4.18.0" },
        devDependencies: { typescript: "^5.0.0" },
      }),
      "package-lock.json": JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "node_modules/express": { version: "4.18.2" },
          "node_modules/typescript": { version: "5.4.5" },
        },
      }),
    });
    try {
      const c = await collectComponents(dir);
      const express = c.find((x) => x.name === "express")!;
      const ts = c.find((x) => x.name === "typescript")!;
      assert.equal(express.version, "4.18.2", "resolved from the lockfile, not the range");
      assert.equal(express.dev, false);
      assert.equal(ts.dev, true);
      assert.deepEqual(c.map((x) => x.name), [...c.map((x) => x.name)].sort(), "sorted");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("scoped package purl percent-encodes the @", async () => {
    const dir = await project({
      "package.json": JSON.stringify({ name: "a", dependencies: { "@scope/pkg": "1.0.0" } }),
    });
    try {
      const [c] = await collectComponents(dir);
      assert.equal(c!.purl, "pkg:npm/%40scope/pkg@1.0.0");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("emits valid CycloneDX 1.5 and SPDX 2.3, deterministically", async () => {
    const dir = await project({
      "package.json": JSON.stringify({ name: "a", dependencies: { express: "4.18.2" } }),
    });
    try {
      const cdx = JSON.parse(await buildSbom(dir, { format: "cyclonedx" }));
      assert.equal(cdx.bomFormat, "CycloneDX");
      assert.equal(cdx.specVersion, "1.5");
      assert.equal(cdx.components[0].type, "library");

      const spdx = JSON.parse(await buildSbom(dir, { format: "spdx" }));
      assert.equal(spdx.spdxVersion, "SPDX-2.3");
      assert.ok(Array.isArray(spdx.packages));

      const a = await buildSbom(dir, { format: "cyclonedx" });
      const b = await buildSbom(dir, { format: "cyclonedx" });
      assert.equal(a, b, "byte-identical across runs");
      assert.ok(!a.includes(dir), "no absolute machine path in the document");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a project with no dependencies, and a malformed lockfile, do not throw", async () => {
    const empty = await project({ "package.json": JSON.stringify({ name: "a" }) });
    const broken = await project({
      "package.json": JSON.stringify({ name: "a", dependencies: { express: "^4.0.0" } }),
      "package-lock.json": "{ this is not json",
    });
    try {
      assert.deepEqual(await collectComponents(empty), []);
      const c = await collectComponents(broken);
      assert.equal(c[0]!.name, "express", "falls back to the declared range");
    } finally {
      await rm(empty, { recursive: true, force: true });
      await rm(broken, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// §68 git-history secret scanning
// ---------------------------------------------------------------------------

const gitRepo = async (): Promise<string | null> => {
  const dir = await mkdtemp(join(tmpdir(), "nd-hist-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@t.co"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    return dir;
  } catch {
    return null; // git unavailable — caller skips
  }
};

describe("git-history secrets (§68)", () => {
  test("finds a secret committed then deleted, and NEVER emits its value", async () => {
    const dir = await gitRepo();
    if (!dir) return;
    try {
      await writeFile(join(dir, ".env"), `STRIPE_SECRET_KEY=${LIVE_KEY}\n`);
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-qm", "add"], { cwd: dir });
      await rm(join(dir, ".env"));
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-qm", "remove"], { cwd: dir });

      const hits = await scanGitHistoryForSecrets(dir);
      assert.equal(hits.length, 1, "still in history even though the file is gone");
      assert.equal(hits[0]!.kind, "provider-key");
      assert.equal(hits[0]!.removedFromHead, true, "the actionable signal: deleted but not rotated");
      assert.equal(hits[0]!.label, "STRIPE_SECRET_KEY");

      // The single most important guarantee.
      assert.ok(!JSON.stringify(hits).includes(LIVE_KEY), "the secret value must never reach the report");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a placeholder in .env.example is not a secret", async () => {
    const dir = await gitRepo();
    if (!dir) return;
    try {
      await writeFile(join(dir, ".env.example"), "STRIPE_SECRET_KEY=your_key_here\n");
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-qm", "example"], { cwd: dir });
      assert.deepEqual(await scanGitHistoryForSecrets(dir), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a published documentation example key is not a secret", async () => {
    const dir = await gitRepo();
    if (!dir) return;
    try {
      // AWS ships this exact value in its own docs; GitHub's scanner ignores it too.
      await writeFile(join(dir, "README.md"), "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n");
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-qm", "docs"], { cwd: dir });
      assert.deepEqual(await scanGitHistoryForSecrets(dir), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a PEM header quoted in prose is not a key (needs real body)", async () => {
    const dir = await gitRepo();
    if (!dir) return;
    try {
      await writeFile(join(dir, "doc.ts"), '/**\n * Example: -----BEGIN RSA PRIVATE KEY-----\n */\nexport const x = 1;\n');
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-qm", "doc"], { cwd: dir });
      assert.deepEqual(await scanGitHistoryForSecrets(dir), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a non-git directory returns [] rather than throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-nogit-"));
    try {
      assert.deepEqual(await scanGitHistoryForSecrets(dir), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("results are deterministic", async () => {
    const dir = await gitRepo();
    if (!dir) return;
    try {
      await writeFile(join(dir, ".env"), `A_TOKEN=${LIVE_KEY}\n`);
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-qm", "c"], { cwd: dir });
      const a = await scanGitHistoryForSecrets(dir);
      const b = await scanGitHistoryForSecrets(dir);
      assert.deepEqual(a, b);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
