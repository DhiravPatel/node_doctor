import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { declaresName, isFunctionLike } from "../../core/ast.ts";
import { collectDescendants, findDescendant } from "../../core/walk.ts";

/**
 * `params` or `searchParams` read without `await` in a Next.js App Router file.
 * Since Next 15 both are **Promises**, so every property read is `undefined` —
 * and unlike `cookies()`, this one does not even throw.
 *
 *   ❌ export async function GET(req, { params }) { const u = await db.find(params.id); }
 *   ❌ export default async function Page({ params, searchParams }) { … params.id … }
 *   ❌ export async function GET(req, { params: { id } }) { … }      // destructured Promise
 *   ✅ const { id } = await params;
 *   ✅ const params = use(props.params);                              // client components
 *
 * MEASURED against a running Next 16.3.4 server, every case a real route:
 *
 *   route.js  GET(req, { params })      params.id            → 200 {"id":"undefined"}
 *   route.js  GET(req, { params })      params?.id ?? "MISS" → 200 {"…":"MISS"}
 *   route.js  GET(req, { params: {id} }) id                  → 200 {"id":"undefined"}
 *   route.js  GET(req, ctx)             ctx.params.id        → 200 {"id":"undefined"}
 *   page.js   Page({ params, searchParams })  both reads     → 200 both "undefined"
 *   page.js   generateMetadata({ params })    params.id      → <title>user undefined</title>
 *   route.js  GET(req, { params })      await params         → 200 {"id":"abc"}   ✅
 *
 * `typeof params.then` is `"function"` in every failing case, confirming the
 * value really is the Promise. **The server log was empty** — no warning, no
 * error, not one line across all of them. That is what separates this from
 * `no-unawaited-next-dynamic-api`: `cookies().get(…)` throws a 500 and Next logs
 * a specific complaint, whereas this answers 200 with the field silently missing.
 * A handler that does `db.find(params.id)` looks up `undefined`, and
 * `params?.id ?? fallback` — the defensive spelling — quietly takes the fallback
 * forever.
 *
 * PRECISION MODEL. The anchor is the App Router file convention, which is the
 * only place these props exist, and it is checked before anything else:
 *
 *   - The path contains an `app/` segment and the basename is one of Next's
 *     reserved names — `page`, `layout`, `route`, `default`. A Pages Router file
 *     (`pages/[id].tsx`, whose `getServerSideProps({ params })` receives a plain
 *     OBJECT) can never match, and neither can an ordinary module.
 *   - In `route.*` the props are the SECOND parameter of an exported HTTP method
 *     (`GET`, `POST`, …). In `page`/`layout`/`default` they are the FIRST
 *     parameter of the default export or of an exported `generateMetadata`.
 *     `searchParams` is a page-only prop and is not looked for in `route.*`.
 *   - `searchParams` is claimed only for `page`, never for `layout` — a layout
 *     is not re-rendered on a query-string change and does not receive it.
 *
 * Gated on `next:15`, granted only when the manifest's `next` range has a
 * readable major of 15 or more. This matters: on Next 14 `params` is a plain
 * object and the synchronous spelling is CORRECT, so a version-blind rule would
 * report working code. A range with no readable major (`latest`, `canary`) grants
 * nothing and the rule stays silent.
 *
 * The consumption model is the one `no-unawaited-next-dynamic-api` already uses.
 * Wrong: a member read (`params.id`, `params[key]`), a destructure
 * (`const { id } = params`), and a spread (`{ ...params }`, which yields `{}`
 * because a Promise has no own enumerable properties). Correct and silent:
 * `await`, `use(params)` / `React.use(params)`, `.then` / `.catch` / `.finally`,
 * and passing it onward unread. A binding that is re-declared, re-assigned, or
 * shadowed by a nested function's own parameter is dropped entirely — the scope
 * resolver does not model nested blocks, so that is a whole-body name check
 * rather than a resolution.
 */

/** App Router basenames whose exports receive `params`. */
const PARAMS_FILES = new Set(["page", "layout", "route", "default"]);

/** The HTTP methods a `route.*` file exports. */
const ROUTE_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/** Exports of a `page`/`layout`/`default` file that receive the props object. */
const VIEW_EXPORTS = new Set(["generateMetadata"]);

/** Members that treat the value AS the Promise it is, which is correct. */
const PROMISE_METHODS = new Set(["then", "catch", "finally"]);

