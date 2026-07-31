import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getStaticStringValue, getCalleeName } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";

/**
 * §128 — a `.pipe()` whose source has no error handler.
 *
 * THE BUG. `readable.pipe(writable)` does NOT forward errors and does NOT destroy
 * the destination when the source fails. If the source emits `error` — a disk
 * read failing, a socket resetting, a gzip stream hitting corrupt input — the
 * pipe is torn down but the DESTINATION is left open. The file descriptor leaks,
 * the HTTP response never ends, the request hangs until the client times out. And
 * because the source is an EventEmitter, an `error` with no listener at all is
 * re-thrown as an uncaught exception and takes the process down.
 *
 * This is the canonical "passes every test, falls over in production" defect:
 * the happy path never emits `error`, so nothing catches it until a real disk,
 * a real network, or a real malformed upload does. Node's own documentation
 * recommends `stream.pipeline()` precisely because it fixes all of this.
 *
 *   ❌ createReadStream(path).pipe(res);
 *   ✅ pipeline(createReadStream(path), res, (err) => { if (err) next(err); });
 *   ✅ const file = createReadStream(path);
 *      file.on("error", next);
 *      file.pipe(res);
 *
 * PRECISION MODEL. `.pipe()` is also RxJS's operator-composition method, and an
 * observable pipeline has nothing to do with streams — so the source is never
 * assumed. It must be PROVABLY a Node stream: a binding (or an inline chain)
 * whose root is a recognized stream factory (`createReadStream`,
 * `createWriteStream`, `createGzip`, `new PassThrough`, …). Anything else — an
 * observable, a parameter, a property, a function result we cannot identify — is
 * silent.
 *
 * We then look for the error handler and stay silent whenever one might exist:
 *   - an `.on("error", …)`/`.once("error", …)` on that binding anywhere in the
 *     file, in any order (registration after the pipe is still registration);
 *   - an error listener attached inline in the chain before `.pipe`;
 *   - the pipe sitting inside a `pipeline(...)` call, which handles teardown;
 *   - a dynamic event name, or the source escaping into a call we cannot see
 *     through, which could attach the handler out of sight.
 */

/** Factories that provably return a Node stream. */
const STREAM_FACTORIES = new Set([
  "createReadStream",
  "createWriteStream",
  "createGzip",
  "createGunzip",
  "createDeflate",
  "createInflate",
  "createBrotliCompress",
  "createBrotliDecompress",
  "createUnzip",
]);

/** Constructors that provably produce a Node stream. */
const STREAM_CONSTRUCTORS = new Set([
  "Readable",
  "Writable",
  "Duplex",
  "Transform",
  "PassThrough",
]);

const REGISTRARS = new Set(["on", "once", "addListener", "prependListener", "prependOnceListener"]);

/** The property name of a member expression, including a computed string key. */
const propertyName = (member: AstNode): string | null => {
  const property = member.property as AstNode | undefined;
  if (!member.computed && property?.type === "Identifier") return property.name as string;
  if (member.computed && property?.type === "Literal" && typeof property.value === "string") {
    return property.value;
  }
  return null;
};

/**
 * Is this expression provably a freshly-created Node stream? Handles the direct
 * call (`createReadStream(p)`), the namespaced call (`fs.createReadStream(p)`),
 * a constructor (`new PassThrough()`), and a chain rooted at one of those
 * (`createReadStream(p).on("error", h)`).
 */
const isStreamExpression = (node: AstNode | undefined, guard = 0): boolean => {
  if (!node || guard > 32) return false;
  if (node.type === "NewExpression") {
    const ctor = getCalleeName(node.callee as AstNode);
    return !!ctor && STREAM_CONSTRUCTORS.has(ctor);
  }
  if (node.type !== "CallExpression") return false;
  const callee = node.callee as AstNode | undefined;
  if (callee?.type === "Identifier") return STREAM_FACTORIES.has(callee.name as string);
  if (callee?.type === "MemberExpression") {
    const method = propertyName(callee);
    if (method && STREAM_FACTORIES.has(method)) return true;
    // A chained call on a stream (`createReadStream(p).on(…)`) is still a stream.
    return isStreamExpression(callee.object as AstNode | undefined, guard + 1);
  }
  return false;
};

/** Does this chain register an `error` listener before the current position? */
const chainHandlesError = (node: AstNode | undefined, guard = 0): boolean => {
  if (!node || guard > 32) return false;
  if (node.type !== "CallExpression") return false;
  const callee = node.callee as AstNode | undefined;
  if (callee?.type === "MemberExpression") {
    const method = propertyName(callee);
    if (method && REGISTRARS.has(method)) {
      const event = getStaticStringValue(((node.arguments as AstNode[] | undefined) ?? [])[0]);
      if (event === "error") return true;
      if (event === null) return true; // dynamic name — unprovable, treat as handled
    }
    return chainHandlesError(callee.object as AstNode | undefined, guard + 1);
  }
  return false;
};

