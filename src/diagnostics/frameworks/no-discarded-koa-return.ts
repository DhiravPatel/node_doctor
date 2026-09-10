import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { isFunctionLike } from "../../core/ast.ts";
import { collectDescendants, findDescendant } from "../../core/walk.ts";

/**
 * A Koa middleware that RETURNS its response instead of assigning `ctx.body`.
 * Koa discards the return value of every middleware, so the request falls
 * through the stack and answers **404 Not Found**.
 *
 *   ❌ router.get("/users", async () => ({ ok: true }));      // 404
 *   ❌ app.use(async (ctx) => { const rows = await db.all(); return rows; });
 *   ✅ router.get("/users", async (ctx) => { ctx.body = { ok: true }; });
 *   ✅ router.get("/users", async (ctx) => (ctx.body = { ok: true }));   // 200
 *
 * MEASURED against Koa 3.2.1 with @koa/router, each case a real server fetched
 * over HTTP:
 *
 *   app.use    return { ok: true }                  → 404 "Not Found"
 *   app.use    return "hello"                       → 404 "Not Found"
 *   app.use    ctx.set(…) then return { ok: 1 }     → 404 "Not Found"
 *   app.use    const rows = await db(); return rows → 404 "Not Found"
 *   router.get return { ok: 1 }                     → 404 "Not Found"
 *   router.get ctx.body = { ok: 1 }                 → 200 {"ok":1}          OK
 *   router.get return (ctx.body = { ok: 1 })        → 200 {"ok":1}          OK
 *   app.use    delegate to helper(ctx)              → 200 {"via":"helper"}  OK
 *
 * This is the Express refugee's first Koa bug, and it is expensive out of all
 * proportion to how silly it looks: the symptom is a 404, so the search starts
 * at the ROUTER — path spelling, mount order, a missing `app.use(router.routes())`
 * — and the handler that is plainly being reached looks obviously fine. Nothing
 * warns, nothing throws, and the middleware really did run.
 *
 * PRECISION MODEL. The anchor is the REGISTRATION SITE, not the signature. Koa's
 * `(ctx, next)` is a shape ordinary helpers have too, and the engine's own Koa
 * recognition needs the body to touch a distinctive context member — which is
 * exactly what this defect's body does NOT do. So the rule instead requires the
 * function to be passed to a call on a binding it can prove is Koa:
 *
 *   - `const app = new Koa()` where `Koa` came from `koa`, then `app.use(fn)`.
 *   - `const router = new Router()` where `Router` came from `@koa/router` or
 *     `koa-router`, then `router.get(…, fn)` and its siblings.
 *
 * Both `import` and `require` spellings are read; an app built by a factory the
 * rule cannot see is never reported.
 *
 * Then, because ANY path to the response silences it, the middleware must
 * provably not have one — every one of these is measured or definitional:
 *
 *   - It never assigns `ctx.body`, `ctx.response.body` or `ctx.res`, and never
 *     sets `ctx.respond = false` (which hands the socket to the caller).
 *   - It never calls `ctx.throw`, `ctx.redirect`, `ctx.render`, `ctx.attachment`
 *     or `ctx.back` — each of which answers the request by itself.
 *   - `ctx` never ESCAPES: it appears only as the object of a member read.
 *     `app.use((ctx) => helper(ctx))` is measured to answer 200, because the
 *     helper sets the body, and `const c = ctx` puts the context somewhere the
 *     rule no longer follows. A read off it is not an escape — `db.find(ctx.params.id)`
 *     hands over a string, which cannot answer the request, and that shape is
 *     the commonest real instance of this defect.
 *   - It never mentions `next`. A middleware that calls `next()` is upstream of
 *     whatever answers, so its own return value is discarded harmlessly — and
 *     this also makes the idiomatic `return next()` silent by construction.
 *
 * Finally the returned expression must be a plain VALUE: an object, array or
 * template literal, a non-empty primitive literal, or a local binding with an
 * initializer. Once `ctx` is known not to escape, a local's initializer cannot be
 * the response either — `const user = await db.find(ctx.params.id)` received a
 * string, not the context, so `return user` still 404s, and that is the
 * commonest real instance of this defect. A returned call, member read or
 * parameter is left alone, since it could be the assignment expression
 * `return (ctx.body = x)` — measured to answer 200 — or anything else the rule
 * cannot see through.
 */

/** Router methods that take handlers. `@koa/router` also accepts a leading route name. */
const ROUTER_METHODS = new Set([
  "get", "post", "put", "patch", "delete", "del", "head", "options", "all", "use",
]);

/** Context calls that answer the request by themselves. */
const RESPONDING_CALLS = new Set(["throw", "redirect", "render", "attachment", "back"]);

/** Members whose assignment writes the response. */
const RESPONSE_TARGETS = new Set(["body", "res", "respond"]);

