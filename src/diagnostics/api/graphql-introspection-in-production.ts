import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode, Visitors } from "../../core/types.ts";
import { getMethodName, getObjectProperty, isLiteralTrue } from "../../core/ast.ts";
import { classifyFileContext } from "../../core/file-context.ts";
import { isUnderEnvGuard } from "./context.ts";

/**
 * A GraphQL server constructed with introspection hardcoded on.
 *
 * Introspection hands an attacker the complete schema — every type, field,
 * argument and mutation, including the internal ones your UI never calls. It is
 * the first step of every GraphQL attack: dump the schema, then look for the
 * mutation nobody remembered to protect. Apollo disables it automatically when
 * `NODE_ENV === "production"`; writing `introspection: true` turns that
 * protection off in every environment at once.
 *
 * Only a hardcoded `true` fires. `introspection: process.env.NODE_ENV !==
 * "production"` is the correct pattern and by far the most common one, so any
 * non-literal value is left alone.
 *
 * ❌ new ApolloServer({ typeDefs, resolvers, introspection: true });
 * ✅ new ApolloServer({ typeDefs, resolvers, introspection: process.env.NODE_ENV !== "production" });
 * ✅ new ApolloServer({ typeDefs, resolvers, introspection: isDev });
 */

/** `new <X>(...)` server constructors that take an `introspection` option. */
const SERVER_CONSTRUCTORS = new Set(["ApolloServer", "ApolloServerBase", "GraphQLServer"]);

/**
 * Factory calls that take the same option. Deliberately not `createServer` —
 * that name belongs to `node:http` far more often than to a GraphQL library,
 * and a shared name is not evidence.
 */
const SERVER_FACTORIES = new Set(["createYoga", "createGraphQLServer"]);

/** The options object of a recognized GraphQL server construction, or null. */
const serverOptions = (node: AstNode): AstNode | null => {
  const name = getMethodName(node);
  if (!name) return null;
  const recognized =
    node.type === "NewExpression" ? SERVER_CONSTRUCTORS.has(name) : SERVER_FACTORIES.has(name);
  if (!recognized) return null;
  const first = ((node.arguments as AstNode[] | undefined) ?? [])[0];
  return first && first.type === "ObjectExpression" ? first : null;
};

export const graphqlIntrospectionInProduction = defineDiagnostic({
  id: "graphql-introspection-in-production",
  title: "GraphQL introspection hardcoded on",
  severity: "error",
  category: "Security",
  confidence: "high",
  tags: ["graphql", "info-leak"],
  recommendation:
    "Tie introspection to the environment instead of hardcoding it: `introspection: process.env.NODE_ENV !== \"production\"`. On Yoga, add the `useDisableIntrospection` plugin (and `blockFieldSuggestions`) for production builds.",
  create: (ctx): Visitors => {
    // A dev-only server spun up by a test fixture is not a production exposure.
    if (classifyFileContext(ctx.normalizedFilePath, ctx.sourceText) === "test") return {};

    const check = (node: AstNode): void => {
      const options = serverOptions(node);
      if (!options) return;
      const property = getObjectProperty(options, "introspection");
      // Anything that is not the literal `true` — an env check, a flag, a call —
      // is the correct shape or unknowable. Either way: say nothing.
      if (!property || !isLiteralTrue(property.value as AstNode)) return;
      // `if (isDev) { server = new ApolloServer({ introspection: true }); }` —
      // the literal is real, but the branch it lives in is not production.
      if (isUnderEnvGuard(property)) return;

      ctx.report(
        property,
        "GraphQL introspection is hardcoded on — this publishes the entire schema (every type, field, and mutation) to anyone who can reach the endpoint.",
      );
    };

    return { NewExpression: check, CallExpression: check };
  },
});
