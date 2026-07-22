import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode, Visitors } from "../../core/types.ts";
import { getStaticStringValue } from "../../core/ast.ts";

/**
 * A Node built-in imported in a project that targets an edge runtime (§95).
 *
 * Cloudflare Workers, Vercel Edge and Deno Deploy do not ship most of Node's
 * standard library. The import resolves fine locally and fails at deploy or —
 * worse — at the first request in production. Only fires when the project
 * actually declares an edge target, so a normal Node service is unaffected.
 *
 * ❌ import fs from "node:fs";        // no filesystem at the edge
 * ✅ const data = await fetch(url);   // web APIs are available
 */

/**
 * Built-ins that NO edge runtime provides, under any compatibility flag.
 *
 * Deliberately conservative. Cloudflare's `nodejs_compat` ships `net`, `tls`,
 * `os`, `http`, `crypto`, `buffer`, `stream`, `util`, `path` and more — the
 * documented Hyperdrive/Postgres pattern is literally `import net from "node:net"`.
 * Flagging those at `error`/`high` confidence would be asserting a fact we never
 * observed, since the compatibility flags live in wrangler.toml. What remains here
 * is the set that genuinely cannot work in a V8-isolate model: spawning processes,
 * forking, real threads, raw UDP, and the VM/V8 internals.
 */
const UNAVAILABLE_AT_EDGE = new Set([
  "child_process",
  "node:child_process",
  "cluster",
  "node:cluster",
  "worker_threads",
  "node:worker_threads",
  "dgram",
  "node:dgram",
  "v8",
  "node:v8",
  "vm",
  "node:vm",
]);

/**
 * Files that run under Node during build/tooling, never at the edge.
 *
 * `requires: ["edge"]` is a whole-project token, so without this the rule reports
 * `import fs from "node:fs"` in `scripts/build.mjs` and `vite.config.ts` — code the
 * user cannot possibly change, in every textbook Worker repo.
 */
const NODE_ONLY_PATH = /(^|\/)(scripts?|tools?|build|bin|config)\/|(^|\/)[^/]*\.config\.[cm]?[jt]s$|(^|\/)(vite|rollup|webpack|esbuild|tsup|next|tailwind|jest|vitest|playwright)\.config\./;

const report = (ctx: { report: (n: AstNode, m: string) => void }, node: AstNode, spec: string): void => {
  ctx.report(
    node,
    `\`${spec}\` is a Node built-in that edge runtimes do not provide — this resolves locally and fails on deploy. Use a Web API (\`fetch\`, \`crypto.subtle\`, \`Request\`/\`Response\`) or move this code to a Node runtime.`,
  );
};

export const noNodeBuiltinOnEdge = defineDiagnostic({
  id: "no-node-builtin-on-edge",
  title: "Node built-in used in an edge-runtime project",
  severity: "error",
  category: "Reliability",
  confidence: "high",
  requires: ["edge"],
  tags: ["modernization", "edge"],
  recommendation:
    "Replace the Node built-in with a Web API available at the edge (`fetch`, `crypto.subtle`, `Request`/`Response`, `WebSocketPair`), or run this module on a Node runtime instead of the edge.",
  create: (ctx): Visitors => {
    // Build tooling runs under Node even in a Worker repo, and the user cannot
    // remove `node:fs` from their build script. Bail once, per file.
    if (NODE_ONLY_PATH.test(ctx.normalizedFilePath)) return {};

    return {
      ImportDeclaration: (node) => {
        // `import type` is erased at compile time, so nothing reaches the bundle.
        // Deliberately declaration-level only: under verbatimModuleSyntax an inline
        // `import { type X } from "node:net"` still emits a real runtime load.
        if (node.importKind === "type") return;
        const spec = node.source?.value;
        if (typeof spec === "string" && UNAVAILABLE_AT_EDGE.has(spec)) report(ctx, node.source as AstNode, spec);
      },
      CallExpression: (node) => {
        const callee = node.callee as AstNode | undefined;
        const isRequire = callee?.type === "Identifier" && callee.name === "require";
        if (!isRequire) return;
        const arg = ((node.arguments as AstNode[]) ?? [])[0];
        const spec = arg ? getStaticStringValue(arg) : null;
        if (spec && UNAVAILABLE_AT_EDGE.has(spec)) report(ctx, arg!, spec);
      },
    };
  },
});