/** local name → module specifier, for `import X from "m"` and `const X = require("m")`. */
const moduleBindings = (program: AstNode): Map<string, string> => {
  const bindings = new Map<string, string>();
  for (const statement of ((program.body as AstNode[] | undefined) ?? [])) {
    if (statement.type === "ImportDeclaration") {
      const source = (statement.source as AstNode | undefined)?.value;
      if (typeof source !== "string") continue;
      for (const specifier of ((statement.specifiers as AstNode[] | undefined) ?? [])) {
        if (specifier.type !== "ImportDefaultSpecifier" && specifier.type !== "ImportSpecifier") continue;
        const local = specifier.local as AstNode | undefined;
        if (local?.type === "Identifier") bindings.set(String(local.name), source);
      }
      continue;
    }
    if (statement.type !== "VariableDeclaration") continue;
    for (const declarator of ((statement.declarations as AstNode[] | undefined) ?? [])) {
      const id = declarator.id as AstNode | undefined;
      const init = declarator.init as AstNode | undefined;
      if (id?.type !== "Identifier" || init?.type !== "CallExpression") continue;
      const callee = init.callee as AstNode | undefined;
      if (callee?.type !== "Identifier" || String(callee.name) !== "require") continue;
      const source = ((init.arguments as AstNode[] | undefined) ?? [])[0];
      if (source?.type === "Literal" && typeof source.value === "string") {
        bindings.set(String(id.name), String(source.value));
      }
    }
  }
  return bindings;
};

/** Bindings holding `new <ctor>()` where `<ctor>` came from a matching module. */
const constructedFrom = (program: AstNode, modules: RegExp): Set<string> => {
  const imported = moduleBindings(program);
  const built = new Set<string>();
  for (const declarator of collectDescendants(program, (n) => n.type === "VariableDeclarator")) {
    const id = declarator.id as AstNode | undefined;
    const init = declarator.init as AstNode | undefined;
    if (id?.type !== "Identifier" || init?.type !== "NewExpression") continue;
    const callee = init.callee as AstNode | undefined;
    if (callee?.type !== "Identifier") continue;
    const source = imported.get(String(callee.name));
    if (source !== undefined && modules.test(source)) built.add(String(id.name));
  }
  return built;
};

/** The function an argument denotes, following a same-file binding by name. */
const asFunction = (node: AstNode | null | undefined, program: AstNode): AstNode | null => {
  if (!node) return null;
  if (isFunctionLike(node)) return node;
  if (node.type !== "Identifier") return null;
  const name = String(node.name);
  const found = findDescendant(program, (n) => {
    if (n.type === "FunctionDeclaration") {
      const id = n.id as AstNode | undefined;
      return id?.type === "Identifier" && String(id.name) === name;
    }
    if (n.type === "VariableDeclarator") {
      const id = n.id as AstNode | undefined;
      return id?.type === "Identifier" && String(id.name) === name && isFunctionLike(n.init as AstNode);
    }
    return false;
  });
  if (!found) return null;
  return found.type === "FunctionDeclaration" ? found : ((found.init as AstNode) ?? null);
};

/** The parameter's bound name, or null for a pattern we cannot follow. */
const paramName = (param: AstNode | undefined): string | null =>
  param?.type === "Identifier" ? String(param.name) : null;

/** Does anything in this function reach the response, or let `ctx` escape to something that could? */
const mayRespond = (fn: AstNode, ctxName: string, nextName: string | null): boolean => {
  // The BODY only — the parameter list is where these names are declared.
  const body = fn.body as AstNode | undefined;
  if (!body) return true;
  return findDescendant(body, (n) => {
    if (n.type !== "Identifier") return false;
    const name = String(n.name);
    if (name !== ctxName && name !== nextName) return false;

    const parent = n.parent as AstNode | undefined;
    // A property NAME that happens to match is not a reference to the binding.
    if (parent?.type === "MemberExpression" && parent.property === n && !parent.computed) return false;
    if (parent?.type === "Property" && parent.key === n && !parent.computed) return false;

    // Any mention of `next` means this middleware is upstream of whatever answers.
    if (name === nextName) return true;

    // `ctx` used as anything OTHER than the object of a member read has escaped:
    // `helper(ctx)` is measured to answer 200, and `const c = ctx` puts the
    // context somewhere this rule no longer follows. A read off it —
    // `db.find(ctx.params.id)` — hands over a value, not the context.
    if (!(parent?.type === "MemberExpression" && parent.object === n)) return true;

    const property = parent.property as AstNode | undefined;
    if (parent.computed || property?.type !== "Identifier") return true;
    const member = String(property.name);
    // `ctx.body = …`, `ctx.res = …`, `ctx.respond = false`, `ctx.throw(…)`.
    if (RESPONSE_TARGETS.has(member) || RESPONDING_CALLS.has(member)) return true;
    // `ctx.response.body = …`
    if (member === "response") {
      const outer = parent.parent as AstNode | undefined;
      if (outer?.type === "MemberExpression" && outer.object === parent && !outer.computed) {
        const inner = outer.property as AstNode | undefined;
        if (inner?.type === "Identifier" && RESPONSE_TARGETS.has(String(inner.name))) return true;
      }
    }
    return false;
  }) !== null;
};

