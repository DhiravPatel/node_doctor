import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getCalleeName } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";

/**
 * OPT-IN (defaultEnabled: false).
 *
 * `Promise.race([...])` over an array literal in which no branch looks like a
 * timeout. `Promise.race` is the canonical way to bound a hang, but a race made
 * only of real work settles when the *first* operation settles and otherwise
 * waits forever — the exact failure it is usually reached for. Without a timeout
 * branch, a stuck upstream call hangs the race indefinitely.
 *
 * The diagnostic only inspects an array *literal* (the shape it can reason about) and
 * stays silent when any element references `setTimeout`, `AbortSignal.timeout`,
 * or a `timeout`/`delay`/`deadline`-named binding.
 *
 * ❌ await Promise.race([fetchPrimary(), fetchSecondary()]);
 * ✅ await Promise.race([fetchPrimary(), timeout(5_000)]);
 * ✅ await Promise.race([work(), new Promise((_, r) => setTimeout(r, 5_000))]);
 */

const TIMEOUT_RE = /timeout|deadline|delay|sleep/i;

const looksLikeTimeout = (element: AstNode): boolean =>
  collectDescendants(
    element,
    (n) => n.type === "Identifier" && TIMEOUT_RE.test(n.name),
    undefined,
    true,
  ).length > 0;

export const noRaceWithoutTimeout = defineDiagnostic({
  id: "no-race-without-timeout",
  title: "Promise.race with no timeout branch",
  severity: "warn",
  category: "Reliability",
  tags: ["async"],
  defaultEnabled: false,
  recommendation:
    "Add an explicit timeout branch to the race — a `setTimeout`/`AbortSignal.timeout(ms)` promise or a `timeout(ms)` helper — so a stuck upstream call cannot hang the race forever.",
  create: (ctx) => ({
    CallExpression: (node) => {
      if (getCalleeName(node) !== "Promise.race") return;
      const arg0 = (node.arguments as AstNode[])?.[0];
      if (!arg0 || arg0.type !== "ArrayExpression") return;
      const elements = (arg0.elements as (AstNode | null)[]) ?? [];
      for (const el of elements) {
        if (el && looksLikeTimeout(el)) return;
      }
      ctx.report(
        node,
        "`Promise.race` has no timeout branch — if every operation hangs, the race never settles.",
      );
    },
  }),
});
