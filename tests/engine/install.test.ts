import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkill, CLIENTS } from "../../src/skill/install.ts";

describe("install", () => {
  test("writes the skill to Claude Code and Cursor paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-install-"));
    try {
      const result = await installSkill({ targetDir: dir });
      assert.ok(result.written.some((p) => p.includes(".claude/skills/node-doctor/SKILL.md")));
      assert.ok(result.written.some((p) => p.includes(".cursor/diagnostics/node-doctor.mdc")));

      const claude = result.written.find((p) => p.includes(".claude"))!;
      const content = await readFile(claude, "utf8");
      assert.ok(content.includes("node.doctor"));
      assert.ok(content.includes("Run the scanner"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("--client targets a single client", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-install-"));
    try {
      const result = await installSkill({ targetDir: dir, client: "cursor" });
      assert.equal(result.written.length, 1);
      assert.ok(result.written[0]!.includes(".cursor"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("unknown client throws with the known list", async () => {
    await assert.rejects(() => installSkill({ targetDir: ".", client: "nope" }), /unknown client/);
    assert.ok(CLIENTS.has("claude-code"));
  });
});
