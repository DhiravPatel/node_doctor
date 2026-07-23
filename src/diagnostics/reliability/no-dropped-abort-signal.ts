import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, getObjectProperty, isFunctionLike, rootObjectName } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";

/**
 * §137 (file-local slice) — a function that HAS an `AbortSignal` but drops it on
 * a cancellable outbound call.
 *
 * THE BUG. A function receives an `AbortSignal` (its parameter is named `signal`
 * or `abortSignal`, or it destructures `{ signal }` from an options object) — the
 * whole point of that parameter is that the caller can cancel the function's
 * work. But inside, the function makes a cancellable outbound request —
 * `fetch` / `axios` / `got` — WITHOUT forwarding the signal. When the caller
 * aborts, the outbound call keeps running: orphaned work, a held connection, a
 * wasted request budget, a timeout that never fires. The tool to cancel it was
 * in scope and was dropped on the floor.
 *
 *   ❌ async function load(url, signal) { return fetch(url); }
 *   ✅ async function load(url, signal) { return fetch(url, { signal }); }
 *
 * WHY OPT-IN / PRECISION-FIRST. The overwhelmingly common shape in real code is a
 * `fetch` with no signal in scope at all — flagging every un-signalled fetch
 * would be a false-positive machine. So we require the SIGNAL PARAMETER to be
 * present on the function that directly makes the call, and we never guess:
 *
 *   - No `signal`/`abortSignal` parameter in scope → silent. We do NOT infer a
 *     signal from an `AbortController` construction or any other heuristic; the
 *     parameter is the one high-confidence, self-documenting shape.
 *   - The call already forwards it (`fetch(url, { signal })`) → silent.
 *   - The options object spreads another object (`fetch(url, { ...opts })`) → the
 *     signal may be inside `opts`; unprovable, so silent (conservative).
 *   - The options argument is an opaque value we can't read (`fetch(url, opts)`)
 *     → silent; only an object literal we can fully see, or a missing config
 *     slot, is strong enough to fire.
 *   - The call is inside a NESTED function that does not itself take the signal
 *     parameter → silent. We scan each signal-bearing function's OWN body and
 *     prune nested functions: a callback has its own scope and its own contract.
 *
 * We only ever report on a `fetch`/`axios`/`got` call whose config slot is
 * demonstrably present-without-`signal` or demonstrably absent — an unambiguous
 * "the signal exists and was dropped" shape.
 */

/** Parameter names that denote an inbound cancellation signal. */
const SIGNAL_PARAM_NAMES = new Set(["signal", "abortSignal"]);

/** Axios request methods (`axios.<m>(...)`); non-request members (`create`) are ignored. */
const AXIOS_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "request"]);
/** Axios methods that take a body before the config object → config is the 3rd arg. */
const AXIOS_BODY_METHODS = new Set(["post", "put", "patch"]);
/** got request methods (`got.<m>(...)`); `extend`/`paginate` etc. are ignored. */
const GOT_METHODS = new Set(["get", "post", "put", "patch", "delete", "head"]);

type OutboundKind =
  | { lib: "fetch" }
  | { lib: "axios"; bare: boolean; method?: string }
  | { lib: "got"; bare: boolean };

/** Classify a call as a cancellable outbound request, or null. */
const classifyOutbound = (node: AstNode): OutboundKind | null => {
  if (node.type !== "CallExpression") return null;
  const callee = node.callee as AstNode | undefined;
  if (callee?.type === "Identifier") {
    if (callee.name === "fetch") return { lib: "fetch" };
    if (callee.name === "axios") return { lib: "axios", bare: true };
    if (callee.name === "got") return { lib: "got", bare: true };
    return null;
  }
  // Member calls: only a literal `axios.*` / `got.*` root, and only request methods.
  const root = rootObjectName(callee);
  const method = getMethodName(node);
  if (root === "axios" && method && AXIOS_METHODS.has(method)) return { lib: "axios", bare: false, method };
  if (root === "got" && method && GOT_METHODS.has(method)) return { lib: "got", bare: false };
  return null;
};

/** Does a function parameter provide a `signal`/`abortSignal` binding? */
const paramProvidesSignal = (param: AstNode | null | undefined): boolean => {
  if (!param) return false;
  // Default value: `function f(url, signal = ctrl.signal)`.
  const target = param.type === "AssignmentPattern" ? (param.left as AstNode) : param;
  if (!target) return false;
  // Plain identifier param: `signal` / `abortSignal`.
  if (target.type === "Identifier") return SIGNAL_PARAM_NAMES.has(target.name);
  // Destructured options param: `{ signal }` / `{ signal: s }` / `{ abortSignal }`.
  if (target.type === "ObjectPattern") {
    for (const prop of (target.properties as AstNode[]) ?? []) {
      if (prop.type !== "Property") continue; // ignore RestElement
      const key = prop.key as AstNode | undefined;
      const keyName =
        key?.type === "Identifier" && !prop.computed
          ? (key.name as string)
          : key?.type === "Literal" && typeof key.value === "string"
            ? key.value
            : null;
      if (keyName && SIGNAL_PARAM_NAMES.has(keyName)) return true;
    }
  }
  return false;
};

/** Does this function directly receive a cancellation signal via its parameters? */
const functionHasSignalParam = (fn: AstNode): boolean =>
  ((fn.params as AstNode[]) ?? []).some(paramProvidesSignal);

const EQUALITY_OPS = new Set(["===", "!==", "==", "!="]);
const isSignalName = (n: AstNode | null | undefined): boolean =>
  !!n && n.type === "Identifier" && SIGNAL_PARAM_NAMES.has(n.name as string);
