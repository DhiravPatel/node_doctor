import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs } from "../../src/cli/args.ts";

const BIN = fileURLToPath(new URL("../../bin/node-doctor.js", import.meta.url));

const runCli = (cliArgs: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [BIN, ...cliArgs], { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolvePromise({ code: code ?? 0, stdout, stderr }));
  });

const makeExposedFixture = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "nd-context-cli-"));
  // Classified by name; the value is never inspected, so keep it a placeholder.
  await writeFile(join(dir, ".env"), "API_KEY=local-dev-placeholder\n");
  await writeFile(join(dir, "server.pem"), "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n");
  return dir;
};

// ---------------------------------------------------------------------------
// §158 — `context` subcommand parsing
// ---------------------------------------------------------------------------

describe("parseArgs — context command", () => {
  test("`context` is a recognized subcommand and --write sets the flag", () => {
    assert.equal(parseArgs(["context"]).command, "context");
    assert.equal(parseArgs(["context"]).write, false);
    assert.equal(parseArgs(["context", "--write"]).write, true);
  });
});

// ---------------------------------------------------------------------------
// §158 — end-to-end CLI
// ---------------------------------------------------------------------------

describe("CLI — node-doctor context", () => {
  test("reports exposed files and exits 1 (blocking by default)", async () => {
    const dir = await makeExposedFixture();
    try {
      const { code, stdout } = await runCli(["context", dir]);
      assert.equal(code, 1, "exposed secrets fail the gate");
      assert.match(stdout, /sensitive file/i);
      assert.match(stdout, /\.env/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("--blocking none reports but exits 0", async () => {
    const dir = await makeExposedFixture();
    try {
      const { code } = await runCli(["context", dir, "--blocking", "none"]);
      assert.equal(code, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("--json emits a parseable report", async () => {
    const dir = await makeExposedFixture();
    try {
      const { stdout } = await runCli(["context", dir, "--json", "--blocking", "none"]);
      const report = JSON.parse(stdout) as { exposed: Array<{ normalizedPath: string }> };
      assert.ok(report.exposed.some((f) => f.normalizedPath === ".env"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("--write generates the artifacts, then a clean re-scan exits 0", async () => {
    const dir = await makeExposedFixture();
    try {
      const write = await runCli(["context", dir, "--write"]);
      assert.equal(write.code, 0);
      assert.match(write.stdout, /wrote .*\.aiignore/);

      // The artifacts exist and carry the managed block.
      const aiignore = await readFile(join(dir, ".aiignore"), "utf8");
      assert.match(aiignore, /agent-context-hygiene/);
      const claude = JSON.parse(await readFile(join(dir, ".claude", "settings.json"), "utf8")) as {
        permissions: { deny: string[] };
      };
      assert.ok(claude.permissions.deny.some((r) => r.startsWith("Read(")));

      // Now that everything is fenced off, a plain scan is clean.
      const rescan = await runCli(["context", dir]);
      assert.equal(rescan.code, 0);
      assert.match(rescan.stdout, /No sensitive files exposed/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
