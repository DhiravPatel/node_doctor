/**
 * GraphQL / gRPC server-setup diagnostics.
 *
 * These live in a bucket the generated registry may not know about yet, so the
 * diagnostics are imported directly rather than through `tests/helpers.ts`.
 * Deliberately about server SETUP, not schema analysis — a schema reader is a
 * separate project, and the setup is where the exploitable mistakes are.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import type { Diagnostic } from "../../src/core/types.ts";
import { graphqlIntrospectionInProduction } from "../../src/diagnostics/api/graphql-introspection-in-production.ts";
import { graphqlMissingDepthLimit } from "../../src/diagnostics/api/graphql-missing-depth-limit.ts";
import { graphqlResolverReturnsRawError } from "../../src/diagnostics/api/graphql-resolver-returns-raw-error.ts";
import { grpcInsecureCredentials } from "../../src/diagnostics/api/grpc-insecure-credentials.ts";

const count = (d: Diagnostic, source: string, file = "src/server.ts"): number =>
  lintSource({
    filePath: file,
    sourceText: source,
    diagnostics: [d],
    capabilities: new Set(["node", "esm", "typescript"]),
  }).findings.filter((f) => f.diagnostic === d.id).length;

const fires = (d: Diagnostic, source: string, file?: string): void =>
  assert.ok(count(d, source, file) > 0, `expected ${d.id} to FIRE on:\n${source}`);
const silent = (d: Diagnostic, source: string, file?: string): void =>
  assert.equal(count(d, source, file), 0, `expected ${d.id} SILENT on:\n${source}`);

describe("graphql-introspection-in-production", () => {
  test("fires on a hardcoded introspection: true", () => {
    fires(graphqlIntrospectionInProduction, `const s = new ApolloServer({ typeDefs, resolvers, introspection: true });`);
  });

  // The env-guarded form is the correct pattern and by far the most common one.
  // Flagging it would train users to disable the rule.
  test("silent on the env-guarded and flag forms — the recommended shapes", () => {
    silent(graphqlIntrospectionInProduction, `const s = new ApolloServer({ typeDefs, introspection: process.env.NODE_ENV !== "production" });`);
    silent(graphqlIntrospectionInProduction, `const s = new ApolloServer({ typeDefs, introspection: isDev });`);
    silent(graphqlIntrospectionInProduction, `const s = new ApolloServer({ typeDefs, resolvers });`);
  });

  test("silent on createServer — that name belongs to node:http", () => {
    silent(graphqlIntrospectionInProduction, `const s = createServer({ introspection: true });`);
  });

  test("silent in a test file", () => {
    silent(graphqlIntrospectionInProduction, `const s = new ApolloServer({ introspection: true });`, "src/server.test.ts");
  });
});

describe("graphql-missing-depth-limit", () => {
  test("fires on an Apollo server with no depth/complexity rule", () => {
    fires(graphqlMissingDepthLimit, `const s = new ApolloServer({ typeDefs, resolvers });`);
  });

  test("silent when a depth-limit validation rule is present", () => {
    silent(
      graphqlMissingDepthLimit,
      `import depthLimit from "graphql-depth-limit";\nconst s = new ApolloServer({ typeDefs, validationRules: [depthLimit(5)] });`,
    );
  });

  test("is opt-in — absence of a plugin is weaker evidence than a bug", () => {
    assert.equal(graphqlMissingDepthLimit.defaultEnabled, false);
  });
});

describe("graphql-resolver-returns-raw-error", () => {
  test("fires when a resolver returns the raw error stack", () => {
    fires(
      graphqlResolverReturnsRawError,
      `const resolvers = { Query: { u: async () => { try { return await load(); } catch (err) { return new Error(err.stack); } } } };`,
    );
  });
});

describe("grpc-insecure-credentials", () => {
  // The realistic shape: a gRPC import, an insecure-credentials call, and a
  // bind/dial to a public address — all three are required.
  test("fires on a server bound insecurely to a public address", () => {
    fires(
      grpcInsecureCredentials,
      `import grpc from "@grpc/grpc-js";\nconst server = new grpc.Server();\nserver.bindAsync("0.0.0.0:50051", grpc.ServerCredentials.createInsecure(), () => {});`,
    );
  });

  test("fires on a client dialed insecurely to a public address", () => {
    fires(
      grpcInsecureCredentials,
      `import grpc from "@grpc/grpc-js";\nconst client = new Greeter("api.example.com:50051", grpc.credentials.createInsecure());`,
    );
  });

  test("silent on loopback — plaintext there never touches a network", () => {
    silent(
      grpcInsecureCredentials,
      `import grpc from "@grpc/grpc-js";\nconst server = new grpc.Server();\nserver.bindAsync("127.0.0.1:50051", grpc.ServerCredentials.createInsecure(), () => {});`,
    );
  });

  // `createInsecure` on an object that is not the gRPC API is a name collision.
  test("silent when the file does not import a gRPC package", () => {
    silent(grpcInsecureCredentials, `const c = grpc.credentials.createInsecure();\nnew Client(addr, c);`);
  });

  test("silent on createSsl and in test files", () => {
    silent(grpcInsecureCredentials, `import grpc from "@grpc/grpc-js";\nconst c = new Greeter("api.example.com:50051", grpc.credentials.createSsl(root));`);
    silent(
      grpcInsecureCredentials,
      `import grpc from "@grpc/grpc-js";\nconst c = new Greeter("api.example.com:50051", grpc.credentials.createInsecure());`,
      "test/client.test.ts",
    );
  });
});
