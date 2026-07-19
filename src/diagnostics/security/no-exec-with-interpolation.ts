import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import {
  getMethodName,
  rootObjectName,
  hasInterpolation,
  isStringConcatWithVariable,
  looksCallerControlled,
} from "../../core/ast.ts";

/**
 * A shell command built by string interpolation or concatenation. `exec` spawns
 * a *shell*, so any interpolated value can carry `;`, `&&`, backticks, or
 * `$(...)` and become a second command. `execFile("git", ["clone", url])` has no
 * shell to re-parse the arguments — that is the entire fix.
 *
 * ❌ exec(`tar -czf backup.tgz ${req.body.dir}`);
 * ✅ execFile("tar", ["-czf", "backup.tgz", dir]);
 */

const EXEC_METHODS = new Set(["exec", "execSync"]);
const CHILD_PROCESS_RECEIVERS = new Set(["child_process", "childProcess", "cp", "cproc"]);

/** Is this an `exec`/`execSync` call on child_process (or the bare import)? */
const isShellExecCall = (node: AstNode): boolean => {
  const method = getMethodName(node);
  if (!method || !EXEC_METHODS.has(method)) return false;
  const callee = node.callee;
  // Bare `exec(...)` (destructured import).
  if (callee?.type === "Identifier") return true;
  // `child_process.exec(...)` / `cp.exec(...)`.
  const root = rootObjectName(callee);
  return !!root && (CHILD_PROCESS_RECEIVERS.has(root) || root === "require");
};

export const noExecWithInterpolation = defineDiagnostic({
  id: "no-exec-with-interpolation",
  title: "Shell command built by string interpolation",
  severity: "error",
  category: "Security",
  tags: ["injection"],
  recommendation:
    "Use `execFile`/`spawn` with an argument array: `execFile('git', ['clone', url])`. There is no shell to re-parse the arguments, so an interpolated value cannot become a second command.",
  create: (ctx) => ({
    CallExpression: (node) => {
      if (!isShellExecCall(node)) return;
      const arg0 = (node.arguments as AstNode[])[0];
      if (!arg0) return;
      if (!hasInterpolation(arg0) && !isStringConcatWithVariable(arg0)) return;

      const tainted = looksCallerControlled(arg0, ctx.taintedBindings);
      ctx.report(
        arg0,
        tainted
          ? "Shell command built from caller-controlled input via interpolation — this is command injection."
          : "Shell command built by string interpolation/concatenation — an interpolated value can inject a second command through the shell.",
      );
    },
  }),
});
