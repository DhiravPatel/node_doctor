import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import {
  getCalleeName,
  getMethodName,
  getReceiverName,
  getStaticStringValue,
  looksCallerControlled,
} from "../../core/ast.ts";

/**
 * Running dynamic code through the `vm` module. `vm` is NOT a security boundary:
 * `runInNewContext`/`runInThisContext`/`runInContext` and `new vm.Script(code)`
 * all execute their source with full access to the event loop, timers, and (with
 * trivial escapes) the host realm. Feeding it caller-controlled or dynamically
 * built code is remote code execution with an isolation fig leaf.
 *
 * ❌ vm.runInNewContext(req.body.script, sandbox);
 * ❌ const s = new vm.Script("return " + expr);
 * ✅ vm.runInNewContext("1 + 1", sandbox); // static code
 */

const VM_RUN_METHODS = new Set(["runInNewContext", "runInThisContext", "runInContext"]);

/** A statically-known primitive literal or a no-substitution template. */
const isStaticLiteral = (node: AstNode | null | undefined): boolean =>
  !!node && (node.type === "Literal" || getStaticStringValue(node) !== null);

export const noVmRunUntrusted = defineDiagnostic({
  id: "no-vm-run-untrusted",
  title: "vm runs untrusted code without isolation",
  severity: "error",
  category: "Security",
  tags: ["injection"],
  recommendation:
    "Do not treat `vm` as a sandbox. Run untrusted code in a real isolate (isolated-vm) or a separate OS process with a memory/CPU/time budget and no ambient credentials.",
  create: (ctx) => {
    const fire = (node: AstNode, code: AstNode): void => {
      const tainted = looksCallerControlled(code, ctx.taintedBindings);
      ctx.report(
        node,
        tainted
          ? "vm is executing caller-controlled code — `vm` is not a security boundary, so this is arbitrary code execution."
          : "vm is executing dynamically-built code — `vm` is not a security boundary and provides no real isolation.",
      );
    };
    return {
      CallExpression: (node) => {
        const method = getMethodName(node);
        if (!method || !VM_RUN_METHODS.has(method)) return;
        // Only the `vm` receiver (or a destructured bare call) takes code as arg0;
        // `script.runInThisContext()` carries no code arg and is handled at construction.
        const receiver = getReceiverName(node);
        const isBareCall = node.callee?.type === "Identifier";
        if (receiver !== "vm" && !isBareCall) return;
        const code = (node.arguments as AstNode[])[0];
        if (!code || isStaticLiteral(code)) return;
        fire(node, code);
      },
      NewExpression: (node) => {
        if (getCalleeName(node) !== "vm.Script") return;
        const code = (node.arguments as AstNode[])[0];
        if (!code || isStaticLiteral(code)) return;
        fire(node, code);
      },
    };
  },
});
