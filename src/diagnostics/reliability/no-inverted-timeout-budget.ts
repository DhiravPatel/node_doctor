import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import type { Binding } from "../../core/scope.ts";
import { getMethodName, getCalleeName, getObjectProperty, staticMemberPath } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";

/**
 * §136 — Timeout budget consistency (the file-local, provable slice).
 *
 * Timeouts must DECREASE down a call chain. When an outer wrapper gives an
 * operation B milliseconds but the operation's own outbound call is configured to
 * keep trying for T > B, the caller gives up at B while the HTTP request keeps
 * running until T — orphaned work, a held socket, and a connection-pool leak that
 * only shows under load. (The opposite direction — an inner timeout shorter than
 * the outer budget — is correct layering and never flagged.)
 *
 * EVERY semantic in this rule is proven, never assumed from a name (an adversarial
 * hunt showed name-matching flags retry counts, lock-hold durations, and tracing
 * helpers as "budgets"). Fires on two shapes:
 *
 *  (1) `pTimeout(op, B)` / `pTimeout(op, { milliseconds: B })` where the callee
 *      binding PROVABLY resolves to the `p-timeout` package (ESM import or
 *      `require("p-timeout")`). A same-file function that merely shares the name
 *      (a retry helper, a lock wrapper) never fires.
 *        ❌ import pTimeout from "p-timeout";
 *           await pTimeout(fetch(u, { signal: AbortSignal.timeout(10_000) }), 2_000);
 *
 *  (2) `Promise.race([...])` where one element is PROVABLY a B-ms rejecting timer:
 *      an inline `new Promise((_, reject) => setTimeout(<rejects>, B))` whose
 *      setTimeout is UNCONDITIONAL (a timer nested under `if (offline)` is a guard,
 *      not a deadline), or a bare call of a same-file module-level helper whose body
 *      is exactly that shape with the delay being its first parameter.
 *        ❌ Promise.race([got(u, { timeout: { request: 30_000 } }),
 *                         new Promise((_, rej) => setTimeout(() => rej(new Error("t")), 5_000))])
 *      A resolve-only sleep, a `.timeout(n)` METHOD on a query chain, an imported
 *      helper of unknown semantics, and a hedging backup-request element never count.
 *
 * Inner outbound-timeout facts (each client verified by its import, so a same-file
 * function named `got`/`fetch` is never mistaken for the HTTP library):
 *   `fetch(u, { signal: AbortSignal.timeout(T) })`  — global fetch, or node-fetch/undici/cross-fetch
 *   `axios[.verb](…, { timeout: T })`               — import "axios"; config position by verb
 *                                                     (post/put/patch carry the BODY at arg 1 —
 *                                                     a payload field named `timeout` never counts)
 *   `got(u, { timeout: T | { request: T } })`       — import "got" (nested `request` is got-only)
 *   `ky(u, { timeout: T })`                         — import "ky"
 *   `http.request({ timeout: T })` / https          — import "http"/"https" (or node: prefixed)
 *
 * The operation is followed one bounded hop into same-file functions — but only
 * through MODULE-level `const`/`function` bindings (a `let`/`var` can be reassigned
 * after declaration, and duplicate block-scoped names inside a function can shadow;
 * both would attribute a stale body). Function bodies inside the op are pruned
 * unless provably invoked (IIFE, `.map`/`.then`-style callbacks, or the op itself).
 *
 * DELIBERATE SILENCE (precision-first — a false positive is a release blocker):
 *   ✅ a local withTimeout(fn, retries) retry helper        // not p-timeout
 *   ✅ Promise.race([fetchA, fetchB])                        // no provable timer
 *   ✅ Promise.race([op, sleep(2_000)])                      // resolve-only
 *   ✅ query.timeout(5_000) as a race element                // a method, not a timer
 *   ✅ pTimeout(fetch(u, { …1_000 }), 5_000)                 // inner ≤ outer: correct
 *   ✅ axios.post(u, { timeout: 60_000 })                    // payload field, not config
 *   ✅ timeout: 0 client sentinels; dynamic values           // unprovable
 * Cross-file budget propagation through the call graph remains Planned.
 *
 * Reported on the OUTER wrapper/race call with both numbers in the message.
 * OPT-IN (defaultEnabled: false): advisory, must never affect the default self-scan.
 */

