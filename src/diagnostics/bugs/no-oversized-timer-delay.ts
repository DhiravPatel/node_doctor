import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, getCalleeName } from "../../core/ast.ts";

/**
 * §204 — a timer delay that overflows, so the timer fires immediately.
 *
 * Node stores a timer's delay in a **signed 32-bit int**. A delay above
 * 2³¹−1 ms (24.85 days) overflows, Node warns on stderr and clamps the delay to
 * **1 ms** — so the callback that was meant to run next month runs on the next
 * tick:
 *
 *   ❌ setTimeout(expireSession, 1000 * 60 * 60 * 24 * 30);   // fires in 1ms
 *   ❌ setInterval(monthlyReport, 30 * 86_400_000);           // every 1ms, forever
 *   ✅ setTimeout(expireSession, 1000 * 60 * 60 * 24 * 20);   // 20 days, fits
 *
 * The arithmetic reads as obviously correct — `1000 * 60 * 60 * 24 * 30` is
 * plainly "30 days" — which is exactly why the bug survives review. And it is
 * silent in every environment where the timer is not waited on: tests do not run
 * for a month, so nothing but production ever sees it. `setInterval` is worse
 * than `setTimeout`: a monthly job becomes a 1 ms hot loop.
 *
 * PRECISION MODEL. The claim is arithmetic, so it is made only where the
 * arithmetic is:
 *
 *   - The delay must **fold to a number from literals alone** — a numeric
 *     literal, or `+ - * /` over numeric literals. A variable, a config read,
 *     or a call is not folded and is never reported, even if its name says
 *     `THIRTY_DAYS`.
 *   - The callee must be a global `setTimeout`/`setInterval` with no local
 *     binding shadowing it, or `timers.setTimeout` from `node:timers` — and the
 *     imported name must still resolve to that import at the CALL SITE. A
 *     parameter called `timers`, or a `setTimeout` shadowed by a fake-timer
 *     harness, is somebody else's function with its own units.
 *   - `setImmediate` takes no delay, and `AbortSignal.timeout` is a different
 *     clamp; neither is touched here.
 */

/** Node stores the delay as a signed 32-bit int; above this it clamps to 1 ms. */
const TIMER_MAX = 2_147_483_647;

const TIMER_FUNCTIONS = new Set(["setTimeout", "setInterval"]);

/**
 * Fold an expression to a number using literals ALONE. Anything else — an
 * identifier, a call, a member read — makes the value unknown, and an unknown
 * value is never reported.
 */
const foldNumber = (node: AstNode | null | undefined, depth = 0): number | null => {
  if (!node || depth > 12) return null;
  if (node.type === "Literal") return typeof node.value === "number" ? (node.value as number) : null;
  if (node.type === "UnaryExpression" && (node.operator === "-" || node.operator === "+")) {
    const value = foldNumber(node.argument as AstNode, depth + 1);
    if (value === null) return null;
    return node.operator === "-" ? -value : value;
  }
  if (node.type === "BinaryExpression") {
    const left = foldNumber(node.left as AstNode, depth + 1);
    const right = foldNumber(node.right as AstNode, depth + 1);
    if (left === null || right === null) return null;
    switch (node.operator as string) {
      case "*":
        return left * right;
      case "+":
        return left + right;
      case "-":
        return left - right;
      case "/":
        return right === 0 ? null : left / right;
      case "**":
        return left ** right;
      default:
        return null;
    }
  }
  return null;
};

