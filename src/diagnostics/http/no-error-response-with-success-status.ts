import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, isFunctionLike, rootObjectName } from "../../core/ast.ts";
import { collectDescendants, findDescendant } from "../../core/walk.ts";

/**
 * A caught exception reported to the client with a 2xx status.
 *
 *   ❌ } catch (error) {
 *        return response.status(200).json({ status: false, error: 'Combo completion failed',
 *                                           details: error?.message })
 *      }
 *   ✅ } catch (error) {
 *        return response.status(500).json({ error: 'Combo completion failed' })
 *      }
 *
 * The handler threw. Something is broken. And the response says everything is
 * fine — so every layer that reads the status instead of the body agrees:
 *
 *   - `fetch` sets `res.ok === true`; axios resolves rather than rejects, so a
 *     client's `catch` never runs and the error branch is dead code.
 *   - APM, load balancers and uptime checks record a success. The endpoint shows
 *     a 100% success rate while it is failing, so no alert ever fires. This is
 *     the expensive part: the outage is invisible in exactly the dashboard
 *     someone would look at.
 *   - Retry and circuit-breaker middleware never trigger — 200 is terminal.
 *
 * The bug is self-concealing, which is why it survives: the JSON body carries
 * `status: false` and a message, so anything reading the body looks correct in
 * review and in manual testing. Only the machinery that reads status codes is
 * misled, and that machinery is silent by nature.
 *
 * PRECISION MODEL. Two independent things must both be true, and either alone is
 * not enough.
 *
 * **The status must be provably 2xx.** An explicit literal `status(200)`/`code(2xx)`,
 * or no status set anywhere in the catch — where Express, Adonis and Fastify all
 * default to 200. A computed status (`res.status(err.statusCode)`) is unknown, and
 * unknown is silence.
 *
 * **The payload must evidence failure.** It has to carry the caught error, or an
 * `error`/`errors` key, or an explicit `success: false`/`status: false`/`ok: false`.
 * This is what keeps a legitimate fallback silent — a catch that recovers and
 * returns real data on 200 is correct, and it is correct precisely because its
 * payload makes no failure claim.
 *
 * Excluded, each for a reason found in real code rather than imagined:
 *
 *   - **GraphQL.** `{ data, errors }` with HTTP 200 is what the spec requires. A
 *     `data`+`errors` payload, or a file that imports a GraphQL server, is silent.
 *   - **Webhook and OAuth-callback handlers.** Returning 2xx from a webhook's
 *     catch is deliberate — it stops the provider retrying a message already
 *     durably queued. Found in the corpus as an OAuth popup callback that renders
 *     an HTML error page for `window.opener`, which is also correct.
 *   - **String and template bodies.** `res.send(`<html>…`)` is a page for a
 *     browser to render, not an API error envelope. Only `.json()` and
 *     `.send(<object>)` are judged.
 */

/** Response objects, by the conventional names across Express/Adonis/Fastify. */
const RESPONSE_RECEIVERS = new Set(["res", "response", "reply"]);
/** Sinks that emit a structured body. `.end`/`.write` are raw streams. */
const BODY_SINKS = new Set(["json", "send"]);
/** Status setters: Express `status`, Fastify `code`, both `.status(n)`-shaped. */
const STATUS_SETTERS = new Set(["status", "code"]);
/** Keys whose presence is the payload declaring its own failure. */
const FAILURE_KEYS = new Set(["error", "errors", "err", "exception"]);
/** Flags whose `false` value declares failure. */
const SUCCESS_FLAGS = new Set(["success", "status", "ok", "succeeded", "isSuccess"]);

/**
 * Handlers where a 2xx on the error path is the intended behaviour: webhook
 * receivers acknowledging a message they will not have re-delivered, and OAuth
 * callbacks rendering a result page into a popup.
 */
const DELIBERATE_2XX_CONTEXT = /webhook|callback|ipn|notify|notification|oauth|redirect/i;

/** Is this `<response>.<method>` on a conventionally-named response object? */
const isResponseCall = (node: AstNode, method: string, allowed: Set<string>): boolean => {
  if (!allowed.has(method)) return false;
  const root = rootObjectName(node.callee as AstNode);
  return root !== null && RESPONSE_RECEIVERS.has(root);
};

