import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import {
  getMethodName,
  hasInterpolation,
  isStringConcatWithVariable,
  looksCallerControlled,
  rootObjectName,
} from "../../core/ast.ts";

/**
 * Caller-controlled data parsed by a SHELL. Two spellings, one defect, and
 * neither is caught by `no-exec-with-interpolation` — which looks for a command
 * built by interpolation or concatenation, and so misses both of these.
 *
 *   ❌ const cmd = req.body.cmd; exec(cmd);                     // the whole command is theirs
 *   ❌ spawn("convert", [req.body.file], { shell: true });      // the ARRAY is re-parsed
 *   ✅ spawn("convert", [req.body.file]);                       // execve args, no shell
 *   ✅ execFile("git", ["clone", url]);
 *
 * The second one is the expensive half, because it silently undoes the fix
 * everybody is told to apply. `execFile`/`spawn` with an argument array is THE
 * remedy for command injection: the arguments go to `execve` and a `;` in one of
 * them is just a semicolon. Setting `shell: true` — usually added later, to get a
 * PATH lookup or to run a `.cmd` on Windows — makes Node join the command and the
 * array back into one string and hand it to `/bin/sh -c`, so every argument
 * becomes shell source again. The array is still there, the code still looks like
 * the safe pattern, and the protection is gone.
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
 * So `true` and any NON-EMPTY shell path enable it; `false` and `""` do not. That
 * table is the rule's `shell`-value model, not an assumption about the option.
 * `execFileSync` behaves identically to `spawnSync`, also measured.
 *
 * PRECISION MODEL. Both halves must be provable, and the rule reports neither on
 * its own:
 *
 *   - A SHELL must be in play. `exec` and `execSync` always spawn one. `execFile`,
 *     `execFileSync`, `spawn` and `spawnSync` only do when an options object
 *     LITERAL sets `shell` to `true` or to a non-empty string literal. A `shell`
 *     whose value cannot be read — a variable, a ternary — is treated as not
 *     enabled, so uncertainty resolves to silence.
 *   - The data must be CALLER-CONTROLLED, by the engine's own taint, which
 *     resolves each identifier to the binding it names at that use site. The
 *     command itself counts, and so does any element of the argument array, and
 *     so does a non-literal array passed whole.
 *
 * `spawn(cmd, args, { shell: true })` with every value a string literal is never
 * reported: the command is fixed, there is nothing to inject, and on Windows that
 * is the documented way to run `npm`. That exclusion is what keeps the rule from
 * firing on the legitimate use of the option.
 *
 * DIVISION OF LABOUR with `no-exec-with-interpolation`: that rule owns the
 * interpolated/concatenated shell string, and this one deliberately stays silent
 * on `exec(\`ls ${dir}\`)` so a single line is not reported twice. What is left
 * here is the bare tainted value — `exec(cmd)` — which nothing caught before, and
 * the `shell` option, which nothing caught at all.
 */

/** Always spawns a shell; the whole first argument is shell source. */
const ALWAYS_SHELL = new Set(["exec", "execSync"]);

/** Spawns a shell only when the `shell` option says so. */
const OPTIONAL_SHELL = new Set(["execFile", "execFileSync", "spawn", "spawnSync"]);

const CHILD_PROCESS_RECEIVERS = new Set(["child_process", "childProcess", "cp", "cproc"]);

/** Is this call one of `child_process`'s process-spawning functions? */
const isChildProcessCall = (node: AstNode): boolean => {
  const callee = node.callee as AstNode | undefined;
  // Bare `exec(...)` from a destructured import.
  if (callee?.type === "Identifier") return true;
  const root = rootObjectName(callee);
  return root !== null && (CHILD_PROCESS_RECEIVERS.has(root) || root === "require");
};

/**
 * Does this options object enable a shell? Measured: `true` and any non-empty
 * string path do; `false` and `""` do not. Anything unreadable resolves to no.
 */
