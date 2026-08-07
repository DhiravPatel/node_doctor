import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, isFunctionLike, getCalleeName, getStaticStringValue } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";

/**
 * §164 — the one handler among its peers that does not do what the rest do.
 *
 * THE IDEA. The most powerful absence signal in the catalog: nineteen route
 * handlers on a router wrap their body in `asyncHandler`, and the twentieth is
 * bare. No fixed ruleset anticipates that, because the rule is local to this
 * codebase — but the codebase states it nineteen times. The project becomes its
 * own ruleset, with no configuration.
 *
 *   ❌ router.get("/users",  asyncHandler(async (req, res) => { … }));
 *      router.get("/orders", asyncHandler(async (req, res) => { … }));
 *      …17 more…
 *      router.get("/audit",  async (req, res) => { … });   // ← this one
 *
 * An unwrapped async handler that rejects does not reach the error middleware:
 * on Express 4 the request hangs until the client times out.
 *
 * PRECISION MODEL. This is a STATISTICAL claim, and every statistical claim in
 * this project's history is where its false positives came from. So it is fenced
 * far harder than a syntactic rule, and it is opt-in and advisory:
 *
 *   - THE RECEIVER MUST BE A PROVEN EXPRESS ROUTER, bound from `Router()` or
 *     `express()` in this file. Without that the rule fired on Koa, on Fastify,
 *     and on anything with a `.get(path, fn)` shape at all — an HTTP client, a
 *     cache — while asserting Express semantics false for every one of them.
 *   - THE GROUP IS KEYED ON THE RESOLVED BINDING, never the name. `router` is
 *     the most common identifier in Express code, and grouping by name merged
 *     every `const router = Router()` in a multi-factory route file into one
 *     population — which also defeated the size floor, since the population
 *     existed only because of the collision. A member path (`api.v1.get(…)`) is
 *     excluded for the same reason: two provably different routers reduce to
 *     one root name.
 *   - THE GROUP MUST BE BIG ENOUGH TO MEAN ANYTHING. Minimum 10, because at 90%
 *     conformity a smaller group can never produce a deviant at all.
 *   - CONFORMITY MUST BE OVERWHELMING. 90%, so a 3-vs-2 split — which is a
 *     codebase mid-migration, not a mistake — says nothing.
 *   - THE FACT MUST BE A SINGLE NAMEABLE SYNTACTIC THING: "the handler is the
 *     argument of a call to `X`". Never a vector of soft features, never a
 *     similarity score.
 *   - THE OUTLIER MUST BE PROVABLY UNWRAPPED, AND PROVABLY ASYNC. This is the
 *     gate that matters most. A handler passed as a bare identifier
 *     (`router.get("/x", listUsers)`) may well be wrapped where it is defined,
 *     so it is excluded from the group ENTIRELY — neither conforming nor
 *     deviant — rather than counted as a violation. A SYNCHRONOUS inline
 *     handler is excluded for the same reason from the other direction: it
 *     cannot reject, so it needs no wrapper, and `/ping` among twenty API
 *     routes is a legitimate outlier rather than a mistake. So is a handler
 *     whose whole body is a `try`/`catch` — the webhook receiver that must
 *     always answer 200 — because it provably cannot reject either. Only an
 *     inline `async` function that visibly is not wrapped and visibly can
 *     reject can be the outlier.
 *   - THE WRAPPER MUST BE A WRAPPER: a named call taking EXACTLY ONE argument
 *     that is a function. `makeHandler(db, path)` is a handler FACTORY, a
 *     perfectly good convention that produces the handler rather than wrapping
 *     one, and reading it as an error wrapper turned every factory-style router
 *     into a wall of findings.
 *
 * DELIBERATELY NOT DONE: the same reasoning applied to a missing MIDDLEWARE
 * (`requireAuth` on 19 of 20 routes). That version has legitimate outliers by
 * design — the login route, the health probe, the webhook receiver — and
 * "everyone else authenticates" is exactly the wrong thing to say about the
 * login endpoint. A wrapper has no such exception: if nineteen handlers need
 * their rejections routed, so does the twentieth.
 */

/** Module specifiers that provide an Express router. */
const EXPRESS_SOURCES = new Set(["express"]);

/** Route registration verbs. `all`/`use` take no path and are excluded. */
const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "del", "head", "options"]);