/** Render the number the way a human reads a duration. */
const asDuration = (ms: number): string => {
  const days = ms / 86_400_000;
  if (days >= 1) return `${Number.isInteger(days) ? days : days.toFixed(1)} days`;
  const hours = ms / 3_600_000;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hours`;
};

export const noOversizedTimerDelay = defineDiagnostic({
  id: "no-oversized-timer-delay",
  title: "Timer delay overflows 32 bits, so the timer fires immediately",
  severity: "error",
  category: "Bugs",
  confidence: "high",
  tags: ["correctness", "timers", "numeric"],
  recommendation:
    "Node stores a timer delay in a signed 32-bit int, so anything above 2147483647 ms (24.85 days) is clamped to 1 ms — the callback runs on the next tick instead of next month. Schedule it with a cron/queue, or re-arm a shorter timer until the deadline is reached.",
  create: (ctx) => {
    /** Names imported from `node:timers`, so `timers.setTimeout` is covered. */
    const timerNamespaces = new Set<string>();
    const timerLocals = new Map<string, string>();
    /** Where each imported name was declared, to detect a nearer rebinding. */
    const declaredAt = new Map<string, AstNode>();

    for (const stmt of (ctx.program.body as AstNode[] | undefined) ?? []) {
      if (stmt.type !== "ImportDeclaration") continue;
      const source = stmt.source?.value;
      if (source !== "timers" && source !== "node:timers") continue;
      for (const spec of (stmt.specifiers as AstNode[] | undefined) ?? []) {
        const local = (spec.local as AstNode | undefined)?.name;
        if (typeof local !== "string") continue;
        // The resolver records an import binding against the SPECIFIER node.
        declaredAt.set(local, spec);
        if (spec.type === "ImportSpecifier") {
          const imported = spec.imported as AstNode | undefined;
          const name = imported?.type === "Identifier" ? (imported.name as string) : null;
          if (name !== null && TIMER_FUNCTIONS.has(name)) timerLocals.set(local, name);
        } else {
          timerNamespaces.add(local);
        }
      }
    }

    /** Does `name`, at `at`, still resolve to the `node:timers` import? */
    const stillTheImport = (name: string, at: AstNode): boolean => {
      const declaration = declaredAt.get(name);
      if (!declaration) return false;
      const binding = ctx.scope.getBinding(name, at);
      return binding === null || binding.declNode === declaration;
    };

    /** Which timer function does this call reach, if any? */
    const timerNameOf = (call: AstNode): string | null => {
      const callee = call.callee as AstNode | undefined;
      if (callee?.type === "Identifier") {
        const name = callee.name as string;
        const viaImport = timerLocals.get(name);
        if (viaImport !== undefined) return stillTheImport(name, callee) ? viaImport : null;
        if (!TIMER_FUNCTIONS.has(name)) return null;
        // A LOCAL `setTimeout` is somebody else's function with its own rules.
        return ctx.scope.getBinding(name, callee) === null ? name : null;
      }
      if (callee?.type !== "MemberExpression") return null;
      const object = callee.object as AstNode | undefined;
      const method = getMethodName(call);
      if (method === null || !TIMER_FUNCTIONS.has(method)) return null;
      // `timers.setTimeout(…)` and `globalThis.setTimeout(…)` are the global one.
      if (object?.type === "Identifier") {
        const name = object.name as string;
        if (timerNamespaces.has(name)) return stillTheImport(name, object) ? method : null;
        if ((name === "globalThis" || name === "global") && ctx.scope.getBinding(name, object) === null) return method;
      }
      return null;
    };

    return {
      CallExpression: (node) => {
        // `promises.setTimeout(ms)` puts the delay first; the callback form second.
        if (getCalleeName(node) === null && getMethodName(node) === null) return;
        const name = timerNameOf(node);
        if (name === null) return;

        const args = (node.arguments as AstNode[] | undefined) ?? [];
        const delayNode = args[1];
        if (!delayNode) return;
        const delay = foldNumber(delayNode);
        if (delay === null || !Number.isFinite(delay) || delay <= TIMER_MAX) return;

        ctx.report(
          delayNode,
          `\`${name}\` is given a delay of ${delay.toLocaleString("en-US")} ms (${asDuration(delay)}), which overflows the signed 32-bit field Node stores it in — the delay is clamped to **1 ms**, so this ${
            name === "setInterval" ? "becomes a 1 ms hot loop instead of a periodic job" : "runs on the next tick instead of at the intended time"
          }. The maximum is ${TIMER_MAX.toLocaleString("en-US")} ms (24.8 days).`,
        );
      },
    };
  },
});