const enablesShell = (options: AstNode): boolean => {
  if (options.type !== "ObjectExpression") return false;
  for (const property of ((options.properties as AstNode[] | undefined) ?? [])) {
    if (property.type !== "Property" || property.computed) continue;
    const key = property.key as AstNode | undefined;
    const name = key?.type === "Identifier" ? String(key.name) : key?.type === "Literal" ? String(key.value) : null;
    if (name !== "shell") continue;
    const value = property.value as AstNode | undefined;
    if (value?.type !== "Literal") return false;
    if (value.value === true) return true;
    return typeof value.value === "string" && value.value.length > 0;
  }
  return false;
};

export const noShellCommandFromInput = defineDiagnostic({
  id: "no-shell-command-from-input",
  title: "Caller-controlled value parsed by a shell, including through spawn's shell option",
  severity: "error",
  category: "Security",
  confidence: "high",
  tags: ["injection", "shell", "owasp:a03"],
  recommendation:
    'Drop the `shell` option and pass an argument array: `spawn("convert", [file])`. The arguments then go to `execve`, where a `;` is just a semicolon — measured on Node 22, `spawnSync("echo", ["$(id)"])` prints the literal string, while adding `{ shell: true }` runs `id`. If you only need a PATH lookup, resolve the binary yourself; if you are on Windows and need `.cmd`, name the interpreter (`spawn("cmd", ["/c", "npm", ...])`). For `exec`, use `execFile` with an array instead — never pass a caller-controlled string as the command.',
  create: (ctx) => ({
    CallExpression: (node) => {
      const method = getMethodName(node);
      if (method === null) return;
      const always = ALWAYS_SHELL.has(method);
      const optional = OPTIONAL_SHELL.has(method);
      if (!always && !optional) return;
      if (!isChildProcessCall(node)) return;

      const args = (node.arguments as AstNode[] | undefined) ?? [];
      // The options object can sit at several positions across these signatures,
      // so look for it by shape rather than by index.
      const shellEnabled = always || args.some((argument) => enablesShell(argument));
      if (!shellEnabled) return;

      const tainted = (value: AstNode | undefined): boolean =>
        value !== undefined && looksCallerControlled(value, ctx.taintedBindings);

      if (always) {
        const command = args[0];
        if (!command) return;
        // `no-exec-with-interpolation` owns the interpolated string; reporting
        // here too would put two findings on one line.
        if (hasInterpolation(command) || isStringConcatWithVariable(command)) return;
        if (!tainted(command)) return;
        ctx.report(
          command,
          `\`${method}\` spawns a **shell**, and this command is caller-controlled — the whole string is theirs, so no metacharacter is needed to make it a second command. Use \`execFile\`/\`spawn\` with an argument array instead: measured on Node 22, \`spawnSync("echo", ["$(id)"])\` prints the literal \`$(id)\`, because \`execve\` arguments are never re-parsed.`,
        );
        return;
      }

      // `spawn(cmd, args, opts)` — the command and every element of the array are
      // joined back into one shell string.
      const offenders: AstNode[] = [];
      if (tainted(args[0])) offenders.push(args[0]!);
      const list = args[1];
      if (list?.type === "ArrayExpression") {
        for (const element of ((list.elements as (AstNode | null)[] | undefined) ?? [])) {
          if (element && tainted(element)) offenders.push(element);
        }
      } else if (list && list.type !== "ObjectExpression" && tainted(list)) {
        offenders.push(list);
      }
      if (offenders.length === 0) return;

      for (const offender of offenders) {
        ctx.report(
          offender,
          `\`shell: true\` makes \`${method}\` join the command and its argument array back into ONE string and hand it to \`/bin/sh -c\`, so this caller-controlled value is parsed as shell source — the argument array's protection is gone even though the array is still there. Measured on Node 22: \`spawnSync("echo", ["readme.txt; id"])\` prints the literal text, while the same call with \`{ shell: true }\` runs \`id\`. Drop the \`shell\` option.`,
        );
      }
    },
  }),
});
