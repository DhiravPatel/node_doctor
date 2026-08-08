import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, getCalleeName, getStaticStringValue, isFunctionLike } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";

/**
 * §190 — posting a value across the worker boundary that cannot be cloned.
 *
 * THE BUG. `postMessage` does not pass a reference; it runs the **structured
 * clone algorithm**, and that algorithm throws on a function. So this:
 *
 *   ❌ worker.postMessage({ rows, onDone: () => finish() });
 *
 * is a `DataCloneError` — thrown synchronously, at the call, in production, on
 * whichever code path happens to carry the callback. It is not a type error, no
 * linter sees it, and the test that exercises the other branch passes.
 *
 *   ✅ worker.postMessage({ rows });
 *      worker.once("message", finish);
 *
 * PRECISION MODEL. The clone algorithm's rules are subtle — a `Map` clones, a
 * `Proxy` throws, a class instance clones but loses its prototype — and most of
 * that is undecidable from syntax. So the rule claims only the one case that is
 * decidable and unambiguous: **a function literal in the posted value**.
 *
 *   - The receiver must be a PROVEN worker-thread port: a binding from
 *     `new Worker(...)` imported from `node:worker_threads`, or the
 *     `parentPort` import itself. `postMessage` is also the name on a
 *     `BroadcastChannel`, a `MessagePort`, a browser `window`, and any number
 *     of userland emitters — and the browser's `window.postMessage` has the
 *     same restriction but a different remedy, so a shared message would be
 *     wrong advice half the time.
 *   - The offending value must be a FUNCTION LITERAL — an arrow or a function
 *     expression — written directly in the posted object or array. A bare
 *     identifier might hold anything, and "this variable might be a function"
 *     is a guess.
 *   - A function nested inside another function in the payload is not
 *     traversed: only the value actually being posted is walked, and the walk
 *     stops at any nested function's own body, since that body is not part of
 *     the cloned structure.
 *
 * Everything else the clone algorithm rejects — a `Proxy`, a `WeakMap`, a
 * `SharedArrayBuffer` misused, a class instance whose prototype is silently
 * dropped — needs value provenance this rule does not have, and is deliberately
 * left to §190's Planned remainder rather than guessed at.
 */

/** The module that makes a `Worker`/`parentPort` a worker-thread port. */
const WORKER_SOURCES = new Set(["worker_threads", "node:worker_threads"]);

/** Names that post across the structured-clone boundary. */
const POST_METHODS = new Set(["postMessage"]);

/**
 * Function literals that are actually PART of the cloned value.
 *
 * Only the literal object/array structure is walked. A function passed to a
 * call that BUILDS the payload — `postMessage({ rows: rows.map((r) => r.id) })`
 * — is an argument to `map`, not a value in the message: `map` returns an array
 * of ids and the callback is long gone by the time the clone runs. Walking
 * every descendant flagged those, which is a false claim about the commonest
 * way a payload is constructed.
 *
 * A getter/setter shorthand is excluded for the same reason: the clone copies
 * the value the accessor RETURNS, not the accessor.
 */
const clonedFunctionLiterals = (value: AstNode): AstNode[] => {
  const found: AstNode[] = [];
  const visit = (node: AstNode, depth: number): void => {
    if (depth > 24) return;
    if (isFunctionLike(node)) {
      found.push(node);
      return; // its body is not part of the cloned structure
    }
    if (node.type === "ObjectExpression") {
      for (const prop of (node.properties as AstNode[] | undefined) ?? []) {
        if (prop.type === "SpreadElement") continue; // an opaque source
        if (prop.type !== "Property") continue;
        // `get x() {}` / `set x(v) {}` clone their VALUE, not the accessor.
        if (prop.kind === "get" || prop.kind === "set") continue;
        const propValue = prop.value as AstNode | undefined;
        if (propValue) visit(propValue, depth + 1);
      }
      return;
    }
    if (node.type === "ArrayExpression") {
      for (const element of (node.elements as Array<AstNode | null> | undefined) ?? []) {
        if (element && element.type !== "SpreadElement") visit(element, depth + 1);
      }
      return;
    }
    // Anything else — a call, an identifier, a template — is not literal
    // structure, and what it evaluates to is not knowable here.
  };
  visit(value, 0);
  return found;
};

