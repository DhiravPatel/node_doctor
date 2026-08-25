import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { unwrapChain } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";
import type { Binding } from "../../core/scope.ts";

/**
 * `cookies()`, `headers()` or `draftMode()` used without `await`. Since Next 15
 * these return a **Promise**, so every property read on the result is
 * `undefined`.
 *
 *   ❌ const session = cookies().get("session");
 *   ❌ const c = cookies(); if (c.get("admin")) grantAdmin();
 *   ✅ const session = (await cookies()).get("session");
 *   ✅ const c = await cookies(); if (c.get("admin")) grantAdmin();
 *
 * MEASURED against a running Next 16.3.2 server, over real route handlers:
 *
 *   const c = cookies();  typeof c.get   → "undefined"
 *   const h = headers();  typeof h.get   → "undefined"
 *   const c = await cookies();  typeof c.get → "function"
 *
 * and the server logged, verbatim:
 *
 *   Route "/api/sync" used `cookies().get`. `cookies()` returns a Promise and
 *   must be unwrapped with `await` or `React.use()` before accessing its
 *   properties.
 *
 * The shipped type declarations agree — Next 16.3.2's `next/headers` exports
 * `cookies(): Promise<ReadonlyRequestCookies>`, `headers(): Promise<ReadonlyHeaders>`
 * and `draftMode(): Promise<DraftMode>` — and the temporary synchronous-access
 * shim Next 15 provided is gone, so this is now a hard failure rather than a
 * deprecation warning.
 *
 * WHY IT MATTERS MORE THAN A TYPEERROR. `cookies().get("session")` throws and
 * gives you a 500, which is loud. The expensive spelling is the one that does
 * not throw:
 *
 *   const c = cookies();
 *   if (c?.get?.("role") === "admin") { … }     // always false — silently
 *
 * An optional chain, a `?? false`, or a `try/catch` around the read turns a
 * broken auth check into one that quietly denies (or, inverted, quietly allows).
 * This is the single most common Next 14 → 15 migration defect, and a codemod
 * that missed a file leaves exactly this shape behind.
 *
 * PRECISION MODEL. Two structural claims, no inference:
 *
 *   - The callee is an identifier that resolves to an import of `cookies`,
 *     `headers` or `draftMode` **from `next/headers`**, matched by the local
 *     binding name so an aliased `import { cookies as getCookies }` is covered
 *     and a same-named function from anywhere else is not.
 *   - The Promise is consumed SYNCHRONOUSLY: either a member access directly on
 *     the call (`cookies().get(…)`), a destructure of it
 *     (`const { get } = cookies()`), or a binding initialized to a bare call
 *     which is then member-accessed.
 *
 * Silent by construction wherever the Promise is treated as one: `await cookies()`,
 * `const c = await cookies()`, `return cookies()`, `cookies().then(…)` /
 * `.catch(…)` / `.finally(…)`, `use(cookies())` and `React.use(cookies())` (the
 * documented alternative to `await`), and `Promise.all([cookies(), headers()])`.
 * A binding assigned a bare call but never member-accessed is also silent —
 * passing the Promise onward is legitimate.
 *
 * Gated on the `next` capability. It is deliberately NOT version-gated: the
 * async signature landed in Next 15 and `next` in a modern manifest means 15 or
 * 16, while a Next 14 project that upgrades gets a finding that is already true
 * of the version it is moving to.
 */

/** The `next/headers` exports that became async in Next 15. */
const DYNAMIC_APIS = new Set(["cookies", "headers", "draftMode"]);

/** Members that treat the value AS a promise, which is correct. */
const PROMISE_METHODS = new Set(["then", "catch", "finally"]);

/** Local names bound to `next/headers`' dynamic APIs, aliases included. */
const dynamicApiLocals = (program: AstNode): Map<string, string> => {
  const locals = new Map<string, string>();
  for (const statement of (program.body as AstNode[] | undefined) ?? []) {
    if (statement.type !== "ImportDeclaration") continue;
    if ((statement.source as AstNode | undefined)?.value !== "next/headers") continue;
    for (const specifier of (statement.specifiers as AstNode[] | undefined) ?? []) {
      if (specifier.type !== "ImportSpecifier") continue;
      const imported = specifier.imported as AstNode | undefined;
      const local = specifier.local as AstNode | undefined;
      if (imported?.type !== "Identifier" || local?.type !== "Identifier") continue;
      if (DYNAMIC_APIS.has(String(imported.name))) locals.set(String(local.name), String(imported.name));
    }
  }
  return locals;
};

