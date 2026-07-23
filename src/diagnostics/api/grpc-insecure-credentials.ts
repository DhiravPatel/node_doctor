import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode, Visitors } from "../../core/types.ts";
import { getCalleeName } from "../../core/ast.ts";
import { classifyFileContext } from "../../core/file-context.ts";
import { importsMatching, isUnderEnvGuard, staticStringPrefix } from "./context.ts";

/**
 * A gRPC server bound — or a channel dialed — with insecure credentials.
 *
 * `createInsecure()` is not "TLS with a self-signed certificate"; it is no TLS at
 * all. Every message, including the bearer tokens and API keys applications put
 * in call metadata, travels as readable plaintext, so anything on the path — a
 * shared VPC, a service mesh sidecar, a cloud load balancer — can read and
 * rewrite it. It is the default in every gRPC tutorial, which is exactly why it
 * reaches production.
 *
 * Silent on loopback addresses, inside environment guards, and in test files:
 * plaintext to `127.0.0.1` never touches a network, and a dev-only branch is the
 * correct way to keep this out of production.
 *
 * ❌ server.bindAsync("0.0.0.0:50051", grpc.ServerCredentials.createInsecure(), cb);
 * ❌ const client = new Greeter(process.env.ADDR, grpc.credentials.createInsecure());
 * ✅ server.bindAsync("0.0.0.0:50051", grpc.ServerCredentials.createSsl(rootCert, keyPairs), cb);
 * ✅ const client = new Greeter(addr, grpc.credentials.createSsl());
 */

/** Package specifiers that make this file a gRPC file. */
const GRPC_MODULE_RE = /^(@grpc\/|grpc$|grpc-js$)/;

/**
 * The dotted callee shapes that produce insecure credentials, matched on the
 * final two segments so `grpc.credentials.createInsecure()`, a namespace alias,
 * and a destructured `ServerCredentials` all resolve the same way.
 */
const INSECURE_CALLS = new Set([
  "ChannelCredentials.createInsecure",
  "ServerCredentials.createInsecure",
  "credentials.createInsecure",
]);

/** Addresses that never leave the machine, so plaintext is not on any wire. */
const LOOPBACK_RE = /^(unix:|localhost|127\.0\.0\.1|\[::1\]|::1)/i;

/** Is this `<something>.createInsecure()` from the gRPC credentials API? */
const isInsecureCredentialsCall = (node: AstNode): boolean => {
  const callee = getCalleeName(node);
  if (!callee) return false;
  const segments = callee.split(".");
  if (segments.length < 2) return false;
  return INSECURE_CALLS.has(segments.slice(-2).join("."));
};

/**
 * The call/new expression this credentials object is handed to — `bindAsync`,
 * `bind`, `new Client(...)`, `makeClientConstructor(...)`. Returns null when the
 * result is stored in a variable instead, which we deliberately do not chase:
 * without the sibling address argument we cannot tell loopback from public, and
 * guessing there would cost precision.
 */
const consumingCall = (node: AstNode): AstNode | null => {
  const parent = node.parent;
  if (!parent) return null;
  if (parent.type !== "CallExpression" && parent.type !== "NewExpression") return null;
  const args = (parent.arguments as AstNode[] | undefined) ?? [];
  return args.includes(node) ? parent : null;
};

/** Does any sibling argument name a loopback / unix-socket target? */
const targetsLoopback = (call: AstNode): boolean =>
  ((call.arguments as AstNode[] | undefined) ?? []).some((arg) => {
    const prefix = staticStringPrefix(arg);
    return prefix !== null && LOOPBACK_RE.test(prefix);
  });

export const grpcInsecureCredentials = defineDiagnostic({
  id: "grpc-insecure-credentials",
  title: "gRPC server or channel uses insecure (plaintext) credentials",
  severity: "error",
  category: "Security",
  confidence: "high",
  tags: ["grpc", "network", "transport"],
  recommendation:
    "Terminate TLS on the gRPC connection itself: `grpc.ServerCredentials.createSsl(rootCerts, keyCertPairs, checkClientCertificate)` on the server and `grpc.credentials.createSsl(...)` on the channel. If a plaintext hop is genuinely required, restrict it to loopback or a dev-only branch.",
  create: (ctx): Visitors => {
    // A plaintext channel in a test harness talks to a test server.
    if (classifyFileContext(ctx.normalizedFilePath, ctx.sourceText) === "test") return {};
    // Provenance: `credentials.createInsecure()` only means gRPC if this file
    // actually loads a gRPC package. Without that, the name is a coincidence.
    if (!importsMatching(ctx.program, GRPC_MODULE_RE)) return {};

    return {
      CallExpression: (node) => {
        if (!isInsecureCredentialsCall(node)) return;
        const call = consumingCall(node);
        if (!call) return; // not bound/dialed here
        if (targetsLoopback(call)) return;
        if (isUnderEnvGuard(node)) return;

        ctx.report(
          node,
          "This gRPC endpoint is bound with insecure credentials — the connection carries no TLS, so every message and every metadata token is plaintext on the wire.",
        );
      },
    };
  },
});