/** A statically-known non-negative number: a numeric literal, or `a * b` of two. */
const staticNumber = (node: AstNode | null | undefined): number | null => {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "number") return node.value;
  if (node.type === "BinaryExpression" && node.operator === "*") {
    const l = staticNumber(node.left as AstNode);
    const r = staticNumber(node.right as AstNode);
    if (l !== null && r !== null) return l * r;
  }
  return null;
};

/** `AbortSignal.timeout(T)` → T. */
const abortSignalTimeoutMs = (node: AstNode | null | undefined): number | null => {
  if (!node || node.type !== "CallExpression") return null;
  if (staticMemberPath(node.callee as AstNode) !== "AbortSignal.timeout") return null;
  return staticNumber((node.arguments as AstNode[] | undefined)?.[0]);
};

/** A static `timeout` value from an options object literal; got's nested
 *  `{ timeout: { request: T } }` form only when `allowNested` (got-only semantics). */
const optionsTimeoutMs = (options: AstNode | null | undefined, allowNested: boolean): number | null => {
  if (!options || options.type !== "ObjectExpression") return null;
  const timeout = getObjectProperty(options, "timeout");
  if (!timeout) return null;
  const direct = staticNumber(timeout.value as AstNode);
  if (direct !== null) return direct;
  if (allowNested && (timeout.value as AstNode)?.type === "ObjectExpression") {
    const request = getObjectProperty(timeout.value as AstNode, "request");
    if (request) return staticNumber(request.value as AstNode);
  }
  return null;
};

/**
 * The module specifier a binding was imported/required from, or null. IMMUTABLE
 * bindings only: an ESM import, or a `const x = require("pkg")`. A `let`/`var`
 * require-binding can be reassigned to something else entirely before the call
 * (`let pTimeout = require("p-timeout"); pTimeout = retryShim`) — trusting it
 * proves the wrong callee.
 */
const importSourceOf = (binding: Binding | null): string | null => {
  if (!binding) return null;
  if (binding.kind === "import") {
    const decl = (binding.declNode as { parent?: AstNode }).parent;
    const source = decl?.type === "ImportDeclaration" ? decl.source?.value : undefined;
    return typeof source === "string" ? source : null;
  }
  if (binding.kind !== "const") return null;
  const init = binding.initNode;
  if (
    init?.type === "CallExpression" &&
    (init.callee as AstNode)?.type === "Identifier" &&
    (init.callee as AstNode).name === "require"
  ) {
    const arg = (init.arguments as AstNode[] | undefined)?.[0];
    if (arg?.type === "Literal" && typeof arg.value === "string") return arg.value;
  }
  return null;
};

const AXIOS_BODY_VERBS = new Set(["post", "put", "patch"]);
const AXIOS_CONFIG1_VERBS = new Set(["get", "delete", "head", "options"]);

const FETCH_SOURCES = new Set(["node-fetch", "undici", "cross-fetch"]);
const HTTP_SOURCES = new Set(["http", "node:http", "https", "node:https"]);

