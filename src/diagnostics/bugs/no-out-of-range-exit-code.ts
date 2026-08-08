import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, staticMemberPath, getStaticStringValue } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";

/**
 * §197 — an exit code the operating system cannot carry.
 *
 * A process exit status is **one byte**. Node hands the number to `exit(3)`,
 * which keeps only the low 8 bits, so a code outside `0..255` is silently
 * replaced by `code & 0xFF` — and the two ways that goes wrong are both bad:
 *
 *   ❌ process.exit(256);      → the shell sees 0.  A failure reported as SUCCESS.
 *   ❌ process.exit(300);      → the shell sees 44. A different failure entirely.
 *   ❌ process.exitCode = 1000 → the shell sees 232.
 *   ✅ process.exit(1);
 *
 * The first form is the dangerous one: a CLI that exits 256 to mean "fatal"
 * reports success, so CI goes green, the deploy proceeds, and the failure is
 * invisible to every automated gate that exists to catch it. Nothing warns —
 * not Node, not the shell, not the test suite, which almost never asserts on the
 * numeric code.
 *
 * PRECISION MODEL. The claim is arithmetic on a literal:
 *
 *   - The code must be a NUMERIC LITERAL (or a negated one). A variable or a
 *     computed value is never folded — an exit code read from config is the
 *     config's problem.
 *   - `process` must be the global, with nothing shadowing it.
 *   - `process.exit(-1)` is NOT reported. It masks to 255, which is a nonzero
 *     failure status, and "exit minus one" is the universally understood way to
 *     say "generic failure". It does what its author meant.
 *   - What IS reported: a code above 255 (which becomes a different code), and
 *     any nonzero code that masks to **0** (a failure that becomes a success).
 *   - A file that touches `worker_threads` is not judged. **Verified against the
 *     runtime: a worker's exit code never reaches `wait(2)`** — it is a plain
 *     JavaScript number handed to the parent's `exit` event, so
 *     `process.exit(1001)` in a Worker delivers 1001 and nothing is masked. The
 *     masking is the entire claim, so where nothing is masked there is nothing
 *     to report.
 */

/** The one byte the operating system actually carries. */
const mask = (code: number): number => ((code % 256) + 256) % 256;

/** A numeric literal, or a negated one. Nothing else is folded. */
const numericLiteral = (node: AstNode | null | undefined): number | null => {
  if (!node) return null;
  if (node.type === "Literal") return typeof node.value === "number" ? (node.value as number) : null;
  if (node.type === "UnaryExpression" && (node.operator === "-" || node.operator === "+")) {
    const inner = node.argument as AstNode | undefined;
    if (inner?.type !== "Literal" || typeof inner.value !== "number") return null;
    return node.operator === "-" ? -(inner.value as number) : (inner.value as number);
  }
  return null;
};

export const noOutOfRangeExitCode = defineDiagnostic({
  id: "no-out-of-range-exit-code",
  title: "Exit code outside 0–255 is masked to a different status",
  severity: "error",
  category: "Bugs",
  confidence: "high",
  tags: ["correctness", "cli", "process"],
  recommendation:
    "Use a code in `0..255`. A process exit status is one byte, so Node keeps only `code & 0xFF` — `process.exit(256)` reports SUCCESS to the shell and to CI, and `process.exit(300)` reports 44.",
  create: (ctx) => {
    /**
     * A worker's exit code is delivered unmasked to the parent's `exit` event,
     * so the one-byte arithmetic this rule is built on does not apply.
     */
    const workerAware = (() => {
      for (const stmt of (ctx.program.body as AstNode[] | undefined) ?? []) {
        if (stmt.type !== "ImportDeclaration") continue;
        const source = stmt.source?.value;
        if (source === "worker_threads" || source === "node:worker_threads") return true;
      }
      for (const call of collectDescendants(
        ctx.program,
        (n) => n.type === "CallExpression" && (n.callee as AstNode | undefined)?.name === "require",
        undefined,
        true,
      )) {
        const source = getStaticStringValue(((call.arguments as AstNode[] | undefined) ?? [])[0]);
        if (source === "worker_threads" || source === "node:worker_threads") return true;
      }
      return false;
    })();

    /** Is this the global `process`, or has something taken the name? */
    const isGlobalProcess = (node: AstNode | null | undefined): boolean =>
      !!node && node.type === "Identifier" && node.name === "process" && ctx.scope.getBinding("process", node) === null;

    const judge = (codeNode: AstNode, written: number, form: string): void => {
      if (workerAware) return;
      if (!Number.isFinite(written) || !Number.isInteger(written)) return;
      // `exit(-1)` masks to 255 — a nonzero failure, which is what it meant.
      if (written >= 0 && written <= 255) return;
      const actual = mask(written);
      if (written < 0 && actual !== 0) return;

      ctx.report(
        codeNode,
        actual === 0
          ? `\`${form}\` is given ${written}, and a process exit status is one byte — Node keeps only \`code & 0xFF\`, which is **0**. The shell, CI, and every automated gate downstream see this run as a SUCCESS.`
          : `\`${form}\` is given ${written}, and a process exit status is one byte — Node keeps only \`code & 0xFF\`, so the shell actually sees **${actual}**. Use a code in \`0..255\`.`,
      );
    };

    return {
      CallExpression: (node) => {
        if (getMethodName(node) !== "exit") return;
        const callee = node.callee as AstNode | undefined;
        if (callee?.type !== "MemberExpression" || !isGlobalProcess(callee.object as AstNode)) return;
        const codeNode = ((node.arguments as AstNode[] | undefined) ?? [])[0];
        const written = numericLiteral(codeNode);
        if (codeNode && written !== null) judge(codeNode, written, "process.exit");
      },

      AssignmentExpression: (node) => {
        if (node.operator !== "=") return;
        const target = node.left as AstNode | undefined;
        if (staticMemberPath(target) !== "process.exitCode") return;
        if (!isGlobalProcess((target as AstNode).object as AstNode)) return;
        const value = node.right as AstNode | undefined;
        const written = numericLiteral(value);
        if (value && written !== null) judge(value, written, "process.exitCode");
      },
    };
  },
});
