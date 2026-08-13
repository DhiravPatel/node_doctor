import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName } from "../../core/ast.ts";

/**
 * §3 — a response body sent with a status that forbids one.
 *
 * `204 No Content`, `205 Reset Content` and `304 Not Modified` are defined by
 * HTTP as carrying no body, and Node enforces it: the payload is **silently
 * discarded** on the way out.
 *
 *   ❌ res.status(204).json({ ok: true, deleted: 3 });
 *      // measured: the client receives "" — length 0
 *   ✅ res.status(204).end();
 *   ✅ res.sendStatus(204);
 *   ✅ res.status(200).json({ ok: true, deleted: 3 });   // if the body matters
 *
 * The server logs a success and the handler looks right, so nothing here fails
 * on the server side at all. The failure lands on the CALLER: `await res.json()`
 * on an empty response throws `SyntaxError: Unexpected end of JSON input`, and a
 * client that reads `result.deleted` gets `undefined` and carries on with it.
 * Whichever it is, it happens in somebody else's codebase, which is why this
 * survives.
 *
 * It is written for a real reason — "there is no content, and here is what I
 * did" — and the two halves of that sentence contradict each other. Either the
 * body matters, and the status is wrong, or it does not, and the body is.
 *
 * PRECISION MODEL. Both halves are literal, so there is nothing to infer:
 *
 *   - The status must be a NUMERIC LITERAL that HTTP defines as bodiless.
 *     `res.status(code)` is not folded; a variable could be anything.
 *   - A body must actually be passed. `.end()` and `.send()` with no argument
 *     send nothing and are the correct spelling — they are never reported, and
 *     neither is a provably EMPTY argument: `send(null)`, `send(undefined)` and
 *     `send("")` are how people spell "no body" when the signature wants one.
 *     `@adonisjs/cors` ends a preflight with exactly `status(204).send(null)`.
 *   - `res.sendStatus(204)` sets the status and sends the standard message; it
 *     is the idiom this rule recommends, and is not matched.
 *   - Only the chained form, where the status and the body are provably the same
 *     response. `res.status(204); … res.json(x);` across statements would need
 *     to prove no branch intervenes.
 */

/** Statuses HTTP defines as carrying no body. Node discards one if you send it. */
const BODILESS = new Map([
  [204, "204 No Content"],
  [205, "205 Reset Content"],
  [304, "304 Not Modified"],
]);

/**
 * Is this argument provably empty — `null`, `undefined`, or `""`?
 *
 * These are how people spell "no body" when the method's signature wants one.
 * Nothing is sent, so nothing is discarded.
 */
const isEmptyBody = (node: AstNode): boolean => {
  if (node.type === "Literal") return node.value === null || node.value === "";
  return node.type === "Identifier" && node.name === "undefined";
};

/** Response methods that take a body argument. */
const BODY_METHODS = new Set(["json", "send", "jsonp", "write", "end"]);

export const noBodyOnBodilessStatus = defineDiagnostic({
  id: "no-body-on-bodiless-status",
  title: "Response body sent with a status that cannot carry one",
  severity: "error",
  category: "Bugs",
  confidence: "high",
  tags: ["correctness", "http", "api"],
  recommendation:
    "Either the body matters — use `200` — or it does not, and `res.status(204).end()` / `res.sendStatus(204)` says so. HTTP defines 204, 205 and 304 as bodiless and Node discards the payload, so the caller's `await res.json()` throws on an empty response.",
  create: (ctx) => ({
    CallExpression: (node) => {
      const method = getMethodName(node);
      if (method === null || !BODY_METHODS.has(method)) return;

      // A body must actually be passed. `.end()` and `.send()` send nothing.
      const args = (node.arguments as AstNode[] | undefined) ?? [];
      const body = args[0];
      if (!body) return;
      // `.end(cb)` takes a callback, not a body.
      if (body.type === "ArrowFunctionExpression" || body.type === "FunctionExpression") return;
      // A provably EMPTY argument is the author writing "no body" out loud.
      // `@adonisjs/cors` ends a preflight with `response.status(204).send(null)`,
      // under a comment saying exactly that — and it sends nothing, so there is
      // nothing to discard and no claim to make. Found by the corpus, not by
      // the unit cases.
      if (isEmptyBody(body)) return;

      // The receiver must be `<res>.status(<literal>)`, so the status and the
      // body are provably the same response.
      const callee = node.callee as AstNode | undefined;
      if (callee?.type !== "MemberExpression") return;
      const receiver = callee.object as AstNode | undefined;
      if (receiver?.type !== "CallExpression" || getMethodName(receiver) !== "status") return;

      const statusArg = ((receiver.arguments as AstNode[] | undefined) ?? [])[0];
      if (statusArg?.type !== "Literal" || typeof statusArg.value !== "number") return;
      const label = BODILESS.get(statusArg.value as number);
      if (label === undefined) return;

      ctx.report(
        node,
        `HTTP defines \`${label}\` as carrying no body, and Node discards this one — the client receives an empty response. Nothing fails on the server, so this shows up in the CALLER: \`await res.json()\` throws \`Unexpected end of JSON input\`, or the field it reads is \`undefined\`. Either the body matters and the status should be \`200\`, or it does not and \`.end()\` says so.`,
      );
    },
  }),
});
