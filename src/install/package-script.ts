/**
 * Add a `doctor` script to the nearest package.json so a project can run
 * `npm run doctor`. Non-destructive: if `doctor` is taken it falls back to
 * `node-doctor`. Optionally adds node-doctor as a devDependency via the detected
 * package manager (off by default — that's a network install).
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, parse as parsePath } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Nearest package.json walking up from `cwd` to the filesystem root. */
export const findNearestPackageJson = (cwd: string): string | null => {
  let dir = cwd;
  for (;;) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir || parsePath(dir).root === dir) return null;
    dir = parent;
  }
};

/** Detect the package manager from a lockfile (npm | pnpm | yarn | bun). */
export const detectPackageManager = (dir: string): "npm" | "pnpm" | "yarn" | "bun" => {
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(join(dir, "bun.lockb"))) return "bun";
  return "npm";
};

const addDevDepArgs = (pm: string): string[] => {
  switch (pm) {
    case "pnpm":
      return ["add", "-D", "node-doctor"];
    case "yarn":
      return ["add", "-D", "node-doctor"];
    case "bun":
      return ["add", "-d", "node-doctor"];
    default:
      return ["install", "-D", "node-doctor"];
  }
};

export interface PackageScriptOptions {
  cwd?: string;
  /** Also add node-doctor as a devDependency via the detected package manager. */
  addDevDependency?: boolean;
}

export interface PackageScriptResult {
  packageJson: string;
  scriptName: string;
  scriptAdded: boolean;
  devDependencyAdded: boolean;
}

export const installPackageScript = async (options: PackageScriptOptions = {}): Promise<PackageScriptResult> => {
  const cwd = options.cwd ?? process.cwd();
  const pkgPath = findNearestPackageJson(cwd);
  if (!pkgPath) throw new Error("no package.json found — run this inside a Node project.");

  const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { scripts?: Record<string, string> };
  pkg.scripts = pkg.scripts ?? {};

  // Pick a script name that isn't already taken.
  const scriptName = !pkg.scripts.doctor ? "doctor" : !pkg.scripts["node-doctor"] ? "node-doctor" : "doctor:scan";
  let scriptAdded = false;
  if (!pkg.scripts[scriptName]) {
    pkg.scripts[scriptName] = "node-doctor";
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    scriptAdded = true;
  }

  let devDependencyAdded = false;
  if (options.addDevDependency) {
    const pkgDir = dirname(pkgPath);
    const pm = detectPackageManager(pkgDir);
    try {
      await execFileAsync(pm, addDevDepArgs(pm), { cwd: pkgDir });
      devDependencyAdded = true;
    } catch {
      /* network/PM failure — the script still works via npx */
    }
  }

  return { packageJson: pkgPath, scriptName, scriptAdded, devDependencyAdded };
};
