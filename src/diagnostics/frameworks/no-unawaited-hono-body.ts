import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { unwrapChain } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";
import type { Binding } from "../../core/scope.ts";

/**
 * A Hono request body read without `await`. The value is a Promise, so every
 * field read off it is `undefined` — silently.
 *
 *   ❌ const body = c.req.json();
 *      await createOrder(body.items);        // undefined
 *   ❌ if (c.req.json().token) { … }          // never true
 *   ✅ const body = await c.req.json();
 *   ✅ const { items } = await c.req.json();
 *
 * MEASURED against Hono 4.13.5, by calling every `c.req` member inside a running
 * handler and asking whether the result is a Promise:
 *
 *   json  → ASYNC     valid  → sync      routePath → string (not a function)
 *   text  → ASYNC     param  → sync      url       → string
 *   parseBody   → ASYNC     query   → sync      method    → string
 *   formData    → ASYNC     queries → sync
 *   arrayBuffer → ASYNC     header  → sync
 *   blob        → ASYNC
 *
 * That split is the whole rule. `c.req.param("id")` and `c.req.query("q")` are
 * synchronous and must never be reported; the six body readers are not. Measured
 * end to end: a handler doing `const b = c.req.json(); return c.json({ got: b.x })`
 * answers **200 with `{"got":null}`** — the request succeeds, the field is
 * missing, and nothing anywhere says why.
 *
 * It is easy to write because `c.req` reads like Express's `req`, where `req.body`
 * is a plain object already parsed by middleware. In Hono the parse happens when
 * you ask for it, so the `await` is load-bearing, and a handler that forgets it
 * still returns 200 with a body-shaped hole in it.
 *
 * PRECISION MODEL. Two structural claims, no inference:
 *
 *   - The call is one of the six ASYNC readers on a `c.req`-shaped receiver — a
 *     member chain whose tail is `<something>.req.<reader>`. The synchronous
 *     accessors are excluded by enumeration from the runtime, not from memory.
 *   - The Promise is consumed SYNCHRONOUSLY: a member access directly on the
 *     call, a destructure of it, or a binding initialized to a bare call that is
 *     later member-accessed.
 *
 * Silent wherever the Promise is treated as one — `await`, `return`,
 * `.then`/`.catch`/`.finally`, `Promise.all([c.req.json(), …])`, and a binding
 * that is passed onward without ever being read. Also silent on a call whose
 * result is simply discarded: `c.req.parseBody()` on its own line is pointless
 * but harmless, and this rule claims only the reads that produce `undefined`.
 *
 * Unlike a Promise from `next()`, awaiting is not optional here in any spelling:
 * there is no form of `c.req.json()` that yields a parsed body synchronously.
 *
 * Gated on the `hono` capability.
 */

/** `c.req` members that return a Promise — enumerated from Hono 4.13.5. */
const ASYNC_BODY_READERS = new Set(["json", "text", "parseBody", "formData", "arrayBuffer", "blob"]);

/** Members that treat the value AS a promise, which is correct. */
const PROMISE_METHODS = new Set(["then", "catch", "finally"]);

/**
 * Is this call `<ctx>.req.<asyncReader>(…)`? Returns the reader name.
 *
 * Anchored on the `.req.` segment rather than on the context parameter's name,
 * so `c.req.json()`, `ctx.req.json()` and a destructured `{ req }` all match,
 * while a bare `json()` or `service.json()` cannot.
 */
const asyncBodyRead = (node: AstNode | null | undefined): string | null => {
  const call = unwrapChain(node);
  if (!call || call.type !== "CallExpression") return null;
  const callee = unwrapChain(call.callee as AstNode);
  if (!callee || callee.type !== "MemberExpression" || callee.computed) return null;

  const reader = callee.property as AstNode | undefined;
  if (reader?.type !== "Identifier" || !ASYNC_BODY_READERS.has(String(reader.name))) return null;

  // The receiver must itself be a `.req` member — `c.req`, `ctx.req`, `this.req`.
  const receiver = unwrapChain(callee.object as AstNode);
  if (!receiver || receiver.type !== "MemberExpression" || receiver.computed) return null;
  const reqSegment = receiver.property as AstNode | undefined;
  if (reqSegment?.type !== "Identifier" || String(reqSegment.name) !== "req") return null;

  return String(reader.name);
};

export const noUnawaitedHonoBody = defineDiagnostic({
  id: "no-unawaited-hono-body",
  title: "Hono request body read without await, so every field is undefined",
  severity: "error",
  category: "Bugs",
  confidence: "high",
  requires: ["hono"],
  tags: ["hono", "async", "http"],
  recommendation:
    "Await it: `const body = await c.req.json()`. Hono parses the body when you ask for it, so `c.req.json()`, `.text()`, `.parseBody()`, `.formData()`, `.arrayBuffer()` and `.blob()` all return Promises — measured on Hono 4.13.5. Reading a field off the un-awaited call gives `undefined` and the request still answers 200. The synchronous accessors are `c.req.param()`, `.query()`, `.queries()`, `.header()` and `.valid()`, which need no await.",
  create: (ctx) => {
    const report = (node: AstNode, reader: string): void => {
      ctx.report(
        node,
        `\`c.req.${reader}()\` returns a **Promise** — Hono parses the body when you ask for it, unlike Express where middleware has already filled \`req.body\`. Reading a field off the un-awaited call gives \`undefined\` and the request still answers 200: measured on Hono 4.13.5, \`const b = c.req.json(); return c.json({ got: b.x })\` answers \`{"got":null}\`. Add the \`await\`. (\`c.req.param()\`, \`.query()\`, \`.header()\` and \`.valid()\` are synchronous and need none.)`,
      );
    };

    return {
      MemberExpression: (node) => {
        if (node.computed) return;
        const reader = asyncBodyRead(node.object as AstNode);
        if (reader === null) return;
        const property = node.property as AstNode | undefined;
        if (property?.type === "Identifier" && PROMISE_METHODS.has(String(property.name))) return;
        report(node, reader);
      },

      VariableDeclarator: (node) => {
        const reader = asyncBodyRead(node.init as AstNode);
        if (reader === null) return;

        const id = node.id as AstNode | undefined;
        // `const { items } = c.req.json()` — destructuring a Promise.
        if (id?.type === "ObjectPattern" || id?.type === "ArrayPattern") {
          report(node, reader);
          return;
        }
        if (id?.type !== "Identifier") return;

        // A bare `const p = c.req.json()` is only wrong once a field is read off
        // it; handing the Promise onward is legitimate.
        const binding: Binding | null = ctx.scope.resolveIdentifier(id);
        if (!binding) return;
        const readsField = collectDescendants(ctx.program, (n) => {
          if (n.type !== "MemberExpression" || n.computed) return false;
          const object = n.object as AstNode | undefined;
          if (object?.type !== "Identifier" || String(object.name) !== String(id.name)) return false;
          if (ctx.scope.resolveIdentifier(object) !== binding) return false;
          const property = n.property as AstNode | undefined;
          return !(property?.type === "Identifier" && PROMISE_METHODS.has(String(property.name)));
        }).length > 0;
        if (readsField) report(node, reader);
      },
    };
  },
});
