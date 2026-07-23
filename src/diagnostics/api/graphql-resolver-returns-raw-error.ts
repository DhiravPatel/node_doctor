import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode, Visitors } from "../../core/types.ts";
import { findAncestor, getCalleeName, isFunctionLike } from "../../core/ast.ts";
import { collectDescendants, findDescendant } from "../../core/walk.ts";

/**
 * A GraphQL resolver that puts a caught error's stack trace into the response.
 *
 * GraphQL serializes whatever the resolver returns or throws, so a stack trace
 * placed there is not a server log — it is an API field. It hands the caller
 * absolute filesystem paths, dependency versions, ORM internals and the exact
 * line that failed, which is precisely the map an attacker needs. Apollo strips
 * `stacktrace` from formatted errors only when `NODE_ENV === "production"`, and
 * never from a value you put in the payload yourself.
 *
 * Only an explicit `err.stack` fires. A bare `throw err` is left alone: it is the
 * normal way to propagate, and the server's error formatter — not this line —
 * decides what the client sees.
 *
 * ❌ } catch (err) { throw new GraphQLError(err.message, { extensions: { stacktrace: err.stack } }); }
 * ❌ } catch (err) { return { ok: false, detail: err.stack }; }
 * ✅ } catch (err) { logger.error(err); throw new GraphQLError("Could not load user"); }
 * ✅ } catch (err) { throw new Error(err.message); }
 */

/** Object keys whose nested functions are GraphQL resolvers by construction. */
const ROOT_TYPE_KEYS = new Set(["Query", "Mutation", "Subscription"]);

/** NestJS method decorators that declare a GraphQL resolver. */
const NEST_RESOLVER_DECORATORS = new Set([
  "Mutation",
  "Query",
  "ResolveField",
  "ResolveProperty",
  "ResolveReference",
  "Subscription",
]);

/** `resolvers`, `userResolvers`, `Resolvers` — the conventional map name. */
const RESOLVER_NAME_RE = /resolvers$/i;

/** The property key or declarator name a node is bound to, if statically known. */
const boundName = (node: AstNode): string | null => {
  if (node.type === "VariableDeclarator" && node.id?.type === "Identifier") return node.id.name;
  if (node.type === "Property" && !node.computed) {
    const key = node.key as AstNode | undefined;
    if (key?.type === "Identifier") return key.name;
    if (key?.type === "Literal" && typeof key.value === "string") return key.value;
  }
  if (node.type === "PropertyDefinition" && !node.computed && node.key?.type === "Identifier") {
    return node.key.name;
  }
  return null;
};

/** Does this class-method / property carry a NestJS GraphQL resolver decorator? */
const hasResolverDecorator = (node: AstNode | null | undefined): boolean => {
  const decorators = node?.decorators as AstNode[] | undefined;
  if (!Array.isArray(decorators)) return false;
  return decorators.some((d) => {
    const name = getCalleeName(d.expression as AstNode) ?? getCalleeName(d as AstNode);
    return !!name && NEST_RESOLVER_DECORATORS.has(name.split(".").pop()!);
  });
};

/**
 * Is `fn` a GraphQL resolver? Three independent, deliberately narrow signals:
 * the four-argument resolver signature ending in `info`, membership in an object
 * keyed by `Query`/`Mutation`/`Subscription` or named `…resolvers`, or a NestJS
 * resolver decorator. Anything else is treated as ordinary code.
 */
const isResolver = (fn: AstNode): boolean => {
  const params = (fn.params as AstNode[] | undefined) ?? [];
  const fourth = params[3];
  if (fourth?.type === "Identifier" && /^_*info$/i.test(fourth.name)) return true;

  if (hasResolverDecorator(fn.parent)) return true;

  // Walk out of the object literal(s) the function sits in.
  let current: AstNode | null | undefined = fn.parent;
  while (current) {
    if (isFunctionLike(current)) break; // a different function's scope — stop
    const name = boundName(current);
    if (name && (ROOT_TYPE_KEYS.has(name) || RESOLVER_NAME_RE.test(name))) return true;
    if (current.type === "AssignmentExpression" && current.left?.type === "Identifier") {
      if (RESOLVER_NAME_RE.test(current.left.name)) return true;
    }
    current = current.parent;
  }
  return false;
};

export const graphqlResolverReturnsRawError = defineDiagnostic({
  id: "graphql-resolver-returns-raw-error",
  title: "GraphQL resolver puts an error stack in the response",
  severity: "warn",
  category: "Security",
  confidence: "medium",
  tags: ["error-handling", "graphql", "info-leak"],
  recommendation:
    "Log the error server-side and surface a stable, generic message instead — `throw new GraphQLError(\"Could not load user\", { extensions: { code: \"INTERNAL_SERVER_ERROR\" } })`. Never place `err.stack` in a returned payload or an error extension: GraphQL serializes it straight to the caller.",
  create: (ctx): Visitors => ({
    CatchClause: (clause) => {
      const param = clause.param as AstNode | undefined;
      if (param?.type !== "Identifier") return;
      const errorName = param.name;

      // The catch may sit inside a nested helper arrow; the resolver is the
      // nearest enclosing function that looks like one.
      let host: AstNode | null = findAncestor(clause, isFunctionLike);
      while (host && !isResolver(host)) host = findAncestor(host, isFunctionLike);
      if (!host) return;

      const isErrorStack = (n: AstNode): boolean =>
        n.type === "MemberExpression" &&
        !n.computed &&
        n.property?.type === "Identifier" &&
        n.property.name === "stack" &&
        n.object?.type === "Identifier" &&
        n.object.name === errorName;

      const body = clause.body as AstNode | undefined;
      if (!body) return;
      // Returns/throws in a nested function belong to that function, not to the
      // resolver's response — do not descend into them.
      for (const statement of collectDescendants(
        body,
        (n) => n.type === "ReturnStatement" || n.type === "ThrowStatement",
        isFunctionLike,
      )) {
        const argument = statement.argument as AstNode | undefined;
        if (!argument) continue;
        const leak = isErrorStack(argument)
          ? argument
          : findDescendant(argument, isErrorStack, isFunctionLike);
        if (!leak) continue;
        ctx.report(
          leak,
          "This resolver sends a caught error's stack trace back through the GraphQL response — it leaks absolute paths, dependency versions, and the failing internals.",
        );
      }
    },
  }),
});