export const noUnhandledPipeError = defineDiagnostic({
  id: "no-unhandled-pipe-error",
  title: "Piped stream has no error handler",
  severity: "warn",
  category: "Reliability",
  confidence: "high",
  tags: ["reliability", "streams", "resource-leak"],
  defaultEnabled: false,
  recommendation:
    "Use `stream.pipeline(source, destination, callback)` instead of `.pipe()` — it forwards errors, destroys every stream in the chain, and calls back once. If you must keep `.pipe()`, register an `error` listener on the source: `src.on(\"error\", next)`. Bare `.pipe()` does not forward errors, so a failing source leaves the destination open — a leaked file descriptor and a request that hangs until the client gives up.",
  create: (ctx) => {
    /** Bindings whose initializer is provably a Node stream. */
    const streamBindings = new Set<string>();
    for (const decl of collectDescendants(
      ctx.program,
      (n) => n.type === "VariableDeclarator",
      undefined,
      true,
    )) {
      const id = decl.id as AstNode | undefined;
      if (id?.type !== "Identifier") continue;
      let init = decl.init as AstNode | undefined;
      if (init?.type === "AwaitExpression") init = init.argument as AstNode | undefined;
      if (isStreamExpression(init)) streamBindings.add(id.name as string);
    }

    /** Bindings that have an `error` listener registered somewhere in the file. */
    const handled = new Set<string>();
    /** Bindings that escape into a call we cannot see through. */
    const escaped = new Set<string>();
    for (const call of collectDescendants(
      ctx.program,
      (n) => n.type === "CallExpression",
      undefined,
      true,
    )) {
      const callee = call.callee as AstNode | undefined;
      const args = (call.arguments as AstNode[] | undefined) ?? [];

      if (callee?.type === "MemberExpression") {
        const object = callee.object as AstNode | undefined;
        const method = propertyName(callee);
        if (object?.type === "Identifier" && method) {
          if (REGISTRARS.has(method)) {
            const event = getStaticStringValue(args[0]);
            // A dynamic event name could be "error" — treat as handled.
            if (event === "error" || event === null) handled.add(object.name as string);
          } else if (method === "addEventListener") {
            handled.add(object.name as string);
          }
        }
      }

      // `pipeline(a, b, cb)` handles teardown for every member of the chain.
      const bare = getCalleeName(callee as AstNode);
      const isPipeline = bare === "pipeline" || (callee?.type === "MemberExpression" && propertyName(callee) === "pipeline");
      for (const arg of args) {
        if (arg?.type !== "Identifier") continue;
        if (isPipeline) handled.add(arg.name as string);
        // The stream handed to any other call may get its handler there.
        else if (!isPipeline && bare !== undefined) escaped.add(arg.name as string);
      }
    }

    return {
      CallExpression: (node) => {
        const callee = node.callee as AstNode | undefined;
        if (callee?.type !== "MemberExpression") return;
        if (propertyName(callee) !== "pipe") return;
        const args = (node.arguments as AstNode[] | undefined) ?? [];
        // Node's `.pipe(destination[, options])` takes 1-2 arguments; RxJS's
        // operator composition normally takes operator calls and often more.
        if (args.length === 0 || args.length > 2) return;
        // An RxJS-style argument (`map(...)`, `filter(...)`) is never a destination.
        if (args[0]?.type === "CallExpression") return;

        const source = callee.object as AstNode | undefined;
        if (!source) return;

        // Inside a `pipeline(...)` call the teardown is handled for us.
        let parent = (node as { parent?: AstNode }).parent;
        let guard = 0;
        while (parent && guard++ < 8) {
          if (parent.type === "CallExpression") {
            const name = getCalleeName(parent.callee as AstNode);
            const member =
              (parent.callee as AstNode | undefined)?.type === "MemberExpression"
                ? propertyName(parent.callee as AstNode)
                : null;
            if (name === "pipeline" || member === "pipeline") return;
          }
          parent = (parent as { parent?: AstNode }).parent;
        }

        // (1) A named binding proven to hold a stream.
        if (source.type === "Identifier") {
          const name = source.name as string;
          if (!streamBindings.has(name)) return; // not provably a stream
          if (handled.has(name) || escaped.has(name)) return;
          ctx.report(
            node,
            "This stream is piped without an `error` listener on the source. `.pipe()` does not forward errors or destroy the destination, so a read/socket/decompression failure leaves the destination open — a leaked file descriptor and a request that hangs — and an unhandled `error` event crashes the process.",
          );
          return;
        }

        // (2) An inline chain rooted at a stream factory.
        if (isStreamExpression(source) && !chainHandlesError(source)) {
          ctx.report(
            node,
            "This stream is piped without an `error` listener on the source. `.pipe()` does not forward errors or destroy the destination, so a read/socket/decompression failure leaves the destination open — a leaked file descriptor and a request that hangs — and an unhandled `error` event crashes the process.",
          );
        }
      },
    };
  },
});