/**
 * Is this returned expression provably a plain VALUE rather than something the
 * rule cannot see through? Only reached once `mayRespond` has established that
 * `ctx` never escapes and the response is never written, so a local binding's
 * initializer cannot be the response either — `const user = await db.find(ctx.params.id)`
 * received a string, not the context.
 */
const isDiscardedValue = (node: AstNode | null | undefined, fn: AstNode): boolean => {
  if (!node) return false;
  if (node.type === "ObjectExpression" || node.type === "ArrayExpression" || node.type === "TemplateLiteral") {
    return true;
  }
  if (node.type === "Literal") return node.value !== null && node.value !== undefined;
  if (node.type !== "Identifier") return false;
  const name = String(node.name);
  const declarator = findDescendant(fn, (n) => {
    if (n.type !== "VariableDeclarator") return false;
    const id = n.id as AstNode | undefined;
    return id?.type === "Identifier" && String(id.name) === name;
  });
  return (declarator?.init as AstNode | undefined) !== undefined;
};

/** The expressions this function returns, not crossing nested functions. */
const returnedValues = (fn: AstNode): AstNode[] => {
  const body = fn.body as AstNode | undefined;
  if (!body) return [];
  if (body.type !== "BlockStatement") return [body];
  const out: AstNode[] = [];
  for (const statement of collectDescendants(body, (n) => n.type === "ReturnStatement", isFunctionLike)) {
    const argument = statement.argument as AstNode | undefined;
    if (argument) out.push(argument);
  }
  return out;
};

export const noDiscardedKoaReturn = defineDiagnostic({
  id: "no-discarded-koa-return",
  title: "Koa middleware returns its response instead of assigning ctx.body, so the request 404s",
  severity: "error",
  category: "Bugs",
  confidence: "high",
  requires: ["koa"],
  tags: ["koa", "http", "correctness"],
  recommendation:
    'Assign the response: `ctx.body = result`. Koa discards every middleware\'s return value, so returning the payload leaves `ctx.body` unset and the request falls through the stack — measured on Koa 3.2.1, `router.get("/users", async () => ({ ok: true }))` answers **404 Not Found**. The symptom points at the router, which is why this one is expensive to find. `return (ctx.body = result)` also works, since the assignment happens first.',
  create: (ctx) => ({
    Program: (root) => {
      const apps = constructedFrom(root, /^koa$/);
      const routers = constructedFrom(root, /^@koa\/router$|^koa-router$/);
      if (apps.size === 0 && routers.size === 0) return;

      for (const call of collectDescendants(root, (n) => n.type === "CallExpression")) {
        const callee = call.callee as AstNode | undefined;
        if (callee?.type !== "MemberExpression" || callee.computed) continue;
        const object = callee.object as AstNode | undefined;
        const property = callee.property as AstNode | undefined;
        if (object?.type !== "Identifier" || property?.type !== "Identifier") continue;

        const receiver = String(object.name);
        const method = String(property.name);
        const isApp = apps.has(receiver) && method === "use";
        const isRouter = routers.has(receiver) && ROUTER_METHODS.has(method);
        if (!isApp && !isRouter) continue;

        for (const argument of ((call.arguments as AstNode[] | undefined) ?? [])) {
          const fn = asFunction(argument, root);
          if (!fn) continue;

          const params = (fn.params as AstNode[] | undefined) ?? [];
          const ctxName = paramName(params[0]);
          // A destructured context is a pattern the rule cannot follow.
          if (params.length > 0 && ctxName === null) continue;
          const contextName = ctxName ?? " ";
          if (mayRespond(fn, contextName, paramName(params[1]))) continue;

          for (const value of returnedValues(fn)) {
            if (!isDiscardedValue(value, fn)) continue;
            ctx.report(
              value,
              `Koa **discards** a middleware's return value, so this never becomes the response — \`ctx.body\` is never assigned and the request falls through to a **404 Not Found**. Measured on Koa 3.2.1: \`${isRouter ? "router" : "app"}.${method}\` with a handler returning an object answers 404 with the body \`"Not Found"\`, while assigning \`ctx.body\` answers 200. Nothing warns, and because the symptom is a 404 the search starts at the router rather than here. Write \`${ctxName ?? "ctx"}.body = …\` instead.`,
            );
          }
        }
      }
    },
  }),
});