/**
 * A group needs this many peers before one outlier means anything.
 *
 * 10, not 5: at 90% conformity a group of 5 could never produce a deviant
 * anyway (4/5 is 80%), so a stated minimum of 5 was arithmetic that could not
 * happen. The real floor is the one the conformity threshold implies.
 */
const MIN_GROUP = 10;
/** …and this share of them must agree. */
const MIN_CONFORMITY = 0.9;

interface Registration {
  /** The call node, for reporting. */
  call: AstNode;
  /** The handler node, for the self-handling check. */
  handler: AstNode | null;
  /** The route path, for the message. */
  path: string | null;
  /**
   * The wrapper the handler is passed to (`asyncHandler`), or null when the
   * handler is an inline function passed directly.
   */
  wrapper: string | null;
}

/**
 * The handler argument of a route registration: the LAST argument, since
 * everything before it is middleware.
 */
const handlerArgument = (call: AstNode): AstNode | null => {
  const args = (call.arguments as AstNode[] | undefined) ?? [];
  if (args.length < 2) return null;
  return args[args.length - 1] ?? null;
};

/**
 * Classify a handler argument.
 *
 * `"opaque"` means the argument tells us nothing about wrapping — a bare
 * identifier that may be wrapped at its definition, a member expression, a
 * spread. Those are excluded from the population entirely, because counting
 * them either way would be a guess.
 */
const classify = (argument: AstNode | null): { kind: "inline" | "wrapped" | "opaque"; wrapper?: string } => {
  if (!argument) return { kind: "opaque" };
  if (isFunctionLike(argument)) {
    // A SYNCHRONOUS handler cannot reject, so it needs no async wrapper and is
    // not an outlier — it is a `/ping` among API routes, and telling someone to
    // wrap it is advice that buys nothing. It is excluded from the population
    // entirely rather than counted as conforming, because it is evidence for
    // neither side.
    return argument.async === true ? { kind: "inline" } : { kind: "opaque" };
  }
  if (argument.type === "CallExpression") {
    const callee = argument.callee as AstNode | undefined;
    // Only a plainly-named wrapper counts. `wrappers.async(fn)` is a member
    // path, and two files could disagree about what it resolves to.
    if (callee?.type !== "Identifier") return { kind: "opaque" };
    const args = (argument.arguments as AstNode[] | undefined) ?? [];
    // EXACTLY one argument, and it must be a function. `makeHandler(db, path)`
    // is a handler FACTORY — a perfectly good convention that produces the
    // handler rather than wrapping one — and reading it as an error wrapper
    // turned every factory-style router into a wall of findings. A decorator
    // that takes options (`cache(60)(fn)`) fails the same test.
    if (args.length !== 1 || !isFunctionLike(args[0]!)) return { kind: "opaque" };
    return { kind: "wrapped", wrapper: callee.name as string };
  }
  return { kind: "opaque" };
};

/**
 * Does this handler provably deal with its own rejections?
 *
 * A body that is exactly one `try` with a `catch` cannot reject: whatever the
 * body throws, the catch receives. A webhook receiver that must always answer
 * 200, or a handler that calls `next(err)` itself, is a legitimate outlier and
 * the rejection claim would be false for it.
 */
const handlesOwnErrors = (fn: AstNode): boolean => {
  const body = fn.body as AstNode | undefined;
  if (body?.type !== "BlockStatement") return false;
  const statements = (body.body as AstNode[] | undefined) ?? [];
  if (statements.length !== 1) return false;
  const only = statements[0]!;
  return only.type === "TryStatement" && only.handler !== null && only.handler !== undefined;
};

