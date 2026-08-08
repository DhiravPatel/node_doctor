import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, getStaticStringValue, findAncestor, staticMemberPath } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";
import { isTestFile } from "../../core/test-file.ts";

/**
 * §196 — a handler for a signal the operating system will not deliver.
 *
 * `SIGKILL` and `SIGSTOP` are handled by the kernel and cannot be caught,
 * blocked or ignored by the process — that is the whole point of them. Node does
 * not quietly ignore the request either: `process.on("SIGKILL", …)` reaches
 * `uv_signal_start`, which fails, and the **`EINVAL` propagates as a thrown
 * error**:
 *
 *   ❌ process.on("SIGKILL", () => shutdown());
 *      → Error: uv_signal_start EINVAL — thrown where it is registered
 *   ✅ process.on("SIGTERM", () => shutdown());
 *      process.on("SIGINT", () => shutdown());
 *
 * So this is not a handler that silently never fires: it is a crash, at the
 * exact moment the process is wiring up its shutdown path. Registered at module
 * scope it takes the process down on boot; registered inside a lazily-called
 * setup function it takes it down the first time that runs.
 *
 * It is written for a plausible reason — "make sure we clean up no matter how we
 * are killed" — and the intent is unreachable. A `SIGKILL`ed process gets no
 * chance to do anything, which is why orchestrators send `SIGTERM` first and
 * `SIGKILL` only after the grace period expires. The cleanup belongs on
 * `SIGTERM`.
 *
 * PRECISION MODEL. Both halves are literal:
 *
 *   - The receiver must be the global `process`, with nothing shadowing it.
 *   - The signal must be a static string that IS `SIGKILL` or `SIGSTOP`. A
 *     variable holding a signal name is not judged.
 *   - Only the REGISTRATION methods. `process.kill(pid, "SIGKILL")` sends the
 *     signal to another process, which is correct and common.
 *   - A file that touches `worker_threads` is not judged. **Verified against the
 *     runtime: inside a Worker there is no throw at all** — worker threads never
 *     install the `newListener` hook that reaches `uv_signal_start`, so the
 *     registration is a plain `EventEmitter.on` and the listener is merely dead.
 *     The finding's whole claim is about the crash, so where there is no crash
 *     there is no finding.
 *   - A registration inside a `try`/`catch` is not judged either: the throw is
 *     caught, the process survives, and cross-platform code really does wrap
 *     signal registration this way because Windows rejects several signums.
 *   - A file that REPLACES the global (`globalThis.process = fake`) or binds the
 *     name with `import process = require(…)` is not judged. Both shadow it
 *     without creating the lexical binding the scope resolver looks for.
 *   - A TEST FILE is inert: `assert.throws(() => process.on("SIGKILL", …))` is a
 *     regression test pinning this exact behaviour, and it does not crash.
 */

/** Signals the kernel never delivers to the process. */
const UNCATCHABLE = new Map([
  [
    "SIGKILL",
    "the kernel terminates the process immediately and hands it no chance to run anything — which is exactly why orchestrators send `SIGTERM` first and `SIGKILL` only after the grace period",
  ],
  ["SIGSTOP", "the kernel suspends the process without notifying it, and only `SIGCONT` resumes it"],
]);

/** The methods that install a listener, as opposed to sending a signal. */
const REGISTRATION_METHODS = new Set(["on", "once", "addListener", "prependListener", "prependOnceListener"]);

export const noUncatchableSignalHandler = defineDiagnostic({
  id: "no-uncatchable-signal-handler",
  title: "Handler registered for a signal that cannot be caught",
  severity: "error",
  category: "Reliability",
  confidence: "high",
  tags: ["correctness", "lifecycle", "signals"],
  recommendation:
    "Move the cleanup to `SIGTERM` (and `SIGINT` for a local Ctrl-C). `SIGKILL` and `SIGSTOP` are handled by the kernel and cannot be caught — Node throws `EINVAL` from `uv_signal_start` at the point of registration, so this line crashes the process rather than protecting it.",
  create: (ctx) => {
    /**
     * Anything that makes the crash claim untrue for this file. Each was
     * confirmed by running it, not by reading the docs.
     */
    let inert: boolean | null = null;
    const computeInert = (): boolean => {
      if (isTestFile(ctx.program, ctx.normalizedFilePath)) return true;
      for (const stmt of (ctx.program.body as AstNode[] | undefined) ?? []) {
        // `import … from "node:worker_threads"` — no throw inside a Worker.
        if (stmt.type === "ImportDeclaration") {
          const source = stmt.source?.value;
          if (source === "worker_threads" || source === "node:worker_threads") return true;
        }
        // `import process = require("…")` binds the name invisibly to the resolver.
        if (stmt.type === "TSImportEqualsDeclaration") {
          const id = stmt.id as AstNode | undefined;
          if (id?.type === "Identifier" && id.name === "process") return true;
        }
      }
      for (const node of collectDescendants(
        ctx.program,
        (n) => n.type === "CallExpression" || n.type === "AssignmentExpression",
        undefined,
        true,
      )) {
        if (node.type === "AssignmentExpression") {
          // `globalThis.process = fake` replaces it without a lexical binding.
          const path = staticMemberPath(node.left as AstNode);
          if (path === "globalThis.process" || path === "global.process") return true;
          continue;
        }
        if ((node.callee as AstNode | undefined)?.type !== "Identifier") continue;
        if ((node.callee as AstNode).name !== "require") continue;
        const source = getStaticStringValue(((node.arguments as AstNode[] | undefined) ?? [])[0]);
        if (source === "worker_threads" || source === "node:worker_threads") return true;
      }
      return false;
    };

    return {
    CallExpression: (node) => {
      if (inert === null) inert = computeInert();
      if (inert) return;
      const method = getMethodName(node);
      if (method === null || !REGISTRATION_METHODS.has(method)) return;

      const callee = node.callee as AstNode | undefined;
      if (callee?.type !== "MemberExpression") return;
      const receiver = callee.object as AstNode | undefined;
      if (receiver?.type !== "Identifier" || receiver.name !== "process") return;
      // A local `process` is somebody's own emitter — a mock, an actor handle.
      if (ctx.scope.getBinding("process", receiver) !== null) return;

      const args = (node.arguments as AstNode[] | undefined) ?? [];
      const signal = getStaticStringValue(args[0]);
      if (signal === null) return;
      const why = UNCATCHABLE.get(signal);
      if (why === undefined) return;

      // Wrapped in a `try` with a `catch`: the throw is caught and the process
      // survives, so the claim this finding makes is not true here.
      const tryStatement = findAncestor(node, (n) => n.type === "TryStatement");
      if (tryStatement && (tryStatement.handler as AstNode | undefined)) return;

      ctx.report(
        args[0] ?? node,
        `\`${signal}\` cannot be caught: ${why}. Node does not ignore the request — \`uv_signal_start\` fails and the \`EINVAL\` is **thrown right here**, so this line crashes the process instead of protecting it. Put the cleanup on \`SIGTERM\`.`,
      );
    },
    };
  },
});
