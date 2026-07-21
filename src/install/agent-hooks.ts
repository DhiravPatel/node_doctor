/**
 * Install native post-edit hooks so an agent gets node.doctor feedback inline
 * as it edits. Writes a small hook script + registers it in the client's hook
 * config. The script scans only changed files, stays silent when clean, and
 * emits findings as additional context. Idempotent.
 *
 * Supported: Claude Code (.claude/hooks + settings.json PostToolUse) and Cursor
 * (.cursor/hooks + hooks.json).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const HOOK_SCRIPT = `#!/usr/bin/env node
// node.doctor post-edit hook: scan changed files, surface findings as context.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const run = (bin, args) => {
  try {
    return execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    return (e && e.stdout) || "";
  }
};

const args = ["--diff", "--blocking", "none", "--json"];
const out = existsSync("node_modules/.bin/node-doctor")
  ? run("node_modules/.bin/node-doctor", args)
  : run("npx", ["--yes", "node-doctor@latest", ...args]);

let report;
try {
  report = JSON.parse(out);
} catch {
  process.exit(0);
}
const findings = report.findings || [];
if (findings.length === 0) process.exit(0);

const top = findings
  .slice(0, 10)
  .map((f) => \`- \${f.severity} node-doctor/\${f.diagnostic} \${f.normalizedFilePath}:\${f.line} — \${f.message}\`)
  .join("\\n");
const context = \`node.doctor found \${findings.length} issue(s) in the files you changed:\\n\${top}\\nFix them at the root cause (do not suppress); run \\\`node-doctor fix\\\` to hand them to an agent.\`;

process.stdout.write(
  JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } }),
);
process.exit(0);
`;

const readJson = async (path: string): Promise<Record<string, unknown>> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
};

export interface AgentHooksResult {
  written: string[];
}

/** Merge a PostToolUse command hook into a Claude Code settings object (idempotent). */
const mergeClaudeHook = (settings: Record<string, unknown>, command: string): Record<string, unknown> => {
  const hooks = (settings.hooks as Record<string, unknown>) ?? {};
  const post = Array.isArray(hooks.PostToolUse) ? (hooks.PostToolUse as Array<Record<string, unknown>>) : [];
  const already = post.some((entry) =>
    Array.isArray(entry.hooks) && (entry.hooks as Array<Record<string, unknown>>).some((h) => h.command === command),
  );
  if (!already) {
    post.push({ matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command }] });
  }
  return { ...settings, hooks: { ...hooks, PostToolUse: post } };
};

export const installAgentHooks = async (cwd: string = process.cwd()): Promise<AgentHooksResult> => {
  const written: string[] = [];

  // --- Claude Code ---
  const claudeHooksDir = join(cwd, ".claude", "hooks");
  await mkdir(claudeHooksDir, { recursive: true });
  const claudeScript = join(claudeHooksDir, "node-doctor.mjs");
  await writeFile(claudeScript, HOOK_SCRIPT);
  written.push(claudeScript);

  const claudeSettings = join(cwd, ".claude", "settings.json");
  const settings = await readJson(claudeSettings);
  const merged = mergeClaudeHook(settings, "node .claude/hooks/node-doctor.mjs");
  await writeFile(claudeSettings, JSON.stringify(merged, null, 2) + "\n");
  written.push(claudeSettings);

  // --- Cursor ---
  const cursorHooksDir = join(cwd, ".cursor", "hooks");
  await mkdir(cursorHooksDir, { recursive: true });
  const cursorScript = join(cursorHooksDir, "node-doctor.mjs");
  await writeFile(cursorScript, HOOK_SCRIPT);
  written.push(cursorScript);

  const cursorHooksJson = join(cwd, ".cursor", "hooks.json");
  const existingCursor = await readJson(cursorHooksJson);
  const cursorHooks = Array.isArray((existingCursor as { afterEdit?: unknown }).afterEdit)
    ? ((existingCursor as { afterEdit: Array<Record<string, unknown>> }).afterEdit)
    : [];
  const command = "node .cursor/hooks/node-doctor.mjs";
  if (!cursorHooks.some((h) => h.command === command)) cursorHooks.push({ command });
  await writeFile(cursorHooksJson, JSON.stringify({ ...existingCursor, afterEdit: cursorHooks }, null, 2) + "\n");
  written.push(cursorHooksJson);

  return { written };
};

export { HOOK_SCRIPT };
export const claudeHookInstalled = (settings: Record<string, unknown>, command: string): boolean => {
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  const post = hooks && Array.isArray(hooks.PostToolUse) ? (hooks.PostToolUse as Array<Record<string, unknown>>) : [];
  return post.some((e) => Array.isArray(e.hooks) && (e.hooks as Array<Record<string, unknown>>).some((h) => h.command === command));
};