export const noUnawaitedNextDynamicApi = defineDiagnostic({
  id: "no-unawaited-next-dynamic-api",
  title: "Next.js cookies()/headers() used without await, so every property read is undefined",
  severity: "error",
  category: "Bugs",
  confidence: "high",
  requires: ["next"],
  tags: ["next", "async", "auth"],
  recommendation:
    "Await it: `const c = await cookies()`, or `(await cookies()).get(\"session\")`. Since Next 15 `cookies()`, `headers()` and `draftMode()` return Promises — Next 16 removed the synchronous-access shim — so reading a property off the un-awaited call yields `undefined`. `React.use(cookies())` is the other supported form. Watch for optional chaining (`c?.get?.(…)`) around one of these: it converts the TypeError into a check that silently always fails.",
  create: (ctx) => {
    let locals = new Map<string, string>();

    /** Is this call one of the dynamic APIs? Returns its canonical name. */
    const dynamicApiCall = (node: AstNode | null | undefined): string | null => {
      const call = unwrapChain(node);
      if (!call || call.type !== "CallExpression") return null;
      const callee = unwrapChain(call.callee as AstNode);
      if (callee?.type !== "Identifier") return null;
      const name = locals.get(String(callee.name));
      if (name === undefined) return null;
      // The identifier must still resolve to the import at this use site.
      const binding: Binding | null = ctx.scope.resolveIdentifier(callee);
      if (binding !== null && binding.kind !== "import") return null;
      return name;
    };

    const report = (node: AstNode, api: string): void => {
      ctx.report(
        node,
        `\`${api}()\` returns a **Promise** since Next 15, so every property read on the un-awaited call is \`undefined\` — measured on Next 16.3.2, \`typeof cookies().get\` is \`"undefined"\`, and the server logs "used \`${api}().get\`… must be unwrapped with \`await\` or \`React.use()\`". Next 16 removed the synchronous-access shim, so this no longer degrades with a warning. If the read is optional-chained the TypeError disappears and the check silently always fails instead.`,
      );
    };

    return {
      Program: (root) => {
        locals = dynamicApiLocals(root);
      },

      MemberExpression: (node) => {
        if (locals.size === 0 || node.computed) return;
        const api = dynamicApiCall(node.object as AstNode);
        if (api === null) return;
        // `.then`/`.catch`/`.finally` treat it as the Promise it is.
        const property = node.property as AstNode | undefined;
        if (property?.type === "Identifier" && PROMISE_METHODS.has(String(property.name))) return;
        report(node, api);
      },

      VariableDeclarator: (node) => {
        if (locals.size === 0) return;
        const api = dynamicApiCall(node.init as AstNode);
        if (api === null) return;

        const id = node.id as AstNode | undefined;
        // `const { get } = cookies()` — destructuring a Promise yields undefined.
        if (id?.type === "ObjectPattern" || id?.type === "ArrayPattern") {
          report(node, api);
          return;
        }
        if (id?.type !== "Identifier") return;

        // A bare `const c = cookies()` is only wrong once something reads a
        // property off `c`. Passing the Promise onward is legitimate.
        const binding = ctx.scope.resolveIdentifier(id);
        if (!binding) return;
        const readsProperty = collectDescendants(ctx.program, (n) => {
          if (n.type !== "MemberExpression" || n.computed) return false;
          const object = n.object as AstNode | undefined;
          if (object?.type !== "Identifier" || String(object.name) !== String(id.name)) return false;
          if (ctx.scope.resolveIdentifier(object) !== binding) return false;
          const property = n.property as AstNode | undefined;
          return !(property?.type === "Identifier" && PROMISE_METHODS.has(String(property.name)));
        }).length > 0;
        if (readsProperty) report(node, api);
      },
    };
  },
});