const isStringLiteral = (n: AstNode | null | undefined): boolean =>
  !!n && ((n.type === "Literal" && typeof n.value === "string") || n.type === "TemplateLiteral");

/**
 * Is the `signal` parameter actually a UNIX signal (a `"SIGTERM"` string) or some
 * other non-`AbortSignal` value, rather than a cancellation token? A process-signal
 * / shutdown handler treats it as a STRING: it compares it (`signal === "SIGTERM"`),
 * switches on it, or logs it by interpolation (`` `got ${signal}` ``). An
 * `AbortSignal` is never used that way — it is passed along or has
 * `.aborted`/`.addEventListener` read. So any of those string-uses of the bare
 * `signal` identifier is dispositive: it is not a cancellation signal, and
 * forwarding it to `fetch` would be nonsense advice.
 */
const usedAsUnixSignal = (body: AstNode): boolean =>
  collectDescendants(
    body,
    (n) =>
      (n.type === "BinaryExpression" &&
        EQUALITY_OPS.has(n.operator as string) &&
        ((isSignalName(n.left) && isStringLiteral(n.right)) ||
          (isSignalName(n.right) && isStringLiteral(n.left)))) ||
      (n.type === "SwitchStatement" && isSignalName(n.discriminant)) ||
      // A bare `${signal}` interpolation — logging/formatting it as a string.
      (n.type === "Identifier" && isSignalName(n) && n.parent?.type === "TemplateLiteral"),
    undefined,
    true,
  ).length > 0;

type ConfigVerdict = "dropped" | "forwarded-or-unprovable";

/** Does an object-literal config forward the signal, or is it unprovable (spread)? */
const objectConfigVerdict = (obj: AstNode): ConfigVerdict => {
  const props = (obj.properties as AstNode[]) ?? [];
  // A spread (`{ ...opts }`) might carry the signal — unprovable, stay silent.
  if (props.some((p) => p?.type !== "Property")) return "forwarded-or-unprovable";
  if (getObjectProperty(obj, "signal")) return "forwarded-or-unprovable";
  return "dropped";
};

/** Decide whether an outbound call demonstrably drops the in-scope signal. */
const dropsSignal = (node: AstNode, kind: OutboundKind): boolean => {
  const args = (node.arguments as AstNode[]) ?? [];
  // A spread call-argument (`fetch(url, ...rest)`) hides the config — stay silent.
  if (args.some((a) => a?.type === "SpreadElement")) return false;

  // Locate the config-object argument slot for this library shape.
  let idx: number;
  if (kind.lib === "fetch") {
    idx = 1;
  } else if (kind.lib === "axios") {
    if (kind.bare) idx = args[0]?.type === "ObjectExpression" ? 0 : 1;
    else idx = kind.method && AXIOS_BODY_METHODS.has(kind.method) ? 2 : kind.method === "request" ? 0 : 1;
  } else {
    // got(options) vs got(url, options) / got.post(url, options).
    idx = args[0]?.type === "ObjectExpression" ? 0 : 1;
  }

  const slot = args[idx];
  if (slot === undefined) return true; // no config slot at all → signal cannot have been passed
  if (slot.type !== "ObjectExpression") return false; // opaque config variable → conservative
  return objectConfigVerdict(slot) === "dropped";
};

export const noDroppedAbortSignal = defineDiagnostic({
  id: "no-dropped-abort-signal",
  title: "Outbound call drops an in-scope AbortSignal",
  severity: "warn",
  category: "Reliability",
  confidence: "high",
  tags: ["reliability", "async"],
  defaultEnabled: false,
  recommendation:
    "Forward the received `AbortSignal` into the outbound request — pass `{ signal }` (or add `signal` to the existing options/config object) so an abort by the caller actually cancels the request instead of leaving it running.",
  create: (ctx) => {
    const callName = (node: AstNode): string => {
      const callee = node.callee as AstNode | undefined;
      if (callee?.type === "Identifier") return callee.name;
      const root = rootObjectName(callee);
      const method = getMethodName(node);
      return root && method ? `${root}.${method}` : (method ?? "fetch");
    };

    const checkFunction = (fn: AstNode): void => {
      if (!functionHasSignalParam(fn)) return;
      const body = (fn.body as AstNode | undefined) ?? fn;
      // A `signal` compared to a string / switched on is a UNIX signal, not an
      // AbortSignal — forwarding it to `fetch` would be nonsense. Stay silent.
      if (usedAsUnixSignal(body)) return;
      // A concise arrow whose body *is* a nested function (`(signal) => () => …`)
      // has no own-scope work — the outbound call lives in the nested scope.
      // `collectDescendants` does not skip-check its root, so guard it here.
      if (isFunctionLike(body)) return;
      // Scan this function's OWN body only — prune nested functions (their scope,
      // their own contract). includeSelf covers expression-bodied arrows whose
      // body *is* the outbound call.
      const calls = collectDescendants(
        body,
        (n) => classifyOutbound(n) !== null,
        isFunctionLike,
        true,
      );
      for (const call of calls) {
        const kind = classifyOutbound(call);
        if (!kind) continue;
        if (!dropsSignal(call, kind)) continue;
        ctx.report(
          call,
          `this function receives an \`AbortSignal\` (\`signal\`) but calls \`${callName(call)}(...)\` ` +
            `without forwarding it — when the caller aborts, this request keeps running (orphaned work, ` +
            `a held connection). Pass \`{ signal }\` to the call.`,
        );
      }
    };

    return {
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
      ArrowFunctionExpression: checkFunction,
    };
  },
});
