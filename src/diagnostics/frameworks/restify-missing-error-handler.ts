import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getCalleeName, getStaticStringValue } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";

/**
 * A restify server that is created and listened on with no error wiring. Unlike
 * Express, restify ships no default error handler: when a handler throws
 * asynchronously the request hangs until the client times out, and an escaped
 * throw reaches the process as an uncaught exception that kills the server —
 * dropping every in-flight request, not just the failing one. `server.on("restifyError", …)`
 * gives every failure a shaped response; `server.on("uncaughtException", …)` keeps
 * a handler throw from taking the process down.
 *
 * Only fires when the server is both created and `listen`ed on in this file, and
 * only when the binding is never handed to another function — if the server is
 * passed anywhere (`registerRoutes(server)`, `module.exports = server`) the wiring
 * plausibly lives there and asserting otherwise would be guessing.
 *
 * ❌ const server = restify.createServer(); server.post("/x", h); server.listen(8080);
 * ✅ const server = restify.createServer();
 * ✅ server.on("restifyError", (req, res, err, cb) => { log(err); return cb(); });
 * ✅ server.on("uncaughtException", (req, res, route, err) => res.send(500));
 */

/**
 * Server-level events that constitute error wiring. Restify emits a named event
 * per error class (`InternalServer`, `NotFound`, `BadRequestError`, …), so any
 * `*Error` name counts too — over-matching here only costs a missed finding.
 */
const ERROR_EVENTS = new Set([
  "InternalServer",
  "MethodNotAllowed",
  "NotFound",
  "RequestCloseError",
  "VersionNotAllowed",
  "restifyError",
  "uncaughtException",
]);

const isErrorEventName = (name: string): boolean => ERROR_EVENTS.has(name) || name.endsWith("Error");

/** Local names bound to the restify module, and to a named `createServer` import. */
interface RestifyImports {
  namespaces: Set<string>;
  createServerLocals: Set<string>;
}

const isRequireOfRestify = (node: AstNode | null | undefined): boolean =>
  !!node &&
  node.type === "CallExpression" &&
  getCalleeName(node) === "require" &&
  getStaticStringValue((node.arguments as AstNode[])?.[0]) === "restify";

const collectRestifyImports = (program: AstNode): RestifyImports => {
  const namespaces = new Set<string>();
  const createServerLocals = new Set<string>();

  for (const decl of collectDescendants(program, (n) => n.type === "ImportDeclaration")) {
    if (getStaticStringValue(decl.source) !== "restify") continue;
    for (const spec of (decl.specifiers as AstNode[]) ?? []) {
      const local = spec.local?.name;
      if (typeof local !== "string") continue;
      if (spec.type === "ImportDefaultSpecifier" || spec.type === "ImportNamespaceSpecifier") {
        namespaces.add(local);
      } else if (spec.type === "ImportSpecifier" && spec.imported?.name === "createServer") {
        createServerLocals.add(local);
      }
    }
  }

  for (const decl of collectDescendants(program, (n) => n.type === "VariableDeclarator")) {
    if (!isRequireOfRestify(decl.init)) continue;
    const id = decl.id as AstNode | undefined;
    if (id?.type === "Identifier") namespaces.add(id.name);
    if (id?.type === "ObjectPattern") {
      for (const prop of (id.properties as AstNode[]) ?? []) {
        if (prop.type !== "Property" || prop.computed) continue;
        if (prop.key?.name !== "createServer") continue;
        if (prop.value?.type === "Identifier") createServerLocals.add(prop.value.name);
      }
    }
  }

  return { namespaces, createServerLocals };
};

const isCreateServerCall = (node: AstNode | null | undefined, imports: RestifyImports): boolean => {
  if (!node || node.type !== "CallExpression") return false;
  const callee = getCalleeName(node);
  if (!callee) return false;
  if (imports.createServerLocals.has(callee)) return true;
  const dot = callee.lastIndexOf(".");
  if (dot === -1) return false;
  return callee.slice(dot + 1) === "createServer" && imports.namespaces.has(callee.slice(0, dot));
};

export const restifyMissingErrorHandler = defineDiagnostic({
  id: "restify-missing-error-handler",
  title: "restify server with no error handler",
  severity: "warn",
  category: "Reliability",
  requires: ["restify"],
  tags: ["restify", "error-handling"],
  recommendation:
    'Wire the server\'s error events: `server.on("restifyError", (req, res, err, next) => { … })` for shaped error responses, and `server.on("uncaughtException", (req, res, route, err) => { … })` so a throwing handler answers the request instead of killing the process.',
  create: (ctx) => ({
    Program: (program) => {
      const imports = collectRestifyImports(program);
      if (imports.namespaces.size === 0 && imports.createServerLocals.size === 0) return;

      const calls = collectDescendants(program, (n) => n.type === "CallExpression");
      const identifiers = collectDescendants(program, (n) => n.type === "Identifier");

      // Pre-order collection keeps declarator order stable, so output is deterministic.
      const declarators = collectDescendants(
        program,
        (n) => n.type === "VariableDeclarator" && n.id?.type === "Identifier" && isCreateServerCall(n.init, imports),
      );

      for (const declarator of declarators) {
        const name = declarator.id.name as string;

        let listens = false;
        let handled = false;
        for (const call of calls) {
          const callee = getCalleeName(call);
          if (callee === `${name}.listen`) listens = true;
          if (callee === `${name}.on`) {
            const event = getStaticStringValue((call.arguments as AstNode[])?.[0]);
            // A non-static event name could be anything — treat it as handled.
            if (event === null || isErrorEventName(event)) handled = true;
          }
        }
        if (!listens || handled) continue;

        // If the binding escapes — passed to a function, exported, reassigned —
        // the error wiring plausibly happens out of sight. Only `server.<prop>`
        // uses (plus the declarator itself) keep the file self-contained.
        const escapes = identifiers.some((id) => {
          if (id.name !== name || id === declarator.id) return false;
          const parent = id.parent;
          return !(parent?.type === "MemberExpression" && parent.object === id);
        });
        if (escapes) continue;

        ctx.report(
          declarator.init,
          "This restify server is created and listened on with no `restifyError` or `uncaughtException` handler — a throwing route handler leaves the request hanging and can take the process down.",
        );
      }
    },
  }),
});