/**
 * The status this response call carries, read from its own chain:
 * a number for a literal, `"dynamic"` for a computed one, `null` for none.
 */
const chainedStatus = (node: AstNode): number | "dynamic" | null => {
  let current = (node.callee as AstNode | undefined)?.type === "MemberExpression"
    ? ((node.callee as AstNode).object as AstNode | undefined)
    : undefined;
  while (current?.type === "CallExpression") {
    const method = getMethodName(current);
    if (method !== null && STATUS_SETTERS.has(method)) {
      const arg = ((current.arguments as AstNode[] | undefined) ?? [])[0];
      if (arg?.type === "Literal" && typeof arg.value === "number") return arg.value;
      return "dynamic";
    }
    const callee = current.callee as AstNode | undefined;
    current = callee?.type === "MemberExpression" ? (callee.object as AstNode | undefined) : undefined;
  }
  return null;
};

export const noErrorResponseWithSuccessStatus = defineDiagnostic({
  id: "no-error-response-with-success-status",
  title: "Caught error returned to the client with a 2xx status",
  severity: "error",
  category: "Bugs",
  confidence: "high",
  tags: ["http", "error-handling", "observability"],
  recommendation:
    "Return a status that matches what happened — 500 for an unexpected failure, 4xx where the caller can fix it. A 2xx makes `res.ok` true, resolves axios instead of rejecting, and records a success in APM and uptime checks, so the endpoint reports a 100% success rate while it is failing and no alert fires. The JSON body saying `success: false` is read by nothing that routes, retries, or alerts.",
  create: (ctx) => {
    /** Names bound as caught errors: `catch (err) { … }`. */
    const errorNames = new Set<string>();
    /** Response calls that sit inside a catch block. */
    const inCatch = new Set<AstNode>();
    /** Catch clauses that set a non-2xx or computed status as a separate statement. */
    const statusSetOutOfChain = new Map<AstNode, number | "dynamic">();
    /** The catch clause each judged call belongs to. */
    const owningCatch = new Map<AstNode, AstNode>();
    /** Does this file speak GraphQL, where 200-with-errors is the spec? */
    let graphqlFile = false;

    /** Is any part of this expression the caught error? */
    const carriesCaughtError = (node: AstNode): boolean => {
      const isError = (n: AstNode): boolean => n.type === "Identifier" && errorNames.has(n.name as string);
      if (isError(node)) return true;
      return findDescendant(node, isError, isFunctionLike) !== null;
    };

    /**
     * Does an `error`/`errors` key's value actually hold an error? `null`,
     * `undefined`, `false` and `[]` are all the absence of one — a response
     * keeping its shape stable, not reporting a failure.
     */
    const carriesError = (value: AstNode | undefined): boolean => {
      if (!value) return false;
      if (value.type === "Literal" && (value.value === null || value.value === false)) return false;
      if (value.type === "Identifier" && value.name === "undefined") return false;
      if (value.type === "ArrayExpression" && ((value.elements as AstNode[] | undefined) ?? []).length === 0) {
        return false;
      }
      return true;
    };

    /** Does this payload declare its own failure? */
    const declaresFailure = (arg: AstNode): { failed: boolean; graphql: boolean } => {
      let failed = carriesCaughtError(arg);
      let hasData = false;
      let hasErrors = false;
      if (arg.type === "ObjectExpression") {
        for (const property of (arg.properties as AstNode[] | undefined) ?? []) {
          if (property.type !== "Property") continue;
          const key = property.key as AstNode | undefined;
          const name =
            key?.type === "Identifier"
              ? (key.name as string)
              : key?.type === "Literal" && typeof key.value === "string"
                ? key.value
                : null;
          if (name === null) continue;
          if (name === "data") hasData = true;
          if (name === "errors") hasErrors = true;
          // An `error` key only claims failure when it actually holds one. A
          // recovery path may return `{ data, error: null }` to keep the
          // response shape stable, and that is a success, not a defect.
          if (FAILURE_KEYS.has(name) && carriesError(property.value as AstNode | undefined)) failed = true;
          if (SUCCESS_FLAGS.has(name)) {
            const value = property.value as AstNode | undefined;
            if (value?.type === "Literal" && value.value === false) failed = true;
          }
        }
      }
      // `{ data, errors }` is the GraphQL response envelope, where 200 is correct.
      return { failed, graphql: hasData && hasErrors };
    };

    return {
      Program: (root) => {
        graphqlFile = findDescendant(
          root,
          (n) =>
            (n.type === "ImportDeclaration" || n.type === "ImportExpression") &&
            typeof (n.source as AstNode | undefined)?.value === "string" &&
            /graphql|apollo|nexus|type-graphql|mercurius/i.test(String((n.source as AstNode).value)),
          () => false,
        ) !== null;

        for (const clause of collectDescendants(root, (n) => n.type === "CatchClause")) {
          const param = clause.param as AstNode | undefined;
          if (param?.type === "Identifier") errorNames.add(param.name as string);

          const body = clause.body as AstNode | undefined;
          if (!body) continue;
          for (const call of collectDescendants(body, (n) => n.type === "CallExpression")) {
            const method = getMethodName(call);
            if (method === null) continue;
            // A status set as its own statement — `res.status(500); res.json(…)`.
            if (isResponseCall(call, method, STATUS_SETTERS)) {
              const arg = ((call.arguments as AstNode[] | undefined) ?? [])[0];
              const value =
                arg?.type === "Literal" && typeof arg.value === "number" ? arg.value : ("dynamic" as const);
              const existing = statusSetOutOfChain.get(clause);
              // Any non-2xx or unknown status in the block ends the claim.
              if (existing === undefined || value === "dynamic" || (typeof value === "number" && (value < 200 || value > 299))) {
                statusSetOutOfChain.set(clause, value);
              }
              continue;
            }
            if (isResponseCall(call, method, BODY_SINKS)) {
              inCatch.add(call);
              owningCatch.set(call, clause);
            }
          }
        }
      },

      CallExpression: (node) => {
        if (!inCatch.has(node)) return;
        if (graphqlFile) return;

        const args = (node.arguments as AstNode[] | undefined) ?? [];
        const payload = args[0];
        if (!payload) return;
        // A string or template body is a page, not an API error envelope.
        if (payload.type === "Literal" && typeof payload.value === "string") return;
        if (payload.type === "TemplateLiteral") return;

        const { failed, graphql } = declaresFailure(payload);
        if (!failed || graphql) return;

        // The status must be PROVABLY 2xx, from the chain or from the block.
        const chained = chainedStatus(node);
        if (chained === "dynamic") return;
        let status: number;
        if (typeof chained === "number") {
          status = chained;
        } else {
          const clause = owningCatch.get(node);
          const outOfChain = clause ? statusSetOutOfChain.get(clause) : undefined;
          if (outOfChain === "dynamic") return;
          // No status anywhere in the catch: Express, Adonis and Fastify default to 200.
          status = typeof outOfChain === "number" ? outOfChain : 200;
        }
        if (status < 200 || status > 299) return;

        // Webhook acknowledgements and OAuth callbacks return 2xx on purpose.
        const context = `${ctx.normalizedFilePath} ${functionNameAround(node)}`;
        if (DELIBERATE_2XX_CONTEXT.test(context)) return;

        ctx.report(
          node,
          `The handler threw, and this reports it with HTTP ${status}. Every layer that reads the status instead of the body then agrees nothing went wrong: \`res.ok\` is true and axios resolves, so the client's error branch never runs; APM, load balancers and uptime checks record a success, so the endpoint shows a 100% success rate while it is failing and no alert fires; retry and circuit-breaker middleware treat 200 as terminal. The \`success: false\` in the body is read by none of them. Return 500 for an unexpected failure, or a 4xx the caller can act on.`,
        );
      },
    };

    /** The nearest enclosing function's name, for the webhook/callback exclusion. */
    function functionNameAround(node: AstNode): string {
      let current: AstNode | null | undefined = node.parent;
      while (current) {
        if (isFunctionLike(current)) {
          const id = current.id as AstNode | undefined;
          if (id?.type === "Identifier") return id.name as string;
          const parent = current.parent as AstNode | undefined;
          if (parent?.type === "VariableDeclarator" && (parent.id as AstNode)?.type === "Identifier") {
            return (parent.id as AstNode).name as string;
          }
          if (parent?.type === "Property" || parent?.type === "MethodDefinition") {
            const key = parent.key as AstNode | undefined;
            if (key?.type === "Identifier") return key.name as string;
          }
          return "";
        }
        current = current.parent;
      }
      return "";
    }
  },
});
