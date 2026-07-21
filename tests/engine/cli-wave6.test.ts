import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { runTextScan, type TextDiagnostic, type TextScanContext } from "../../src/core/text-scan.ts";
import { TEXT_DIAGNOSTICS } from "../../src/diagnostics/secrets/index.ts";
import { noCommittedEnvSecret } from "../../src/diagnostics/secrets/no-committed-env-secret.ts";
import { noCommittedPrivateKey } from "../../src/diagnostics/secrets/no-committed-private-key.ts";
import { noSecretInConfigFile } from "../../src/diagnostics/secrets/no-secret-in-config-file.ts";
import { secretInAssignment, cleanValue } from "../../src/core/secret-patterns.ts";
import { scanProject } from "../../src/core/scan.ts";

// Assembled at runtime so this file never contains a contiguous, scannable
// provider-key literal — a committed example key is still a blocked secret.
// The runtime value still matches the detector's `sk_live_[A-Za-z0-9]{16,}` shape.
const STRIPE = `sk_${"live"}_${"EXAMPLE".repeat(4)}`;
// AWS's official public documentation example key (explicitly not a real credential).
const AWS = "AKIAIOSFODNN7EXAMPLE";

/** Run one text diagnostic's scan() against fabricated content (no fs/git). */
const runScan = (diag: TextDiagnostic, content: string, normalizedFilePath: string, committed = true): Array<{ line: number; message: string }> => {
  const found: Array<{ line: number; message: string }> = [];
  const ctx: TextScanContext = {
    filePath: `/x/${normalizedFilePath}`,
    normalizedFilePath,
    content,
    committed,
    report: (f) => found.push({ line: f.line, message: f.message }),
  };
  diag.scan(ctx);
  return found;
};

// ---------------------------------------------------------------------------
// secret-patterns helpers
// ---------------------------------------------------------------------------

describe("secret patterns", () => {
  test("cleanValue strips quotes and unquoted inline comments", () => {
    assert.equal(cleanValue('  "abc123"  '), "abc123");
    assert.equal(cleanValue("abc123  # a comment"), "abc123");
    assert.equal(cleanValue('"a b # not a comment"'), "a b # not a comment");
  });
  test("secretInAssignment flags provider keys and secret-named values, not placeholders", () => {
    assert.ok(secretInAssignment("STRIPE_KEY", STRIPE));
    assert.ok(secretInAssignment("password", "S3cr3t!longEnoughValue"));
    assert.equal(secretInAssignment("password", "changeme"), null);
    assert.equal(secretInAssignment("greeting", "hello world"), null);
    assert.equal(secretInAssignment("port", "3000"), null);
  });
});

// ---------------------------------------------------------------------------
// no-committed-env-secret
// ---------------------------------------------------------------------------

describe("no-committed-env-secret", () => {
  test("fires on a provider key, stays silent on placeholder / env-ref / non-secret", () => {
    const content = [
      `STRIPE_SECRET_KEY=${STRIPE}`,
      "GREETING=hello",
      "DB_PASSWORD=$DB_PASS_REF",
      "API_KEY=changeme",
      "# COMMENT=ignore",
    ].join("\n");
    const found = runScan(noCommittedEnvSecret, content, ".env");
    assert.equal(found.length, 1);
    assert.equal(found[0]!.line, 1);
  });
  test("stays silent on a .env.example placeholder file", () => {
    assert.equal(runScan(noCommittedEnvSecret, `STRIPE_SECRET_KEY=${STRIPE}`, ".env.example").length, 0);
  });
});

// ---------------------------------------------------------------------------
// no-committed-private-key
// ---------------------------------------------------------------------------

describe("no-committed-private-key", () => {
  test("fires on a PEM private-key block", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
    assert.equal(runScan(noCommittedPrivateKey, pem, "server.key").length, 1);
  });
  test("stays silent on a .key file that is not a private key", () => {
    assert.equal(runScan(noCommittedPrivateKey, "translation.key=hello", "i18n/en.key").length, 0);
  });
});

// ---------------------------------------------------------------------------
// no-secret-in-config-file
// ---------------------------------------------------------------------------

describe("no-secret-in-config-file", () => {
  test("fires on a hardcoded provider key, silent on a secret reference", () => {
    const yaml = `env:\n  AWS_ACCESS_KEY_ID: ${AWS}\n  NPM_TOKEN: \${{ secrets.NPM_TOKEN }}\n`;
    const found = runScan(noSecretInConfigFile, yaml, ".github/workflows/ci.yml");
    assert.equal(found.length, 1);
    assert.equal(found[0]!.line, 2);
  });
});

// ---------------------------------------------------------------------------
// runTextScan integration (file discovery + config gating; no git needed)
// ---------------------------------------------------------------------------

describe("runTextScan", () => {
  test("discovers config files and reports hardcoded keys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-txt-"));
    try {
      await mkdir(join(dir, "deploy"), { recursive: true });
      await writeFile(join(dir, "deploy", "compose.yml"), `services:\n  db:\n    environment:\n      AWS: ${AWS}\n`);
      await writeFile(join(dir, "clean.yml"), "services:\n  web:\n    image: nginx\n");
      const findings = await runTextScan(dir, { textDiagnostics: [noSecretInConfigFile] });
      assert.equal(findings.length, 1);
      assert.equal(findings[0]!.normalizedFilePath, "deploy/compose.yml");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("config can turn a text diagnostic off", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-txt-off-"));
    try {
      await writeFile(join(dir, "c.yml"), `key: ${AWS}\n`);
      const findings = await runTextScan(dir, {
        textDiagnostics: [noSecretInConfigFile],
        config: { diagnostics: { "no-secret-in-config-file": "off" } },
      });
      assert.equal(findings.length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// committed-files-only gate (git integration) + scanProject wiring
// ---------------------------------------------------------------------------

describe("committed-files-only gate + scanProject integration", () => {
  test("a tracked .env is flagged; a gitignored/untracked one is not", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-git-"));
    try {
      try {
        execFileSync("git", ["init", "-q"], { cwd: dir });
      } catch {
        return; // git unavailable — skip this integration case
      }
      execFileSync("git", ["config", "user.email", "t@t.co"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
      await writeFile(join(dir, ".env"), `STRIPE_SECRET_KEY=${STRIPE}\n`);
      await writeFile(join(dir, ".gitignore"), ".env.local\n");
      await writeFile(join(dir, ".env.local"), `SECRET_KEY=${STRIPE}extra\n`);
      execFileSync("git", ["add", ".env", ".gitignore"], { cwd: dir });

      const report = await scanProject({ rootDirectory: dir });
      const envHits = report.findings.filter((f) => f.diagnostic === "no-committed-env-secret");
      assert.equal(envHits.length, 1);
      assert.equal(envHits[0]!.normalizedFilePath, ".env");

      // --no-secrets disables the whole text scan.
      const off = await scanProject({ rootDirectory: dir, secrets: false });
      assert.equal(off.findings.filter((f) => f.diagnostic === "no-committed-env-secret").length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("TEXT_DIAGNOSTICS all declare files + scan", () => {
    for (const d of TEXT_DIAGNOSTICS) {
      assert.ok(Array.isArray(d.files) && d.files.length > 0);
      assert.equal(typeof d.scan, "function");
    }
  });
});
