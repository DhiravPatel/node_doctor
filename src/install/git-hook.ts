/**
 * Install a git pre-commit hook that scans staged files. The hook runs
 * `node-doctor --staged --blocking warning` (local bin, else `npx`) and is
 * advisory — it prints introduced findings but never blocks the commit, so it's
 * safe to adopt. The node.doctor block is delimited so re-running updates it in
 * place and leaves any surrounding hook content untouched.
 */

import { readFile, writeFile, mkdir, chmod, stat } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const START = "# >>> node-doctor >>>";
const END = "# <<< node-doctor <<<";

const HOOK_BODY = `${START}
# Advisory scan of staged files (never blocks the commit). Remove "|| true" to enforce.
if [ -x node_modules/.bin/node-doctor ]; then
  node_modules/.bin/node-doctor --staged --blocking warning || true
else
  npx --yes node-doctor@latest --staged --blocking warning || true
fi
${END}`;

export interface InstallGitHookOptions {
  cwd?: string;
}

export interface InstallGitHookResult {
  path: string;
  action: "created" | "updated";
}

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

/** The git repository top-level, or null when not in a work tree. */
const gitTopLevel = async (cwd: string): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
};

/** Splice the node-doctor block into existing hook content (replace or append). */
const withBlock = (existing: string): string => {
  const startIdx = existing.indexOf(START);
  if (startIdx !== -1) {
    const endIdx = existing.indexOf(END, startIdx);
    if (endIdx !== -1) {
      return existing.slice(0, startIdx) + HOOK_BODY + existing.slice(endIdx + END.length);
    }
  }
  const base = existing.trimEnd();
  return `${base}\n\n${HOOK_BODY}\n`;
};

export const installGitHook = async (options: InstallGitHookOptions = {}): Promise<InstallGitHookResult> => {
  const cwd = options.cwd ?? process.cwd();
  const top = await gitTopLevel(cwd);
  if (!top) {
    throw new Error("not inside a git repository — run `git init` first, then `node-doctor install --git-hook`.");
  }

  // Prefer a husky hooks dir when the project uses husky; else the raw git hook.
  const huskyDir = join(top, ".husky");
  const useHusky = await exists(huskyDir);
  const hookPath = useHusky ? join(huskyDir, "pre-commit") : join(top, ".git", "hooks", "pre-commit");

  if (useHusky) await mkdir(huskyDir, { recursive: true });

  const already = await exists(hookPath);
  let content: string;
  if (already) {
    content = withBlock(await readFile(hookPath, "utf8"));
  } else {
    content = `#!/bin/sh\n${HOOK_BODY}\n`;
  }

  await writeFile(hookPath, content);
  await chmod(hookPath, 0o755);

  return { path: hookPath, action: already ? "updated" : "created" };
};
