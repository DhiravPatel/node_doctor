import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scanProject } from "../../src/core/scan.ts";
import { runAgentFix, verifyFixes, renderVerifyResult, AGENTS } from "../../src/agent/fix.ts";
import { parseArgs } from "../../src/cli/args.ts";

const agentApp = fileURLToPath(new URL("../fixtures/agent-app", import.meta.url));
const goodApp = fileURLToPath(new URL("../fixtures/good-app", import.meta.url));

// ---------------------------------------------------------------------------
// §51 — enforced verification loop
// ---------------------------------------------------------------------------

describe("verifyFixes", () => {
  test("everything fixed → passes, all resolved, nothing introduced", async () => {
    const before = await scanProject({ rootDirectory: agentApp });
    const after = await scanProject({ rootDirectory: goodApp });
    const v = verifyFixes(before, after);
    assert.equal(v.originalCount, before.findings.length);
    assert.equal(v.resolvedCount, before.findings.length);
    assert.equal(v.remaining.length, 0);
    assert.equal(v.introduced.length, 0);
    assert.equal(v.passed, true);
  });

  test("agent did nothing → fails, everything still remaining", async () => {
    const before = await scanProject({ rootDirectory: agentApp });
    const v = verifyFixes(before, before);
    assert.equal(v.resolvedCount, 0);
    assert.equal(v.remaining.length, before.findings.length);
    assert.equal(v.introduced.length, 0);
    assert.equal(v.passed, false);
  });

  test("agent introduced regressions → fails and names them", async () => {
    const clean = await scanProject({ rootDirectory: goodApp });
    const broken = await scanProject({ rootDirectory: agentApp });
    const v = verifyFixes(clean, broken);
    assert.ok(v.introduced.length > 0, "new findings are reported as introduced");
    assert.equal(v.passed, false);
  });

  test("score movement is reported both ways", async () => {
    const before = await scanProject({ rootDirectory: agentApp });
    const after = await scanProject({ rootDirectory: goodApp });
    const up = verifyFixes(before, after);
    assert.ok(up.scoreAfter > up.scoreBefore);
    const down = verifyFixes(after, before);
    assert.ok(down.scoreAfter < down.scoreBefore);
  });
});

describe("renderVerifyResult", () => {
  test("PASS verdict summarizes resolved count and score movement", async () => {
    const before = await scanProject({ rootDirectory: agentApp });
    const after = await scanProject({ rootDirectory: goodApp });
    const out = renderVerifyResult(verifyFixes(before, after));
    assert.match(out, /Verification/);
    assert.match(out, /finding\(s\) resolved/);
    assert.match(out, /→ PASS/);
  });
  test("FAIL verdict lists introduced findings", async () => {
    const clean = await scanProject({ rootDirectory: goodApp });
    const broken = await scanProject({ rootDirectory: agentApp });
    const out = renderVerifyResult(verifyFixes(clean, broken));
    assert.match(out, /NEW finding\(s\) introduced/);
    assert.match(out, /→ FAIL/);
  });
});

describe("runAgentFix --verify", () => {
  const claude = () => AGENTS.find((a) => a.id === "claude")!;

  test("exit 0 when the re-scan is clean", async () => {
    const before = await scanProject({ rootDirectory: agentApp });
    const after = await scanProject({ rootDirectory: goodApp });
    const code = await runAgentFix(before, {
      chooseAction: async () => ({ kind: "agent", agent: claude() }),
      spawnAgent: async () => 0,
      verify: true,
      rescan: async () => after,
      out: () => {},
      err: () => {},
    });
    assert.equal(code, 0);
  });

  test("exit 1 when findings remain — the agent's own exit code is not trusted", async () => {
    const before = await scanProject({ rootDirectory: agentApp });
    const code = await runAgentFix(before, {
      chooseAction: async () => ({ kind: "agent", agent: claude() }),
      spawnAgent: async () => 0, // agent claims success…
      verify: true,
      rescan: async () => before, // …but nothing actually changed
      out: () => {},
      err: () => {},
    });
    assert.equal(code, 1);
  });

  test("without --verify the agent's exit code passes through", async () => {
    const before = await scanProject({ rootDirectory: agentApp });
    const code = await runAgentFix(before, {
      chooseAction: async () => ({ kind: "agent", agent: claude() }),
      spawnAgent: async () => 7,
      out: () => {},
      err: () => {},
    });
    assert.equal(code, 7);
  });

  test("a failing re-scan degrades to the agent's exit code instead of crashing", async () => {
    const before = await scanProject({ rootDirectory: agentApp });
    const code = await runAgentFix(before, {
      chooseAction: async () => ({ kind: "agent", agent: claude() }),
      spawnAgent: async () => 3,
      verify: true,
      rescan: async () => {
        throw new Error("disk exploded");
      },
      out: () => {},
      err: () => {},
    });
    assert.equal(code, 3);
  });

  test("--verify parses", () => {
    assert.equal(parseArgs(["fix", "--verify"]).verify, true);
    assert.equal(parseArgs(["fix"]).verify, false);
  });
});

