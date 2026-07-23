import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, getReceiverName, rootObjectName, isFunctionLike } from "../../core/ast.ts";
import { findDescendant } from "../../core/walk.ts";

/**
 * §135 — Retry amplification / thundering herd.
 *
 * A retry wrapper is meant to run ONE operation a few times. The bug this rule
 * catches is *stacking* retries: a retry wrapper (say 3×) whose operation ITSELF
 * retries (another 3×, whether through a second retry wrapper or an SDK client
 * that retries internally by default). One logical request then fans out into
 * 3×3 = 9 — or, three layers deep, 27 — hits on the exact dependency that is
 * already failing. The retry storm IS the outage: it delays the dependency's
 * recovery and can turn a blip into a sustained herd. No linter models this
 * because the multiplication only exists when you look at two layers at once.
 *
 * This rule fires on two unambiguous, file-local shapes and nothing else:
 *
 *  (1) NESTED retry wrappers — a retry-wrapper call whose operation function's
 *      body (nested functions pruned) contains ANOTHER retry-wrapper call.
 *        ❌ pRetry(() => pRetry(() => call()))
 *        ❌ retry(async () => { await asyncRetry(() => db()); })
 *
 *  (2) Retry wrapper around an AUTO-RETRYING client — a retry-wrapper call whose
 *      operation body calls a client that retries by default. The client list is
 *      deliberately TIGHT: each entry genuinely retries on its own, AND is gated on
 *      that SDK actually being imported in the file — a receiver merely NAMED like a
 *      client (`emailClient.send`, a local `got`) is not enough.
 *        ❌ pRetry(() => s3Client.send(cmd))   // AWS SDK v3 retries internally (needs @aws-sdk import)
 *        ❌ pRetry(() => got("https://x"))     // got retries GETs by default (needs `got` import)
 *        ❌ promiseRetry(() => stripe.charges.create(x)) // Stripe SDK auto-retries (needs `stripe` import)
 *        ❌ pRetry(() => axios.get(u))         // only when `axios-retry` is imported
 *
 * DELIBERATE SILENCE (precision-first — a false positive here is a release
 * blocker, and the correct single-layer pattern is by far the common case):
 *   ✅ pRetry(() => fetch(url))        // plain fetch does not retry itself
 *   ✅ pRetry(() => db.query(sql))     // a plain db call does not retry itself
 *   ✅ retry(() => work())             // a lone retry wrapper — this is correct
 *   ✅ client.retry(3)                 // a fluent `.retry(n)` config, not a wrapper
 *   ✅ const retry = 5                 // `retry` as a value, never called
 * We do NOT infer numeric retry factors and we do NOT walk cross-file: this is
 * the unambiguous, file-local slice only. Nested functions are pruned from the
 * operation body so an inner retry that lives inside an *uninvoked* closure does
 * not read as amplification.
 *
 * Reported on the OUTER retry-wrapper call. OPT-IN (defaultEnabled:false):
 * heuristic/advisory, and it must never affect the default self-scan.
 */

/**
 * Callee names that denote a retry WRAPPER — a function that takes an operation
 * and re-invokes it on failure. We match the last callee segment (getMethodName),
 * so both a bare `pRetry(fn)` and a `lib.pRetry(fn)` qualify. A fluent
 * `.retry(n)` shares the "retry" name but is excluded structurally below by the
 * "first argument is a function" test — its argument is a number, not a callback.
 */
const RETRY_WRAPPERS = new Set([
  "pRetry",
  "retry",
  "asyncRetry",
  "promiseRetry",
  "retryAsync",
  "withRetry",
  "backOff",
  "pRetryable",
]);

/**
 * Receiver names (lowercased last segment) for AWS SDK v3 clients. AWS SDK v3
 * clients retry internally by default (standard mode, up to `maxAttempts`), so a
 * `<Client>.send(command)` inside a retry wrapper is a genuine multiplication.
 * The general rule below is "receiver ends with `Client`"; this set additionally
 * catches lower-cased or abbreviated client names.
 */
const AWS_CLIENT_NAMES = new Set([
  "s3client",
  "dynamodbclient",
  "dynamoclient",
  "sqsclient",
  "snsclient",
  "lambdaclient",
]);

const isFunctionArg = (n: AstNode | null | undefined): boolean =>
  !!n && (n.type === "ArrowFunctionExpression" || n.type === "FunctionExpression");

/**
 * If `n` is a retry-wrapper call (matching name AND a function as its first
 * argument), return that operation function; otherwise null. The function-arg
 * requirement is what separates a real wrapper from a fluent `.retry(3)` config.
 */
const retryWrapperOperation = (n: AstNode | null | undefined): AstNode | null => {
  if (!n || n.type !== "CallExpression") return null;
  const name = getMethodName(n);
  if (!name || !RETRY_WRAPPERS.has(name)) return null;
  const first = (n.arguments as AstNode[] | undefined)?.[0];
  return isFunctionArg(first) ? (first as AstNode) : null;
};

const isRetryWrapperCall = (n: AstNode): boolean => retryWrapperOperation(n) !== null;

/** The last `.`-segment of the receiver a member call is invoked on. */
const receiverLastSegment = (call: AstNode): string | null => {
  const receiver = getReceiverName(call);
  if (!receiver) return null;
  const parts = receiver.split(".");
  return parts[parts.length - 1] ?? null;
};