export const noInvertedTimeoutBudget = defineDiagnostic({
  id: "no-inverted-timeout-budget",
  title: "Inner timeout exceeds the outer budget",
  severity: "warn",
  category: "Reliability",
  confidence: "high",
  tags: ["reliability", "timeout"],
  defaultEnabled: false,
  scope: "file",
  recommendation:
    "Make timeouts decrease down the chain: give the inner call a timeout shorter than the outer budget (leaving headroom for retries/parsing), or derive it from the outer one. When the outer wrapper wins the race, also abort the inner request (pass the same AbortSignal) so the orphaned HTTP call does not keep holding a socket.",
  create: (ctx) => {
    const bindingOf = (name: string, at: AstNode): Binding | null => ctx.scope.getBinding(name, at);

    /**
     * How many times a name is DECLARED anywhere in the file (imports, consts,
     * functions, classes, params, pattern elements). The scope resolver models
     * function-level scopes only, so a block-scoped shadow (`{ const pTimeout =
     * shim; … }`) hoists and first-binding-wins hides it — a call inside the
     * block would be misattributed to the import. Any name declared MORE than
     * once is therefore ambiguous, and a proof built on it is no proof.
     */
    let declCounts: Map<string, number> | null = null;
    const declarationCount = (name: string): number => {
      if (!declCounts) {
        const counts = new Map<string, number>();
        const bump = (n: unknown): void => {
          if (typeof n === "string") counts.set(n, (counts.get(n) ?? 0) + 1);
        };
        const decls = collectDescendants(
          ctx.program,
          (n) =>
            n.type === "VariableDeclarator" ||
            n.type === "FunctionDeclaration" ||
            n.type === "ClassDeclaration" ||
            n.type === "ImportDefaultSpecifier" ||
            n.type === "ImportSpecifier" ||
            n.type === "ImportNamespaceSpecifier" ||
            n.type === "CatchClause",
          undefined,
          true,
        );
        for (const d of decls) {
          const id = (d.type === "ImportDefaultSpecifier" || d.type === "ImportSpecifier" || d.type === "ImportNamespaceSpecifier"
            ? d.local
            : d.type === "CatchClause"
              ? d.param
              : d.id) as AstNode | undefined;
          if (!id) continue;
          if (id.type === "Identifier") bump(id.name);
          else {
            // Destructuring patterns: count every bound identifier (over-counting
            // default-value references only makes the guard MORE conservative).
            for (const p of collectDescendants(id, (n) => n.type === "Identifier", undefined, true)) {
              bump(p.name);
            }
          }
        }
        // Function params shadow too (function f(pTimeout) { … }).
        const fns = collectDescendants(
          ctx.program,
          (n) => n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression",
          undefined,
          true,
        );
        for (const fn of fns) {
          for (const p of (fn.params as AstNode[] | undefined) ?? []) {
            if (p.type === "Identifier") bump(p.name);
            else for (const q of collectDescendants(p, (n) => n.type === "Identifier", undefined, true)) bump(q.name);
          }
        }
        declCounts = counts;
      }
      return declCounts.get(name) ?? 0;
    };

    /** An import/require binding is a PROOF only when it is the name's sole declaration. */
    const soleImportSource = (name: string, at: AstNode): string | null => {
      const source = importSourceOf(bindingOf(name, at));
      if (source === null) return null;
      return declarationCount(name) === 1 ? source : null;
    };

    /** Does this bare-identifier call resolve, unambiguously, to `p-timeout`? */
    const isPTimeoutCall = (call: AstNode): boolean => {
      const callee = call.callee as AstNode | undefined;
      if (!callee || callee.type !== "Identifier") return false;
      return soleImportSource(callee.name as string, call) === "p-timeout";
    };

    /**
     * The statically-provable timeout of one outbound call, with every client
     * verified by its binding/import — a same-file `fetch`/`got` lookalike is not
     * the HTTP library and never counts.
     */
    const outboundTimeoutMs = (call: AstNode): number | null => {
      if (call.type !== "CallExpression") return null;
      const args = (call.arguments as AstNode[] | undefined) ?? [];
      const callee = call.callee as AstNode | undefined;
      if (!callee) return null;

      if (callee.type === "Identifier") {
        const name = callee.name as string;
        const binding = bindingOf(name, call);
        const source = soleImportSource(name, call);

        // fetch(u, { signal: AbortSignal.timeout(T) }) — the GLOBAL (no declaration
        // of the name anywhere in the file), or a sole known fetch-impl import.
        if (
          name === "fetch" &&
          ((binding === null && declarationCount(name) === 0) || (source !== null && FETCH_SOURCES.has(source)))
        ) {
          const options = args[1];
          if (options?.type === "ObjectExpression") {
            const signal = getObjectProperty(options, "signal");
            if (signal) return abortSignalTimeoutMs(signal.value as AstNode);
          }
          return null;
        }
        // axios(cfg) / got(u, opts) / ky(u, opts) — each proven by its sole import.
        if (source === "axios") return optionsTimeoutMs(args[0] ?? null, false) ?? optionsTimeoutMs(args[1] ?? null, false);
        if (source === "got") return optionsTimeoutMs(args[1] ?? null, true) ?? optionsTimeoutMs(args[0] ?? null, true);
        if (source === "ky") return optionsTimeoutMs(args[1] ?? null, false) ?? optionsTimeoutMs(args[0] ?? null, false);
        return null;
      }

      if (callee.type !== "MemberExpression") return null;
      const rootExpr = callee.object as AstNode | undefined;
      if (!rootExpr || rootExpr.type !== "Identifier") return null;
      const rootName = rootExpr.name as string;
      const source = soleImportSource(rootName, call);
      const method = getMethodName(call);
      if (!method) return null;

      // axios.<verb> — the config position depends on the verb; the BODY of a
      // post/put/patch is application data and a `timeout` field there never counts.
      if (source === "axios") {
        if (method === "request") return optionsTimeoutMs(args[0] ?? null, false);
        if (AXIOS_CONFIG1_VERBS.has(method)) return optionsTimeoutMs(args[1] ?? null, false);
        if (AXIOS_BODY_VERBS.has(method)) return optionsTimeoutMs(args[2] ?? null, false);
        return null;
      }
      // got.<verb> / ky.<verb> — options in position 1 (never .extend/.create config).
      if ((source === "got" || source === "ky") && !["extend", "create", "mergeOptions", "paginate"].includes(method)) {
        return optionsTimeoutMs(args[1] ?? null, source === "got");
      }
      // http.request / https.request / .get — proven by the node module import.
      if (source !== null && HTTP_SOURCES.has(source) && (method === "request" || method === "get")) {
        for (const a of args) {
          const t = optionsTimeoutMs(a, false);
          if (t !== null) return t;
        }
      }
      return null;
    };

    /** Conditional wrappers that make a timer a guard rather than a deadline. */
    const isConditional = (n: AstNode): boolean =>
      n.type === "IfStatement" ||
      n.type === "ConditionalExpression" ||
      n.type === "LogicalExpression" ||
      n.type === "SwitchStatement";

    /**
     * If `executor` is a `(resolve, reject) => …` whose body UNCONDITIONALLY calls
     * `setTimeout(<something that UNCONDITIONALLY rejects>, delay)`, return the
     * delay expression. Not a deadline: a resolve-only sleep, a reject nested under
     * a condition (whether outside the timer — `if (offline) setTimeout(…)` — or
     * INSIDE its callback — `setTimeout(() => { if (CHAOS) reject() }, …)`), and an
     * executor that also calls `clearTimeout` (it may disarm its own timer; whether
     * the deadline survives is not provable).
     */
    const rejectingTimerDelay = (executor: AstNode | null | undefined): AstNode | null => {
      if (!executor || (executor.type !== "ArrowFunctionExpression" && executor.type !== "FunctionExpression")) return null;
      const params = (executor.params as AstNode[] | undefined) ?? [];
      const rejectName = params[1]?.type === "Identifier" ? (params[1].name as string) : null;
      if (!rejectName) return null;
      const disarms = collectDescendants(
        executor.body as AstNode,
        (n) => n.type === "CallExpression" && getCalleeName(n.callee as AstNode) === "clearTimeout",
        undefined,
        true,
      );
      if (disarms.length > 0) return null;
      const timers = collectDescendants(
        executor.body as AstNode,
        (n) => n.type === "CallExpression" && getCalleeName(n.callee as AstNode) === "setTimeout",
        isConditional, // a timer under if/ternary/&&/switch is a guard, not a deadline
        true,
      );
      for (const timer of timers) {
        const targs = (timer.arguments as AstNode[] | undefined) ?? [];
        const cb = targs[0];
        const delay = targs[1];
        if (!cb || !delay) continue;
        const isRejectRef = cb.type === "Identifier" && cb.name === rejectName;
        const callsReject =
          !isRejectRef &&
          collectDescendants(
            cb,
            (n) => n.type === "CallExpression" && getCalleeName(n.callee as AstNode) === rejectName,
            isConditional, // the reject must fire on EVERY path through the callback
            true,
          ).length > 0;
        if (isRejectRef || callsReject) return delay;
      }
      return null;
    };

    /** Does a function body ever assign to / update the named parameter? A helper
     *  that rewrites its delay (`secs = secs * 1000`, `ms = Math.max(ms, 60_000)`)
     *  breaks the delay-equals-argument equation the proof relies on. */
    const reassignsParam = (fn: AstNode, paramName: string): boolean =>
      collectDescendants(
        (fn.body as AstNode) ?? fn,
        (n) =>
          (n.type === "AssignmentExpression" &&
            (n.left as AstNode)?.type === "Identifier" &&
            (n.left as AstNode).name === paramName) ||
          (n.type === "UpdateExpression" &&
            (n.argument as AstNode)?.type === "Identifier" &&
            (n.argument as AstNode).name === paramName),
        undefined,
        true,
      ).length > 0;

    /**
     * The budget a race element imposes, in ms — or null when the element is not
     * PROVABLY a rejecting timer. Inline `new Promise(executor)`, or a bare call of
     * a same-file module-level helper whose body is exactly that shape with the
     * delay being its first parameter. A member call (`query.timeout(5_000)`), an
     * imported helper, and anything else never count.
     */
    const raceTimerBudgetMs = (element: AstNode): number | null => {
      if (element.type === "NewExpression" && getCalleeName(element.callee as AstNode) === "Promise") {
        const delay = rejectingTimerDelay((element.arguments as AstNode[] | undefined)?.[0]);
        return staticNumber(delay);
      }
      if (element.type === "CallExpression" && (element.callee as AstNode)?.type === "Identifier") {
        const helperName = (element.callee as AstNode).name as string;
        if (declarationCount(helperName) !== 1) return null; // shadowed/ambiguous name
        const binding = bindingOf(helperName, element);
        if (!binding || binding.scopeKind !== "module") return null;
        if (binding.kind !== "const" && binding.kind !== "function") return null;
        const fn =
          binding.declNode?.type === "FunctionDeclaration"
            ? binding.declNode
            : binding.initNode &&
                (binding.initNode.type === "ArrowFunctionExpression" || binding.initNode.type === "FunctionExpression")
              ? binding.initNode
              : null;
        if (!fn) return null;
        const firstParam = ((fn.params as AstNode[] | undefined) ?? [])[0];
        if (firstParam?.type !== "Identifier") return null;
        if (reassignsParam(fn, firstParam.name as string)) return null;
        // The helper's RETURN VALUE must be the rejecting-timer Promise — a helper
        // that merely CONTAINS one (a slow-warning logger that returns the op
        // untouched) races nothing. Expression-bodied arrow: the body IS the
        // Promise. Block-bodied: every own return must be one.
        const body = fn.body as AstNode;
        const returned: AstNode[] = [];
        if (body?.type === "NewExpression") {
          returned.push(body);
        } else if (body?.type === "BlockStatement") {
          const returns = collectDescendants(
            body,
            (n) => n.type === "ReturnStatement",
            (n) =>
              n.type === "ArrowFunctionExpression" || n.type === "FunctionExpression" || n.type === "FunctionDeclaration",
            true,
          );
          for (const r of returns) {
            const arg = r.argument as AstNode | undefined;
            if (!arg) return null; // a bare return — not the timer
            returned.push(arg);
          }
        }
        if (returned.length === 0) return null;
        for (const candidate of returned) {
          if (candidate.type !== "NewExpression" || getCalleeName(candidate.callee as AstNode) !== "Promise") return null;
          const delay = rejectingTimerDelay((candidate.arguments as AstNode[] | undefined)?.[0]);
          if (!(delay?.type === "Identifier" && delay.name === firstParam.name)) return null;
        }
        return staticNumber((element.arguments as AstNode[] | undefined)?.[0]);
      }
      return null;
    };

    const isFnLike = (n: AstNode | null | undefined): boolean =>
      !!n && (n.type === "ArrowFunctionExpression" || n.type === "FunctionExpression" || n.type === "FunctionDeclaration");

    const PROMISE_COMBINATORS = new Set(["Promise.all", "Promise.allSettled", "Promise.any", "Promise.race"]);

    /** A `.map`/`.flatMap` whose result feeds DIRECTLY into a Promise combinator —
     *  the one shape where an array callback provably runs under the budget. A bare
     *  `.map` might be a lazy stream helper; a `.then` might be a thenable
     *  lookalike that only registers the callback. Neither is followed. */
    const isCombinatorMap = (call: AstNode): boolean => {
      const method = getMethodName(call);
      if (method !== "map" && method !== "flatMap") return false;
      const parent = (call as { parent?: AstNode }).parent;
      if (!parent || parent.type !== "CallExpression") return false;
      const path = staticMemberPath(parent.callee as AstNode);
      return path !== null && PROMISE_COMBINATORS.has(path);
    };

    /**
     * The largest statically-provable outbound timeout that RUNS UNDER the budget.
     * A function-like input yields nothing: a function VALUE reached here was
     * constructed, returned, or stored — not invoked — and its body runs later
     * under someone else's budget (the factory-thunk false positive). Function
     * bodies inside the scan are pruned unless provably invoked: an IIFE whose
     * body is a block, or a `.map` callback feeding directly into a Promise
     * combinator. One bounded hop follows MODULE-level `const`/`function`
     * bindings only — a `let`/`var` may be reassigned and a function-scoped
     * duplicate may shadow, either of which would attribute a stale body.
     */
    const maxInnerTimeout = (op: AstNode, hop: number): { ms: number; call: AstNode } | null => {
      if (isFnLike(op)) return null;
      let best: { ms: number; call: AstNode } | null = null;
      const consider = (candidate: { ms: number; call: AstNode } | null): void => {
        if (candidate && (best === null || candidate.ms > best.ms)) best = candidate;
      };
      const calls = collectDescendants(op, (n) => n.type === "CallExpression", isFnLike, true);
      for (const call of calls) {
        const t = outboundTimeoutMs(call);
        if (t !== null && t > 0) consider({ ms: t, call });
        const calleeExpr = call.callee as AstNode | undefined;
        // IIFE: (async () => { … })() runs here. Its body is scanned as a block —
        // an expression-bodied arrow returning a function VALUE stays excluded.
        if (calleeExpr && isFnLike(calleeExpr) && hop > 0) {
          consider(maxInnerTimeout((calleeExpr.body as AstNode) ?? calleeExpr, hop - 1));
        }
        if (hop > 0 && isCombinatorMap(call)) {
          for (const a of (call.arguments as AstNode[] | undefined) ?? []) {
            if (isFnLike(a)) consider(maxInnerTimeout((a.body as AstNode) ?? a, hop - 1));
          }
        }
        if (hop > 0 && calleeExpr?.type === "Identifier") {
          const binding = bindingOf(calleeExpr.name as string, call);
          if (binding && binding.scopeKind === "module" && (binding.kind === "const" || binding.kind === "function")) {
            const fn =
              binding.declNode?.type === "FunctionDeclaration"
                ? binding.declNode
                : binding.initNode && isFnLike(binding.initNode)
                  ? binding.initNode
                  : null;
            if (fn?.body) consider(maxInnerTimeout(fn.body as AstNode, hop - 1));
          }
        }
      }
      return best;
    };

    const report = (outer: AstNode, budget: number, inner: { ms: number; call: AstNode }): void => {
      ctx.report(
        outer,
        `The outer budget gives this operation ${budget}ms, but an inner call is configured to keep trying for ${inner.ms}ms — when the wrapper gives up, the request keeps running (orphaned work, a held socket). Make the inner timeout shorter than the outer budget, and abort the inner call when the budget expires.`,
      );
    };

    return {
      CallExpression: (node) => {
        // Shape (1): pTimeout(op, B) — the callee must PROVABLY be the p-timeout package.
        if (isPTimeoutCall(node)) {
          const args = (node.arguments as AstNode[] | undefined) ?? [];
          const op = args[0];
          if (!op) return;
          let budget = staticNumber(args[1]);
          if (budget === null && args[1]?.type === "ObjectExpression") {
            const ms = getObjectProperty(args[1], "milliseconds");
            if (ms) budget = staticNumber(ms.value as AstNode);
          }
          if (budget === null || budget <= 0) return;
          const inner = maxInnerTimeout(op, 2);
          if (inner && inner.ms > budget) report(node, budget, inner);
          return;
        }

        // Shape (2): Promise.race([op…, provably-rejecting-timer(B)]).
        if (staticMemberPath(node.callee as AstNode) === "Promise.race") {
          const arr = (node.arguments as AstNode[] | undefined)?.[0];
          if (!arr || arr.type !== "ArrayExpression") return;
          const elements = ((arr.elements as AstNode[] | undefined) ?? []).filter(Boolean);
          let budget: number | null = null;
          for (const el of elements) {
            const b = raceTimerBudgetMs(el);
            if (b !== null && b > 0 && (budget === null || b < budget)) budget = b;
          }
          if (budget === null) return;
          for (const el of elements) {
            if (raceTimerBudgetMs(el) !== null) continue; // the timer itself
            const inner = maxInnerTimeout(el, 2);
            if (inner && inner.ms > budget) {
              report(node, budget, inner);
              return;
            }
          }
        }
      },
    };
  },
});
