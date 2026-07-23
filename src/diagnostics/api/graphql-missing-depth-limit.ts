import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode, Visitors } from "../../core/types.ts";
import { getMethodName } from "../../core/ast.ts";
import { classifyFileContext } from "../../core/file-context.ts";

/**
 * OPT-IN (defaultEnabled: false). A GraphQL server built with no query depth or
 * cost limiter anywhere in the file.
 *
 * GraphQL lets the client choose the shape of the query, so a cyclic schema is a
 * denial of service by construction: `{ user { friends { user { friends … } } } }`
 * nests to whatever depth the attacker types, and one request fans out to
 * millions of resolver calls. A depth or complexity limit is the only thing that
 * bounds it.
 *
 * Opt-in on purpose: absence of a plugin is weaker evidence than presence of a
 * bug. The limiter may be registered in another module, applied by a gateway, or
 * genuinely unnecessary on an internal endpoint — none of which this file-scoped
 * check can see. It fires only where the whole file offers no sign of a limit.
 *
 * ❌ new ApolloServer({ typeDefs, resolvers });
 * ✅ new ApolloServer({ typeDefs, resolvers, validationRules: [depthLimit(7)] });
 * ✅ createYoga({ schema, plugins: [maxDepthPlugin({ n: 7 })] });
 */

/** `new <X>(...)` GraphQL server constructors. */
const SERVER_CONSTRUCTORS = new Set(["ApolloServer", "ApolloServerBase", "GraphQLServer"]);

/** Factory calls that stand up a GraphQL server. */
const SERVER_FACTORIES = new Set(["createYoga", "createGraphQLServer", "mercurius"]);

/** Fastify's `app.register(mercurius, { schema, resolvers })` shape. */
const isMercuriusRegistration = (method: string, args: AstNode[]): boolean =>
  method === "register" && args[0]?.type === "Identifier" && args[0].name === "mercurius";

/**
 * Any sign of a depth/cost limiter in the file. Matched against raw source, so a
 * limiter mentioned in a comment or an import also counts — over-matching here
 * only makes the rule quieter, which is the direction we want to be wrong in.
 */
const LIMITER_EVIDENCE = [
  "armor",
  "complexity",
  "costanalysis",
  "cost-analysis",
  "depthlimit",
  "depth-limit",
  "maxaliases",
  "maxdepth",
  "max_depth",
  "maxtokens",
  "persistedquer",
  "querydepth",
  "validationrules",
];

/** Does this file show any evidence that query depth or cost is bounded? */
const hasLimiterEvidence = (sourceText: string): boolean => {
  const haystack = sourceText.toLowerCase();
  return LIMITER_EVIDENCE.some((token) => haystack.includes(token));
};

export const graphqlMissingDepthLimit = defineDiagnostic({
  id: "graphql-missing-depth-limit",
  title: "GraphQL server without a query depth or complexity limit",
  severity: "warn",
  category: "Reliability",
  defaultEnabled: false,
  tags: ["graphql", "dos"],
  recommendation:
    "Bound the query shape before it reaches your resolvers: add `validationRules: [depthLimit(7)]` (graphql-depth-limit), a cost rule (`createComplexityLimitRule`, graphql-query-complexity), or `@escape.tech/graphql-armor` — and reject anything over the limit at validation time.",
  create: (ctx): Visitors => {
    if (classifyFileContext(ctx.normalizedFilePath, ctx.sourceText) === "test") return {};
    // One text scan per file, not per construction.
    if (hasLimiterEvidence(ctx.sourceText)) return {};

    const check = (node: AstNode): void => {
      const name = getMethodName(node);
      if (!name) return;
      const args = (node.arguments as AstNode[] | undefined) ?? [];
      const recognized =
        node.type === "NewExpression"
          ? SERVER_CONSTRUCTORS.has(name)
          : SERVER_FACTORIES.has(name) || isMercuriusRegistration(name, args);
      if (!recognized) return;
      // A construction with no arguments at all is usually a re-export or a thin
      // wrapper, not the real server setup.
      if (args.length === 0) return;

      ctx.report(
        node,
        "This GraphQL server is constructed with no query depth or complexity limit — a self-referencing query nests as deep as the caller wants and fans out to millions of resolver calls.",
      );
    };

    return { NewExpression: check, CallExpression: check };
  },
});