export const noPeerInconsistentHandler = defineDiagnostic({
  id: "no-peer-inconsistent-handler",
  title: "Route handler skips the wrapper its peers all use",
  severity: "warn",
  category: "Reliability",
  // A statistical claim, and labelled as one: this is strong evidence, not proof.
  confidence: "medium",
  tags: ["reliability", "express", "error-handling"],
  defaultEnabled: false,
  recommendation:
    "Wrap this handler the way its siblings are wrapped, or — if it genuinely should differ — say so with an inline suppression and a reason. Every other route on this router routes its rejections through the wrapper; an unwrapped async handler that rejects never reaches the error middleware, and on Express 4 the request hangs until the client gives up.",
  create: (ctx) => ({
    "Program:exit": () => {
      /**
       * Local names bound to an Express router or app. Without this the rule
       * fired on Koa, on Fastify, and on any object with a `.get(path, fn)`
       * shape at all — an HTTP client, a cache, a config store — while
       * asserting Express semantics that are false for every one of them.
       */
      const routerBindings = new Set<AstNode>();
      let importsExpress = false;
      for (const stmt of (ctx.program.body as AstNode[] | undefined) ?? []) {
        if (stmt.type !== "ImportDeclaration") continue;
        const source = stmt.source?.value;
        if (typeof source === "string" && EXPRESS_SOURCES.has(source)) importsExpress = true;
      }
      for (const decl of collectDescendants(
        ctx.program,
        (n) => n.type === "VariableDeclarator",
        undefined,
        true,
      )) {
        const id = decl.id as AstNode | undefined;
        if (id?.type !== "Identifier") continue;
        const init = decl.init as AstNode | undefined;
        if (init?.type !== "CallExpression" && init?.type !== "NewExpression") continue;
        const callee = getCalleeName(init);
        // `express.Router()`, `Router()` from express, `express()`.
        const isRouterFactory =
          callee === "express.Router" ||
          callee === "express" ||
          (callee === "Router" && importsExpress) ||
          (callee === "express.Router" && importsExpress);
        if (!isRouterFactory) continue;
        if (!importsExpress && callee !== "express.Router" && callee !== "express") continue;
        const binding = ctx.scope.getBinding(id.name as string, id);
        if (binding) routerBindings.add(binding.declNode);
      }
      if (routerBindings.size === 0) return;

      /**
       * declaration node → its registrations.
       *
       * Keyed on the resolved BINDING, never the name. `router` is the single
       * most common identifier in Express code, and grouping by name merged
       * every `const router = Router()` in a multi-factory route file into one
       * fabricated population — which also defeated the minimum-group floor,
       * since the population existed only because of the name collision.
       */
      const groups = new Map<AstNode, Registration[]>();

      for (const call of collectDescendants(
        ctx.program,
        (n) => n.type === "CallExpression",
        undefined,
        true,
      )) {
        const method = getMethodName(call);
        if (!method || !ROUTE_METHODS.has(method)) continue;

        // The receiver must be a PLAIN IDENTIFIER. `routers.public.get(…)`,
        // `routers[0].get(…)` and `makeRouter("a").get(…)` all reduce to one
        // root name, which merged provably-different routers into one group.
        const callee = call.callee as AstNode | undefined;
        if (callee?.type !== "MemberExpression") continue;
        const receiver = callee.object as AstNode | undefined;
        if (receiver?.type !== "Identifier") continue;

        const binding = ctx.scope.getBinding(receiver.name as string, receiver);
        if (!binding || !routerBindings.has(binding.declNode)) continue;

        const args = (call.arguments as AstNode[] | undefined) ?? [];
        // A route registration names its path as a static first argument.
        const path = getStaticStringValue(args[0]);
        if (path === null) continue;

        const handler = handlerArgument(call);
        const verdict = classify(handler);
        // Opaque handlers are excluded from the population entirely: a bare
        // identifier may be wrapped at its definition, and counting it either
        // way would be the guess this rule exists to avoid.
        if (verdict.kind === "opaque") continue;

        const list = groups.get(binding.declNode) ?? [];
        list.push({ call, handler, path, wrapper: verdict.wrapper ?? null });
        groups.set(binding.declNode, list);
      }

      // Deterministic order: by first registration offset.
      const ordered = [...groups.values()].sort(
        (a, b) => ((a[0]?.call.start as number) ?? 0) - ((b[0]?.call.start as number) ?? 0),
      );

      for (const registrations of ordered) {
        if (registrations.length < MIN_GROUP) continue;

        const counts = new Map<string, number>();
        for (const r of registrations) {
          if (r.wrapper !== null) counts.set(r.wrapper, (counts.get(r.wrapper) ?? 0) + 1);
        }
        // Two competing wrappers is a migration, not a mistake.
        if (counts.size !== 1) continue;
        const [wrapper, conforming] = [...counts][0]!;
        if (conforming / registrations.length < MIN_CONFORMITY) continue;

        for (const d of registrations) {
          if (d.wrapper !== null) continue;
          // A handler that catches everything it can throw cannot reject, so
          // the claim would be false for it.
          if (d.handler && handlesOwnErrors(d.handler)) continue;
          ctx.report(
            d.call,
            `${conforming} of ${registrations.length} routes on this router wrap their handler in \`${wrapper}\`; \`${d.path}\` does not. An unwrapped async handler that rejects does not reach the error middleware on Express 4, so the request hangs until the client times out.`,
          );
        }
      }
    },
  }),
});