export const noUnclonableWorkerMessage = defineDiagnostic({
  id: "no-unclonable-worker-message",
  title: "Function posted across the worker boundary cannot be cloned",
  severity: "error",
  category: "Bugs",
  confidence: "high",
  tags: ["async", "concurrency", "crash"],
  defaultEnabled: false,
  recommendation:
    "Remove the function from the payload and coordinate over messages instead: post the data, and reply with `worker.once(\"message\", …)`. `postMessage` runs the structured clone algorithm, which throws `DataCloneError` on a function — synchronously, at the call, on whichever path carries the callback.",
  create: (ctx) => {
    /** Local names proven to be a worker-thread port. */
    const ports = new Set<string>();
    let importsWorkerThreads = false;
    /** Local alias of the imported `Worker` constructor. */
    const workerCtors = new Set<string>();

    for (const stmt of (ctx.program.body as AstNode[] | undefined) ?? []) {
      if (stmt.type !== "ImportDeclaration") continue;
      const source = stmt.source?.value;
      if (typeof source !== "string" || !WORKER_SOURCES.has(source)) continue;
      importsWorkerThreads = true;
      for (const spec of (stmt.specifiers as AstNode[] | undefined) ?? []) {
        const local = (spec.local as AstNode | undefined)?.name;
        if (typeof local !== "string") continue;
        if (spec.type !== "ImportSpecifier") continue;
        const imported = spec.imported as AstNode | undefined;
        const name = imported?.type === "Identifier" ? (imported.name as string) : null;
        // `parentPort` IS a port; `Worker` constructs one.
        if (name === "parentPort") ports.add(local);
        else if (name === "Worker") workerCtors.add(local);
      }
    }

    if (!importsWorkerThreads) {
      // `const { Worker } = require("node:worker_threads")`.
      for (const decl of collectDescendants(
        ctx.program,
        (n) => n.type === "VariableDeclarator",
        undefined,
        true,
      )) {
        const init = decl.init as AstNode | undefined;
        if (init?.type !== "CallExpression") continue;
        if (getCalleeName(init.callee as AstNode) !== "require") continue;
        const source = getStaticStringValue(((init.arguments as AstNode[] | undefined) ?? [])[0]);
        if (source === null || !WORKER_SOURCES.has(source)) continue;
        importsWorkerThreads = true;
        const id = decl.id as AstNode | undefined;
        if (id?.type !== "ObjectPattern") continue;
        for (const prop of (id.properties as AstNode[] | undefined) ?? []) {
          if (prop.type !== "Property") continue;
          const key = prop.key as AstNode | undefined;
          const local = prop.value as AstNode | undefined;
          if (key?.type !== "Identifier" || local?.type !== "Identifier") continue;
          if (key.name === "parentPort") ports.add(local.name as string);
          else if (key.name === "Worker") workerCtors.add(local.name as string);
        }
      }
    }

    // `const worker = new Worker(...)` where `Worker` came from the import.
    for (const decl of importsWorkerThreads
      ? collectDescendants(
          ctx.program,
          (n) => n.type === "VariableDeclarator",
          undefined,
          true,
        )
      : []) {
      const id = decl.id as AstNode | undefined;
      const init = decl.init as AstNode | undefined;
      if (id?.type !== "Identifier" || init?.type !== "NewExpression") continue;
      const callee = init.callee as AstNode | undefined;
      if (callee?.type === "Identifier" && workerCtors.has(callee.name as string)) {
        ports.add(id.name as string);
      }
    }

    return {
      CallExpression: (node) => {
        if (!importsWorkerThreads || ports.size === 0) return;
        const method = getMethodName(node);
        if (!method || !POST_METHODS.has(method)) return;
        const callee = node.callee as AstNode | undefined;
        if (callee?.type !== "MemberExpression") return;
        const receiver = callee.object as AstNode | undefined;
        // A proven port binding, and nothing else: `postMessage` is also on a
        // BroadcastChannel, a MessagePort, `window`, and userland emitters.
        if (receiver?.type !== "Identifier" || !ports.has(receiver.name as string)) return;
        // …and it must be THAT binding. A parameter or a nested `const` of the
        // same name shadows the module-scope port, and `worker` is a common
        // enough parameter name that name-matching alone made the claim wrong.
        const binding = ctx.scope.resolveIdentifier(receiver);
        if (binding !== null && binding.kind !== "import" && binding.scopeKind !== "module") return;

        const payload = ((node.arguments as AstNode[] | undefined) ?? [])[0];
        if (!payload) return;

        for (const fn of clonedFunctionLiterals(payload)) {
          ctx.report(
            fn,
            "`postMessage` runs the structured clone algorithm, which throws `DataCloneError` on a function — so this call fails synchronously on whichever path carries it. Post the data and coordinate the callback over a `message` reply instead.",
          );
        }
      },
    };
  },
});