/** AWS SDK v3 `<Client>.send(command)` — receiver ends with `Client` or is a known AWS client. */
const isAwsSendCall = (call: AstNode): boolean => {
  if (getMethodName(call) !== "send") return false;
  // AWS `send` always takes the command object; require an argument so a bare
  // `emitter.send()` on some unrelated `...Client` does not match.
  if (!((call.arguments as AstNode[] | undefined)?.length)) return false;
  const seg = receiverLastSegment(call);
  if (!seg) return false;
  return seg.endsWith("Client") || AWS_CLIENT_NAMES.has(seg.toLowerCase());
};

/** got methods that build/configure an instance rather than issue a request (no retry). */
const GOT_NON_REQUEST_METHODS = new Set(["extend", "mergeOptions", "paginate"]);

/**
 * `got(...)` or `got.<verb>(...)` — got retries idempotent requests by default. But
 * `got.extend(...)` / `got.paginate` build/iterate rather than issue a single retried
 * request, so they are not the amplifying call.
 */
const isGotCall = (call: AstNode): boolean => {
  if (rootObjectName(call.callee) !== "got") return false;
  const method = getMethodName(call);
  return !(method && GOT_NON_REQUEST_METHODS.has(method) && (call.callee as AstNode).type !== "Identifier");
};

/** `stripe.<...>(...)` — the Stripe SDK auto-retries on network errors. Member call only. */
const isStripeCall = (call: AstNode): boolean =>
  rootObjectName(call.callee) === "stripe" && (call.callee as AstNode).type !== "Identifier";

/** `axios(...)` / `axios.<method>(...)` — only counts when `axios-retry` is wired in this file. */
const isAxiosCall = (call: AstNode): boolean => rootObjectName(call.callee) === "axios";

/**
 * Is a package whose specifier satisfies `matches` imported (ESM `import` or CJS
 * `require`) anywhere in the file? The client detections are gated on this so a
 * receiver merely NAMED like a client (`emailClient.send`, a local `got`/`stripe`
 * binding) never fires — only a genuine, imported auto-retrying SDK does.
 */
const importsMatching = (program: AstNode, matches: (source: string) => boolean): boolean => {
  for (const stmt of (program.body as AstNode[] | undefined) ?? []) {
    if (stmt.type === "ImportDeclaration" && typeof stmt.source?.value === "string" && matches(stmt.source.value)) {
      return true;
    }
  }
  return (
    findDescendant(program, (n) => {
      if (n.type !== "CallExpression") return false;
      const callee = n.callee as AstNode | undefined;
      if (!callee || callee.type !== "Identifier" || callee.name !== "require") return false;
      const arg = (n.arguments as AstNode[] | undefined)?.[0];
      return !!arg && arg.type === "Literal" && typeof arg.value === "string" && matches(arg.value);
    }) !== null
  );
};

export const noRetryAmplification = defineDiagnostic({
  id: "no-retry-amplification",
  title: "Nested retries amplify into a thundering herd",
  severity: "warn",
  category: "Reliability",
  confidence: "high",
  tags: ["reliability"],
  defaultEnabled: false,
  scope: "file",
  recommendation:
    "Retry at exactly ONE layer. Disable the inner client's built-in retries (AWS SDK `maxAttempts: 1`, got `retry: 0`, Stripe `maxNetworkRetries: 0`) or remove the outer retry wrapper, and add jitter to the single remaining retry so failures do not synchronize into a herd on the failing dependency.",
  create: (ctx) => {
    // Client detections are gated on the SDK actually being imported — a receiver
    // named like a client is not enough (`emailClient.send`, a local `got`).
    const awsSdkWired = importsMatching(ctx.program, (s) => s.startsWith("@aws-sdk/") || s === "aws-sdk");
    const gotWired = importsMatching(ctx.program, (s) => s === "got");
    const stripeWired = importsMatching(ctx.program, (s) => s === "stripe");
    const axiosRetryWired = importsMatching(ctx.program, (s) => s === "axios-retry");

    /** A call whose completion itself involves a retry — the inner half of the multiplication. */
    const isAmplifyingCall = (n: AstNode): boolean => {
      if (n.type !== "CallExpression") return false;
      if (isRetryWrapperCall(n)) return true; // shape (1): a nested retry wrapper
      // shape (2): an auto-retrying client — each gated on its SDK being imported.
      if (awsSdkWired && isAwsSendCall(n)) return true;
      if (gotWired && isGotCall(n)) return true;
      if (stripeWired && isStripeCall(n)) return true;
      if (axiosRetryWired && isAxiosCall(n)) return true;
      return false;
    };

    /**
     * Search the operation function's OWN body for an amplifying call, pruning
     * nested functions. `findDescendant` does not test the root, so we test the
     * body node itself first — an arrow's expression body may BE the inner call.
     */
    const findAmplifyingCall = (fn: AstNode): AstNode | null => {
      const body = fn.body as AstNode | undefined;
      if (!body) return null;
      if (isAmplifyingCall(body)) return body;
      return findDescendant(body, isAmplifyingCall, isFunctionLike);
    };

    return {
      CallExpression: (node) => {
        const operation = retryWrapperOperation(node);
        if (!operation) return;
        const inner = findAmplifyingCall(operation);
        if (!inner) return;

        const descriptor = isRetryWrapperCall(inner)
          ? `a nested retry wrapper (\`${getMethodName(inner)}\`)`
          : `an auto-retrying SDK client (\`${getMethodName(inner) ?? "send"}\`)`;

        ctx.report(
          node,
          `This retry wrapper's operation itself retries via ${descriptor} — attempts multiply (e.g. 3×3 = 9) into a thundering herd on a failing dependency. Retry at exactly ONE layer: disable the inner client's built-in retries or drop the outer wrapper, and add jitter.`,
        );
      },
    };
  },
});