/** Which reserved App Router file this is, or null if it is not one. */
const appRouterFile = (normalizedPath: string): "route" | "page" | "view" | null => {
  const segments = normalizedPath.split("/");
  if (!segments.includes("app")) return null;
  const base = segments[segments.length - 1] ?? "";
  const dot = base.indexOf(".");
  if (dot <= 0) return null;
  const stem = base.slice(0, dot);
  const extension = base.slice(dot + 1);
  if (!/^(js|jsx|ts|tsx|mjs|cjs)$/.test(extension)) return null;
  if (!PARAMS_FILES.has(stem)) return null;
  return stem === "route" ? "route" : stem === "page" ? "page" : "view";
};

/** The function a declaration or an exported binding name ultimately refers to. */
const asFunction = (node: AstNode | null | undefined, program: AstNode): AstNode | null => {
  if (!node) return null;
  if (isFunctionLike(node)) return node;
  if (node.type === "Identifier") {
    const name = String(node.name);
    const declarator = findDescendant(program, (n) => {
      if (n.type !== "VariableDeclarator") return false;
      const id = n.id as AstNode | undefined;
      return id?.type === "Identifier" && String(id.name) === name && isFunctionLike(n.init as AstNode);
    });
    return declarator ? ((declarator.init as AstNode) ?? null) : null;
  }
  return null;
};

interface Entry {
  fn: AstNode;
  /** Index of the parameter carrying `params`. */
  index: number;
}

/** The exported functions of this file that Next hands the props object to. */
const entryFunctions = (program: AstNode, kind: "route" | "page" | "view"): Entry[] => {
  const entries: Entry[] = [];
  const index = kind === "route" ? 1 : 0;

  for (const statement of ((program.body as AstNode[] | undefined) ?? [])) {
    if (statement.type === "ExportDefaultDeclaration" && kind !== "route") {
      const fn = asFunction(statement.declaration as AstNode, program);
      if (fn) entries.push({ fn, index });
      continue;
    }
    if (statement.type !== "ExportNamedDeclaration") continue;
    const declaration = statement.declaration as AstNode | undefined;
    if (!declaration) continue;

    const wanted = kind === "route" ? ROUTE_METHODS : VIEW_EXPORTS;
    if (declaration.type === "FunctionDeclaration") {
      const id = declaration.id as AstNode | undefined;
      if (id?.type === "Identifier" && wanted.has(String(id.name))) entries.push({ fn: declaration, index });
      continue;
    }
    if (declaration.type !== "VariableDeclaration") continue;
    for (const declarator of ((declaration.declarations as AstNode[] | undefined) ?? [])) {
      const id = declarator.id as AstNode | undefined;
      if (id?.type !== "Identifier" || !wanted.has(String(id.name))) continue;
      const fn = asFunction(declarator.init as AstNode, program);
      if (fn) entries.push({ fn, index });
    }
  }
  return entries;
};

/** The static name of an object-pattern property, or null if it is not readable. */
const patternKey = (property: AstNode): string | null => {
  if (property.type !== "Property" || property.computed) return null;
  const key = property.key as AstNode | undefined;
  if (key?.type === "Identifier") return String(key.name);
  if (key?.type === "Literal" && typeof key.value === "string") return String(key.value);
  return null;
};

/**
 * Is the name re-declared, written to, or shadowed by a nested function's own
 * parameter anywhere in the body? The scope resolver does not model nested
 * blocks, so any of those takes the binding out.
 */
const isRebound = (body: AstNode, name: string): boolean => {
  if (declaresName(body, name)) return true;
  return (
    findDescendant(body, (n) => {
      if (n.type === "AssignmentExpression") {
        const left = n.left as AstNode | undefined;
        return left?.type === "Identifier" && String(left.name) === name;
      }
      if (isFunctionLike(n)) {
        return ((n.params as AstNode[] | undefined) ?? []).some((p) => {
          const id = p.type === "AssignmentPattern" ? (p.left as AstNode | undefined) : p;
          return id?.type === "Identifier" && String(id.name) === name;
        });
      }
      return false;
    }) !== null
  );
};

/** Is this node the argument of `use(…)` or `React.use(…)`? */
const isReactUseArgument = (node: AstNode, parent: AstNode): boolean => {
  if (parent.type !== "CallExpression") return false;
  if (!((parent.arguments as AstNode[] | undefined) ?? []).includes(node)) return false;
  const callee = parent.callee as AstNode | undefined;
  if (callee?.type === "Identifier") return String(callee.name) === "use";
  if (callee?.type === "MemberExpression" && !callee.computed) {
    const property = callee.property as AstNode | undefined;
    return property?.type === "Identifier" && String(property.name) === "use";
  }
  return false;
};

/**
 * Given a node that evaluates to the Promise, is it consumed synchronously?
 * Returns a description of the misuse, or null when the value is handled
 * correctly or merely passed onward.
 */
