/**
 * `no-shell-command-from-input`.
 *
 * Caller-controlled data parsed by a SHELL, in the two spellings
 * `no-exec-with-interpolation` cannot see: a bare tainted command
 * (`exec(cmd)` — no interpolation to notice) and `spawn`'s `shell` option, which
 * silently undoes the argument-array fix everyone is told to apply.
 *
 * MEASURED on Node 22, `spawnSync("echo", [value])` with the value shown:
 *
 *   value              options              result
 *   "readme.txt; id"   (none)               "readme.txt; id"            literal
 *   "readme.txt; id"   { shell: true }      "readme.txt" + uid=501(…)   `id` RAN
 *   "$(id)"            (none)               "$(id)"                     literal
 *   "$(id)"            { shell: true }      uid=501(…)                  substitution RAN
 *   "$(id)"            { shell: "/bin/sh" } uid=501(…)                  substitution RAN
 *   "$(id)"            { shell: false }     "$(id)"                     literal
 *   "$(id)"            { shell: "" }        "$(id)"                     literal
 *
 * `true` and any non-empty shell path enable it; `false` and `""` do not — which
 * is the rule's whole `shell`-value model, measured rather than assumed.
 * `execFileSync` behaved identically to `spawnSync`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noShellCommandFromInput } from "../../src/diagnostics/security/no-shell-command-from-input.ts";

const CAPS = new Set(["node", "esm", "typescript", "express"]);
const IMPORT = `import { exec, execSync, execFile, execFileSync, spawn, spawnSync } from "node:child_process";\n`;

const findings = (body: string) =>
  lintSource({
    filePath: "/repo/src/routes.ts",
    sourceText: `${IMPORT}app.post("/run", async (req, res) => {\n${body}\n});\n`,
    diagnostics: [noShellCommandFromInput],
    capabilities: CAPS,
  }).findings.filter((f) => f.diagnostic === "no-shell-command-from-input");

const fires = (body: string) => {
  const found = findings(body);
  assert.ok(found.length > 0, `expected a FIRE on:\n${body}`);
  return found;
};
const silent = (body: string): void => {
  const found = findings(body);
  assert.equal(found.length, 0, `expected SILENCE on:\n${body}\ngot: ${found.map((f) => f.message).join("\n")}`);
};

describe("no-shell-command-from-input", () => {
  describe("the shell option — the argument array's protection removed", () => {
    test("a tainted element of the array", () => {
      fires(`spawn("convert", [req.body.file, "out.png"], { shell: true });`);
      fires(`const f = req.body.file;\nspawnSync("convert", [f], { shell: true });`);
    });

    test("every optional-shell API", () => {
      for (const api of ["execFile", "execFileSync", "spawn", "spawnSync"]) {
        fires(`${api}("convert", [req.body.file], { shell: true });`);
      }
    });

    test("a tainted command, not just a tainted argument", () => {
      fires(`spawn(req.body.bin, ["--version"], { shell: true });`);
    });

    test("a non-literal argument array passed whole", () => {
      fires(`const args = [req.body.file];\nspawn("convert", args, { shell: true });`);
    });

    test("a non-empty shell PATH also enables it — measured", () => {
      fires(`spawn("convert", [req.body.file], { shell: "/bin/sh" });`);
      fires(`spawn("convert", [req.body.file], { shell: "/bin/bash" });`);
    });

    test("the options object is found by shape, not by index", () => {
      // `execFile(file, args, opts, cb)` and `spawn(cmd, opts)` both occur.
      fires(`execFile("convert", [req.body.file], { shell: true }, cb);`);
      fires(`spawn(req.body.bin, { shell: true });`);
    });

    test("every tainted element is reported", () => {
      const found = fires(`spawn("cp", [req.body.from, req.body.to], { shell: true });`);
      assert.equal(found.length, 2);
    });

    test("the message names the mechanism and the measurement", () => {
      const [found] = fires(`spawn("convert", [req.body.file], { shell: true });`);
      assert.match(found!.message, /join the command and its argument array back into ONE string/);
      assert.match(found!.message, /readme\.txt; id/);
      assert.match(found!.recommendation ?? "", /execve/);
    });
  });

  describe("the shell option — measured NOT to enable a shell", () => {
    test("no options at all is the correct, safe spelling", () => {
      silent(`spawn("convert", [req.body.file, "out.png"]);`);
      silent(`execFile("git", ["clone", req.body.url]);`);
    });

    test("shell: false and shell: \"\" — both measured literal", () => {
      silent(`spawn("convert", [req.body.file], { shell: false });`);
      silent(`spawn("convert", [req.body.file], { shell: "" });`);
    });

    test("a shell value the rule cannot read resolves to silence", () => {
      silent(`spawn("convert", [req.body.file], { shell: useShell });`);
      silent(`spawn("convert", [req.body.file], { shell: isWin ? true : false });`);
      silent(`spawn("convert", [req.body.file], opts);`);
    });

    test("other options are not the shell option", () => {
      silent(`spawn("convert", [req.body.file], { cwd: "/tmp", stdio: "inherit" });`);
    });
  });

  describe("the input half — a fixed command has nothing to inject", () => {
    test("all-literal arguments, the legitimate Windows use", () => {
      silent(`spawn("npm", ["run", "build"], { shell: true });`);
      silent(`spawnSync("git", ["rev-parse", "HEAD"], { shell: true });`);
    });

    test("a value that is not caller-controlled", () => {
      silent(`spawn("convert", [config.inputFile], { shell: true });`);
      silent(`const name = "report.pdf";\nspawn("convert", [name], { shell: true });`);
    });
  });

  describe("the always-shell APIs", () => {
    test("a bare tainted command — the gap no rule caught", () => {
      const [found] = fires(`const cmd = req.body.cmd;\nexec(cmd);`);
      assert.match(found!.message, /spawns a \*\*shell\*\*/);
      assert.match(found!.message, /the whole string is theirs/);
      fires(`execSync(req.query.cmd);`);
    });

    test("interpolation is left to no-exec-with-interpolation", () => {
      // One line, one finding: the sibling rule owns this shape.
      silent(`exec(\`ls \${req.body.dir}\`);`);
      silent(`exec("ls " + req.body.dir);`);
    });

    test("a fixed command is silent", () => {
      silent(`exec("git rev-parse HEAD");`);
      silent(`execSync("npm run build");`);
    });
  });

  describe("the receiver must be child_process", () => {
    test("the namespace spellings", () => {
      const source = `import cp from "node:child_process";\napp.post("/x", (req, res) => { cp.spawn("c", [req.body.f], { shell: true }); });`;
      const found = lintSource({
        filePath: "/repo/src/r.ts",
        sourceText: source,
        diagnostics: [noShellCommandFromInput],
        capabilities: CAPS,
      }).findings.filter((f) => f.diagnostic === "no-shell-command-from-input");
      assert.equal(found.length, 1);
    });

    test("a same-named method on something else is not child_process", () => {
      silent(`queue.spawn("worker", [req.body.f], { shell: true });`);
      silent(`docker.exec(req.body.cmd);`);
    });
  });

  test("determinism — identical source yields identical findings", () => {
    const body = `spawn("cp", [req.body.from, req.body.to], { shell: true });`;
    assert.equal(JSON.stringify(findings(body)), JSON.stringify(findings(body)));
  });
});
