import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName } from "../../core/ast.ts";
import { isTestFile, TEST_PATH } from "../../core/test-file.ts";

/**
 * §194 — a listener removal that cannot possibly match, so the listener stays.
 *
 * `removeListener` / `off` / `removeEventListener` all remove **by reference
 * identity**. A function literal written at the removal site is a brand-new
 * function object that was never added, so the call finds nothing, removes
 * nothing, and returns successfully:
 *
 *   ❌ socket.on("data", (c) => handle(c));
 *      socket.off("data", (c) => handle(c));       // a DIFFERENT function
 *   ❌ emitter.removeListener("done", this.finish.bind(this));   // .bind is fresh
 *   ✅ const onData = (c) => handle(c);
 *      socket.on("data", onData);
 *      socket.off("data", onData);
 *
 * `.bind()` is the subtler half: it returns a NEW function on every call, so the
 * bound listener that was added and the bound listener being removed are two
 * different objects even though the source text is identical.
 *
 * The failure is silent and cumulative. The listener stays attached, the object
 * it closes over stays reachable, and a per-connection or per-request handler
 * grows the emitter until `MaxListenersExceededWarning` appears in production
 * logs — usually attributed to something else entirely.
 *
 * PRECISION MODEL. This does not need to know what the receiver is, because no
 * removal API in any library removes by structural equality — a fresh function
 * matching a previously registered one is not a thing that happens. What it does
 * need is that the argument is provably fresh:
 *
 *   - A function LITERAL, or a `.bind(…)` call, in the listener position.
 *   - An identifier is never reported: it may well be the same function.
 *   - `removeAllListeners(event)` takes no function and is correct.
 *   - A TEST FILE is inert. The harm claimed here is an emitter that grows for
 *     the lifetime of a long-running process, which a test does not have — and
 *     a test that removes an unregistered listener is usually *asserting* that
 *     doing so is a safe no-op, which is the very behaviour being described.
 *     The PATH convention alone is enough for that: because the harm model is
 *     about lifetime and not about what the test asserts, this does not need
 *     `isTestFile`'s stronger proof, and old assert-script suites with no
 *     `describe`/`it` are the ones that trip this most.
 */

/** Removal APIs whose second argument is matched by reference identity. */
const REMOVAL_METHODS = new Set(["removeListener", "removeEventListener", "off"]);

/** Is this argument a function that did not exist before this line? */
const isFreshFunction = (node: AstNode | null | undefined): "literal" | "bind" | null => {
  if (!node) return null;
  if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") return "literal";
  // `fn.bind(this)` allocates a new function object on every evaluation.
  if (node.type === "CallExpression" && getMethodName(node) === "bind") return "bind";
  return null;
};

export const noLiteralListenerRemoval = defineDiagnostic({
  id: "no-literal-listener-removal",
  title: "Listener removed by a function that was never added",
  severity: "error",
  category: "Reliability",
  confidence: "high",
  tags: ["correctness", "memory", "events"],
  recommendation:
    "Hold the listener in a variable and pass that same reference to both calls: `const onData = …; emitter.on(\"data\", onData); emitter.off(\"data\", onData);`. Removal matches by reference identity, so a function literal — or a fresh `.bind(…)` — never matches what was added.",
  create: (ctx) => {
    // Computed once: a test asserting `off(name, () => {})` does not throw is
    // exercising the no-op on purpose, and has no process to leak into.
    let inert: boolean | null = null;

    return {
    CallExpression: (node) => {
      if (inert === null) {
        inert = TEST_PATH.test(ctx.normalizedFilePath) || isTestFile(ctx.program, ctx.normalizedFilePath);
      }
      if (inert) return;
      const method = getMethodName(node);
      if (method === null || !REMOVAL_METHODS.has(method)) return;
      // A bare `off(fn)` with no receiver is somebody else's API entirely.
      if ((node.callee as AstNode | undefined)?.type !== "MemberExpression") return;

      const args = (node.arguments as AstNode[] | undefined) ?? [];
      if (args.length < 2) return;
      const listener = args[1];
      const freshness = isFreshFunction(listener);
      if (freshness === null || !listener) return;

      ctx.report(
        listener,
        freshness === "bind"
          ? `\`${method}\` matches listeners by reference identity, and \`.bind(…)\` returns a NEW function every time it runs — so the bound function added earlier and this one are different objects. Nothing is removed, and the listener stays attached for the lifetime of the emitter.`
          : `\`${method}\` matches listeners by reference identity, so this function literal — created right here, never registered — removes nothing. The original listener stays attached, holding everything it closes over, until the emitter is collected.`,
      );
    },
    };
  },
});