const misuse = (node: AstNode): string | null => {
  const parent = node.parent as AstNode | undefined;
  if (!parent) return null;

  if (parent.type === "AwaitExpression") return null;
  if (isReactUseArgument(node, parent)) return null;

  if (parent.type === "MemberExpression" && parent.object === node) {
    if (!parent.computed) {
      const property = parent.property as AstNode | undefined;
      if (property?.type === "Identifier" && PROMISE_METHODS.has(String(property.name))) return null;
      return `reading \`.${property?.type === "Identifier" ? String(property.name) : "…"}\` off it`;
    }
    return "indexing it";
  }

  if (parent.type === "VariableDeclarator" && parent.init === node) {
    const id = parent.id as AstNode | undefined;
    if (id?.type === "ObjectPattern" || id?.type === "ArrayPattern") return "destructuring it";
    return null; // `const p = params` — an alias, not yet a read
  }

  if (parent.type === "SpreadElement" || parent.type === "RestElement") return "spreading it";

  return null;
};

export const noUnawaitedNextRouteParams = defineDiagnostic({
  id: "no-unawaited-next-route-params",
  title: "Next.js params/searchParams read without await, so every field is undefined",
  severity: "error",
  category: "Bugs",
  confidence: "high",
  requires: ["next:15"],
  tags: ["next", "async", "http"],
  recommendation:
    "Await it: `const { id } = await params`, or `const { q } = await searchParams`. Since Next 15 both props are Promises — measured on Next 16.3.4, `params.id` in a route handler answers **200** with `\"undefined\"` and the server logs nothing at all. In a client component use `React.use(props.params)` instead. Watch for the defensive spelling `params?.id ?? fallback`: it takes the fallback forever without ever failing.",
  create: (ctx) => ({
    Program: (root) => {
      const kind = appRouterFile(ctx.normalizedFilePath);
      if (kind === null) return;
      // `searchParams` is a page-only prop; a layout is not re-rendered on a
      // query-string change and never receives it.
      const props = kind === "route" ? ["params"] : kind === "page" ? ["params", "searchParams"] : ["params"];

      for (const { fn, index } of entryFunctions(root, kind)) {
        const body = fn.body as AstNode | undefined;
        if (!body) continue;
        const parameter = ((fn.params as AstNode[] | undefined) ?? [])[index];
        if (!parameter) continue;

        const report = (node: AstNode, prop: string, how: string): void =>
          ctx.report(
            node,
            `\`${prop}\` is a **Promise** in the App Router since Next 15, and this is ${how} without \`await\`. Measured on Next 16.3.4 this answers **200** with the field \`"undefined"\` and the server logs nothing — so a lookup keyed on it silently searches for \`undefined\`, and \`${prop}?.x ?? fallback\` quietly takes the fallback forever. Write \`const { … } = await ${prop}\`, or \`React.use(${prop})\` in a client component.`,
          );

        // `GET(req, ctx)` — the props object is bound whole, so the Promise is
        // the `ctx.params` member read.
        if (parameter.type === "Identifier") {
          const name = String(parameter.name);
          if (isRebound(body, name)) continue;
          for (const member of collectDescendants(body, (n) => n.type === "MemberExpression" && !n.computed)) {
            const object = member.object as AstNode | undefined;
            const property = member.property as AstNode | undefined;
            if (object?.type !== "Identifier" || String(object.name) !== name) continue;
            if (property?.type !== "Identifier" || !props.includes(String(property.name))) continue;
            const how = misuse(member);
            if (how !== null) report(member, String(property.name), how);
          }
          continue;
        }

        if (parameter.type !== "ObjectPattern") continue;
        for (const property of ((parameter.properties as AstNode[] | undefined) ?? [])) {
          const key = patternKey(property);
          if (key === null || !props.includes(key)) continue;
          const value = property.value as AstNode | undefined;

          // `{ params: { id } }` — destructuring the Promise in the signature.
          if (value?.type === "ObjectPattern" || value?.type === "ArrayPattern") {
            report(value, key, "destructured in the signature");
            continue;
          }
          if (value?.type !== "Identifier") continue;

          const local = String(value.name);
          if (isRebound(body, local)) continue;
          for (const reference of collectDescendants(body, (n) => n.type === "Identifier" && String(n.name) === local)) {
            const parent = reference.parent as AstNode | undefined;
            // Property keys and member names are not references to the binding.
            if (parent?.type === "MemberExpression" && parent.property === reference && !parent.computed) continue;
            if (parent?.type === "Property" && parent.key === reference && !parent.computed) continue;
            const how = misuse(reference);
            if (how !== null) report(reference, key, how);
          }
        }
      }
    },
  }),
});
