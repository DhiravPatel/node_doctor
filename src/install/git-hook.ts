/**
 * Install a git hook that runs node.doctor.
 *
 * TWO HOOKS, DELIBERATELY DIFFERENT. `pre-commit` scans **staged files only**,
 * because a commit happens dozens of times a day and a full scan there is a tax
 * people uninstall rather than pay. `pre-push` scans the **whole project**,
 * because a push is rarer, is the last point before the code becomes somebody
 * else's problem, and is where a repo-wide check actually belongs.
 *
 * Both are ADVISORY by default — they print and never block, so adopting one
 * cannot wedge anybody's workflow — and both say in a comment how to enforce.
 * The node.doctor block is delimited, so re-running updates it in place and
 * leaves any surrounding hook content untouched.
 */

import { readFile, writeFile, mkdir, chmod, stat } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const START = "# >>> node-doctor >>>";
const END = "# <<< node-doctor <<<";

/** Which hook to install; each gets the scan that suits how often it runs. */
export type GitHookKind = "pre-commit" | "pre-push";

const HOOK_BODIES: Record<GitHookKind, string> = {
  // Staged-only: a commit happens dozens of times a day.
  "pre-commit": `${START}
# Advisory scan of staged files (never blocks the commit). Remove "|| true" to enforce.
if [ -x node_modules/.bin/node-doctor ]; then
  node_modules/.bin/node-doctor --staged --blocking warning || true
else
  npx --yes node-doctor@latest --staged --blocking warning || true
fi
${END}`,
  // Whole project: a push is rare, and is the last point before the code
  // becomes somebody else's problem.
  "pre-push": `${START}
# Advisory whole-project scan (never blocks the push). Remove "|| true" to enforce.
if [ -x node_modules/.bin/node-doctor ]; then
  node_modules/.bin/node-doctor --blocking error || true
else
  npx --yes node-doctor@latest --blocking error || true
fi
${END}`,
};

export interface InstallGitHookOptions {
  cwd?: string;
  /** Defaults to `pre-commit`, which is what `--git-hook` installed before. */
  hook?: GitHookKind;
}

export interface InstallGitHookResult {
  path: string;
  hook: GitHookKind;
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
const withBlock = (existing: string, body: string): string => {
  const startIdx = existing.indexOf(START);
  if (startIdx !== -1) {
    const endIdx = existing.indexOf(END, startIdx);
    if (endIdx !== -1) {
      return existing.slice(0, startIdx) + body + existing.slice(endIdx + END.length);
    }
  }
  const base = existing.trimEnd();
  return `${base}\n\n${body}\n`;
};

export const installGitHook = async (options: InstallGitHookOptions = {}): Promise<InstallGitHookResult> => {
  const cwd = options.cwd ?? process.cwd();
  const hook = options.hook ?? "pre-commit";
  const body = HOOK_BODIES[hook];
  const top = await gitTopLevel(cwd);
  if (!top) {
    throw new Error("not inside a git repository — run `git init` first, then `node-doctor install --git-hook`.");
  }

  // Prefer a husky hooks dir when the project uses husky; else the raw git hook.
  const huskyDir = join(top, ".husky");
  const useHusky = await exists(huskyDir);
  const hookPath = useHusky ? join(huskyDir, hook) : join(top, ".git", "hooks", hook);

  if (useHusky) await mkdir(huskyDir, { recursive: true });

  const already = await exists(hookPath);
  let content: string;
  if (already) {
    content = withBlock(await readFile(hookPath, "utf8"), body);
  } else {
    content = `#!/bin/sh\n${body}\n`;
  }

  await writeFile(hookPath, content);
  await chmod(hookPath, 0o755);

  return { path: hookPath, hook, action: already ? "updated" : "created" };
};