// ---------------------------------------------------------------------------
// CLI integration for the Wave 11 surfaces (spawns the real binary)
// ---------------------------------------------------------------------------

const BIN = fileURLToPath(new URL("../../bin/node-doctor.js", import.meta.url));

const runCli = (cliArgs: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((done) => {
    const child = spawn(process.execPath, [BIN, ...cliArgs], { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => done({ code: code ?? 0, stdout, stderr }));
  });

const makeProject = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "nd-w11-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "demo", dependencies: { express: "^4.18.0", "@prisma/client": "^5.0.0" } }),
  );
  await writeFile(join(dir, "src", "a.js"), 'import fs from "fs";\nexport const read=(p)=>fs.readFileSync(p);\n');
  return dir;
};

describe("CLI: conventions (§50)", () => {
  test("writes stack-derived files and is non-destructive on re-run", async () => {
    const dir = await makeProject();
    try {
      const first = await runCli(["conventions"], dir);
      assert.equal(first.code, 0);
      assert.match(first.stdout, /wrote .*AGENTS\.md/);

      const content = await readFile(join(dir, "AGENTS.md"), "utf8");
      assert.match(content, /Express/, "names the detected framework");
      assert.match(content, /Prisma/, "names the detected ORM");
      assert.ok(!/Fastify/.test(content), "does not mention a framework the project lacks");

      const second = await runCli(["conventions"], dir);
      assert.match(second.stdout, /exists, left alone/);
      assert.equal(await readFile(join(dir, "AGENTS.md"), "utf8"), content, "unchanged without --overwrite");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("CLI: --fix-diff (§54)", () => {
  test("emits an applyable patch and writes nothing", async () => {
    const dir = await makeProject();
    try {
      const before = await readFile(join(dir, "src", "a.js"), "utf8");
      const r = await runCli([".", "--fix-diff"], dir);
      assert.equal(r.code, 0);
      assert.match(r.stdout, /^--- a\/src\/a\.js\n\+\+\+ b\/src\/a\.js\n/m);
      assert.match(r.stdout, /-import fs from "fs";/);
      assert.match(r.stdout, /\+import fs from "node:fs";/);
      assert.ok(!r.stdout.includes(dir), "no absolute machine path leaks into the patch");
      assert.equal(await readFile(join(dir, "src", "a.js"), "utf8"), before, "source is untouched");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("CLI: ratchet (§87)", () => {
  test("init locks debt; unchanged passes; a new finding fails", async () => {
    const dir = await makeProject();
    try {
      await writeFile(join(dir, "src", "bad.js"), 'app.get("/x",(req,res)=>{eval(req.query.c);});\n');

      const init = await runCli(["ratchet", "init"], dir);
      assert.equal(init.code, 0);
      assert.match(init.stdout, /ratchet set at/);

      const unchanged = await runCli(["ratchet", "check"], dir);
      assert.equal(unchanged.code, 0, "accepted debt does not fail the build");
      assert.match(unchanged.stdout, /Ratchet: PASS/);

      await writeFile(join(dir, "src", "worse.js"), 'app.post("/y",(req,res)=>{const t={};t[req.body.k]=1;});\n');
      const regressed = await runCli(["ratchet", "check"], dir);
      assert.equal(regressed.code, 1, "a NEW finding fails");
      assert.match(regressed.stdout, /Ratchet: FAIL/);
      assert.match(regressed.stdout, /NEW finding\(s\) beyond the accepted baseline/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("check without a ratchet is a clear error", async () => {
    const dir = await makeProject();
    try {
      const r = await runCli(["ratchet", "check"], dir);
      assert.equal(r.code, 2);
      assert.match(r.stderr, /ratchet init/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
