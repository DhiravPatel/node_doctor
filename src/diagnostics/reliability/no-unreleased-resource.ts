import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, getStaticStringValue, getCalleeName, isFunctionLike } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";

/**
 * §165 — a paired resource acquired and never released.
 *
 * THE BUG. A pooled database connection checked out and not returned is the
 * canonical production outage: the pool has ten clients, ten requests take an
 * error path that skips `release()`, and the eleventh request — and every
 * request after it — hangs forever waiting for a connection that is never coming
 * back. Nothing crashes, nothing logs, the service simply stops answering. The
 * same shape leaks Mongo sessions, OpenTelemetry spans that never close (so the
 * trace never ships), and mutex permits that deadlock the next caller.
 *
 *   ❌ const client = await pool.connect();
 *      const rows = await client.query(sql);      // throws → never released
 *      return rows;
 *
 *   ✅ const client = await pool.connect();
 *      try { return await client.query(sql); } finally { client.release(); }
 *
 * PRECISION MODEL — why this is not the "paired verb" rule the plan described.
 *
 * The obvious design is a table of verbs: `acquire`/`release`, `open`/`close`,
 * `lock`/`unlock`. That design is a false-positive machine, and this project has
 * paid for that lesson repeatedly: `close` is files, modals, dropdowns and RxJS
 * subjects; `end` is `res.end()` on every Express route ever written; `connect`
 * is React-Redux; `release` is semver. A verb is a word, not a contract.
 *
 * So the rule never guesses from a name. Every firing is anchored to a
 * DOCUMENTED LIBRARY CONTRACT, proven by binding from the import statement down:
 *
 *   1. The package is imported in THIS file (`import { Pool } from "pg"`, or the
 *      `require` equivalent) — the local alias is whatever the author chose.
 *   2. The receiver is bound from that import (`const pool = new Pool(...)`,
 *      `const tracer = trace.getTracer("x")`) — so `pool` is provably a pg pool
 *      and not a variable someone happened to name `pool`.
 *   3. The acquire is the contract's method on that receiver, and its result is
 *      bound to a plain local (`const client = await pool.connect()`).
 *   4. The contract's release is called on that binding NOWHERE in its lifetime.
 *
 * Steps 1–3 are checked by BINDING IDENTITY through `ctx.scope`, not by name. An
 * adversarial hunt caught the first version doing exactly what this comment
 * forbids: it kept a flat name→contract map, so one `const pool = new Pool()`
 * anywhere in the file made EVERY `pool` in that file a pg pool — including a
 * parameter of a different type, a `for (const pool of pools)` loop variable, and
 * a `pool` local in an unrelated function. Each of those produced a message that
 * named a library the code did not use and prescribed a method it did not have.
 * The receiver, the factory and the acquired value are now each resolved to a
 * `Binding` and compared by reference.
 *
 * Three further silences, each closing a way the claim could be wrong:
 *
 *   - ESCAPE. If the binding is used as anything other than `binding.<prop>` —
 *     returned, passed to a helper, stored on an object, captured and handed
 *     off — the release may happen out of sight, and the rule says nothing. This
 *     is a WHITELIST (only member access is safe), not a list of known escapes,
 *     because an enumeration always misses one.
 *   - LIFETIME. Only a resource acquired inside a function is judged. A module-
 *     scope handle is meant to outlive the module body; "you never released it"
 *     is exactly wrong there. The lifetime region is the whole enclosing function
 *     body rather than the nearest block: `var conn` acquired inside a `try` and
 *     released in the matching `finally` lives in two sibling blocks, and the
 *     narrow region reported the exact fix this rule recommends as a leak.
 *   - EXPLICIT RESOURCE MANAGEMENT. `using` / `await using` (TS 5.2) call the
 *     disposer at scope exit by language rule. There is nothing to add.
 *   - ANY MENTION OF THE RELEASE COUNTS. Inside `finally`, inside `catch`,
 *     inside a nested callback, chained as `acquire().release()` — the rule does
 *     not attempt to prove the release runs on EVERY path, because that needs a
 *     control-flow graph this engine does not have. It proves the release is
 *     ABSENT, which needs nothing but syntax.
 */

/** How a contract's release is invoked on the acquired value. */
type ReleaseShape =
  | { kind: "method"; name: string }
  /** The acquired value IS the releaser: `const release = await mutex.acquire()`. */
  | { kind: "call" };

interface ResourceContract {
  /** Module specifiers that provide the factory. */
  sources: string[];
  /**
   * The imported binding that produces the receiver, and how. `new` → `new
   * Pool()`; `call` → `trace.getTracer()`; `direct` → the import itself is the
   * acquire target (`import { open } from "node:fs/promises"`).
   */
  factory: { name: string; via: "new" | "call" | "direct" };
  /** The method that hands out the resource. */
  acquire: string;
  release: ReleaseShape;
  /** Human name of the resource, for the message. */
  resource: string;
  /** What goes wrong when it is never released. */
  consequence: string;
}

/**
 * v1 contracts. Each is a documented, unambiguous pairing from a library whose
 * own docs say the release is mandatory — not a verb that looked plausible.
 * Growing this table is cheap; guessing at it is not.
 */
const CONTRACTS: ResourceContract[] = [
  {
    sources: ["pg"],
    factory: { name: "Pool", via: "new" },
    acquire: "connect",
    release: { kind: "method", name: "release" },
    resource: "pooled Postgres client",
    consequence:
      "the pool never gets it back, so once every client is checked out every subsequent query waits forever — the service stops answering without crashing or logging",
  },
  {
    sources: ["mongodb"],
    factory: { name: "MongoClient", via: "new" },
    acquire: "startSession",
    release: { kind: "method", name: "endSession" },
    resource: "MongoDB session",
    consequence:
      "the server holds the session open until it times out, pinning a connection and any transaction state with it",
  },
  {
    sources: ["@opentelemetry/api"],
    factory: { name: "trace", via: "call" },
    acquire: "startSpan",
    release: { kind: "method", name: "end" },
    resource: "OpenTelemetry span",
    consequence:
      "an unended span is never exported, so the operation is missing from the trace entirely — and the trace you reach for during an incident is the one with the hole in it",
  },
  {
    // `Mutex.acquire()` resolves to the releaser function itself. `Semaphore`
    // is deliberately ABSENT: its `acquire()` resolves to a `[value, releaser]`
    // TUPLE, so the fix this rule would print (`release()`) throws TypeError.
    // A recommendation that does not work is worse than no rule.
    sources: ["async-mutex"],
    factory: { name: "Mutex", via: "new" },
    acquire: "acquire",
    release: { kind: "call" },
    resource: "mutex permit",
    consequence: "every later caller blocks on a lock that is never given back — a permanent deadlock",
  },
];

/**
 * The scope resolver's view of a binding. Compared BY REFERENCE — that is the
 * whole point: two bindings with the same name are two different objects.
 */
type Binding = ReturnType<Scope["getBinding"]>;

interface Scope {
  getBinding(name: string, fromNode: AstNode): { declNode: AstNode; initNode: AstNode | null } | null;
  resolveIdentifier(node: AstNode): { declNode: AstNode; initNode: AstNode | null } | null;
}

const staticSource = (stmt: AstNode): string | null => {
  const value = stmt.source?.value;
  return typeof value === "string" ? value : null;
};

/**
 * Bindings introduced by an import (or a `require` destructure) that name a
 * contract factory. Keyed by the resolved BINDING, so a later local of the same
 * name cannot inherit the contract.
 *
 * Namespace imports are deliberately not resolved: `ns.Pool` is a member path,
 * not a binding, and following it would reintroduce exactly the name guessing
 * this rule exists to avoid.
 */
const collectFactoryBindings = (program: AstNode, scope: Scope): Map<Binding, ResourceContract[]> => {
  const factories = new Map<Binding, ResourceContract[]>();
  const bind = (localNode: AstNode, source: string, importedName: string): void => {
    const binding = scope.getBinding(localNode.name as string, localNode);
    if (!binding) return;
    for (const contract of CONTRACTS) {
      if (!contract.sources.includes(source)) continue;
      if (contract.factory.name !== importedName) continue;
      const list = factories.get(binding);
      if (list) list.push(contract);
      else factories.set(binding, [contract]);
    }
  };

  for (const stmt of (program.body as AstNode[] | undefined) ?? []) {
    if (stmt.type !== "ImportDeclaration") continue;
    const source = staticSource(stmt);
    if (source === null) continue;
    for (const spec of (stmt.specifiers as AstNode[] | undefined) ?? []) {
      if (spec.type !== "ImportSpecifier") continue;
      const imported = spec.imported;
      const importedName =
        imported?.type === "Identifier"
          ? (imported.name as string)
          : typeof imported?.value === "string"
            ? imported.value
            : null;
      const local = spec.local as AstNode | undefined;
      if (importedName === null || local?.type !== "Identifier") continue;
      bind(local, source, importedName);
    }
  }

  // `const { Pool } = require("pg")` — the destructuring form, the only require
  // shape that binds a factory to a name we can follow. Resolving the local
  // through the scope chain is what keeps a lazy `require` inside one function
  // from claiming every same-named binding in the file.
  for (const decl of collectDescendants(program, (n) => n.type === "VariableDeclarator", undefined, true)) {
    const init = decl.init as AstNode | undefined;
    if (init?.type !== "CallExpression") continue;
    if (getCalleeName(init.callee as AstNode) !== "require") continue;
    const source = getStaticStringValue(((init.arguments as AstNode[] | undefined) ?? [])[0]);
    if (source === null) continue;
    const id = decl.id as AstNode | undefined;
    if (id?.type !== "ObjectPattern") continue;
    for (const prop of (id.properties as AstNode[] | undefined) ?? []) {
      if (prop.type !== "Property") continue;
      const key = prop.key as AstNode | undefined;
      const value = prop.value as AstNode | undefined;
      if (key?.type !== "Identifier" || value?.type !== "Identifier") continue;
      bind(value, source, key.name as string);
    }
  }

  return factories;
};

/**
 * Bindings whose value provably came from a contract factory:
 * `const pool = new Pool()`, `const tracer = trace.getTracer("svc")`. The
 * factory identifier at the construction site must resolve to the IMPORT's
 * binding, not merely share its name.
 */
const collectReceiverBindings = (
  program: AstNode,
  scope: Scope,
  factories: Map<Binding, ResourceContract[]>,
): Map<Binding, ResourceContract[]> => {
  const receivers = new Map<Binding, ResourceContract[]>();
  if (factories.size === 0) return receivers;

  const add = (idNode: AstNode, contract: ResourceContract): void => {
    const binding = scope.getBinding(idNode.name as string, idNode);
    if (!binding) return;
    const list = receivers.get(binding);
    if (list) list.push(contract);
    else receivers.set(binding, [contract]);
  };

  for (const decl of collectDescendants(program, (n) => n.type === "VariableDeclarator", undefined, true)) {
    const id = decl.id as AstNode | undefined;
    if (id?.type !== "Identifier") continue;
    let init = decl.init as AstNode | undefined;
    if (init?.type === "AwaitExpression") init = init.argument as AstNode | undefined;
    if (!init) continue;

    // The factory reference, resolved at ITS OWN site.
    const factoryRef =
      init.type === "NewExpression"
        ? (init.callee as AstNode | undefined)
        : init.type === "CallExpression" && (init.callee as AstNode | undefined)?.type === "MemberExpression"
          ? ((init.callee as AstNode).object as AstNode | undefined)
          : undefined;
    if (factoryRef?.type !== "Identifier") continue;
    const factoryBinding = scope.resolveIdentifier(factoryRef);
    if (!factoryBinding) continue;

    const via = init.type === "NewExpression" ? "new" : "call";
    for (const contract of factories.get(factoryBinding) ?? []) {
      if (contract.factory.via === via) add(id, contract);
    }
  }

  return receivers;
};

/**
 * The subtree a binding lives in: the enclosing FUNCTION body (or the program).
 *
 * Not the nearest block. `var conn` acquired inside a `try` and released in the
 * matching `finally` lives in two sibling blocks, and a block-sized region saw
 * only the first — reporting the exact fix this rule recommends as a leak. A
 * function-sized region can only ever over-silence, which is the safe direction.
 */
const lifetimeRegion = (declarator: AstNode): AstNode | null => {
  let cur: AstNode | null | undefined = declarator.parent;
  let guard = 0;
  while (cur && guard++ < 128) {
    if (isFunctionLike(cur)) return (cur.body as AstNode | undefined) ?? null;
    if (cur.type === "Program" || cur.type === "StaticBlock") return cur;
    cur = cur.parent;
  }
  return null;
};

/**
 * Every Identifier in a region, grouped by name — built ONCE per region and
 * cached. Built per-declarator it was quadratic: a migration function with 250
 * checkouts rescanned its own body 250 times, and a large generated file took
 * 35 seconds.
 */
const identifiersByName = (region: AstNode, cache: Map<AstNode, Map<string, AstNode[]>>): Map<string, AstNode[]> => {
  const cached = cache.get(region);
  if (cached) return cached;
  const index = new Map<string, AstNode[]>();
  for (const node of collectDescendants(region, (n) => n.type === "Identifier", undefined, true)) {
    const name = node.name as string;
    const list = index.get(name);
    if (list) list.push(node);
    else index.set(name, [node]);
  }
  cache.set(region, index);
  return index;
};

/**
 * `using` / `await using` (TypeScript 5.2 explicit resource management) call the
 * disposer at scope exit as a language guarantee. There is nothing to add, and
 * saying otherwise would be false.
 */
const isExplicitlyManaged = (declarator: AstNode): boolean => {
  const declaration = declarator.parent as AstNode | undefined;
  const kind = declaration?.kind;
  return typeof kind === "string" && kind.endsWith("using");
};

export const noUnreleasedResource = defineDiagnostic({
  id: "no-unreleased-resource",
  title: "Acquired resource is never released",
  severity: "warn",
  category: "Reliability",
  confidence: "high",
  tags: ["resource-leak", "lifecycle", "reliability"],
  defaultEnabled: false,
  recommendation:
    "Release it in a `finally` so the error path cannot skip it: `const client = await pool.connect(); try { … } finally { client.release(); }`. A resource that is only released on the happy path is released until the first exception, and then never again.",
  create: (ctx) => {
    const scope = ctx.scope as unknown as Scope;
    const factories = collectFactoryBindings(ctx.program, scope);
    const receivers = collectReceiverBindings(ctx.program, scope, factories);
    const referenceCache = new Map<AstNode, Map<string, AstNode[]>>();

    return {
      VariableDeclarator: (node) => {
        if (receivers.size === 0) return;
        const id = node.id as AstNode | undefined;
        if (id?.type !== "Identifier") return;

        // `using` / `await using` disposes at scope exit by language rule.
        if (isExplicitlyManaged(node)) return;

        let init = node.init as AstNode | undefined;
        if (init?.type === "AwaitExpression") init = init.argument as AstNode | undefined;
        if (init?.type !== "CallExpression") return;

        // The acquire must be `<contractReceiver>.<contractAcquire>()`, where
        // the receiver RESOLVES to the binding that came from the import — not
        // one that merely shares its name.
        const callee = init.callee as AstNode | undefined;
        if (callee?.type !== "MemberExpression") return;
        const receiverNode = callee.object as AstNode | undefined;
        if (receiverNode?.type !== "Identifier") return;
        const method = getMethodName(init);
        if (method === null) return;

        const receiverBinding = scope.resolveIdentifier(receiverNode);
        if (!receiverBinding) return;
        const contract = (receivers.get(receiverBinding) ?? []).find((c) => c.acquire === method);
        if (!contract) return;

        // A resource acquired at module scope is meant to outlive the module
        // body. "You never released it" is precisely wrong there.
        const region = lifetimeRegion(node);
        if (!region || region.type === "Program") return;

        const name = id.name as string;

        // The acquired binding must resolve to THIS declaration everywhere it is
        // read — otherwise an inner shadow would be mistaken for the resource.
        // `declNode` for a variable binding is the declarator's *id* node
        // (scope.ts stores the pattern name, not the declarator).
        const binding = scope.getBinding(name, id);
        if (!binding || binding.declNode !== id) return;

        const refs = (identifiersByName(region, referenceCache).get(name) ?? []).filter((n) => n !== id);

        for (const ref of refs) {
          if (scope.getBinding(name, ref) !== binding) return; // shadowed — unprovable

          const parent = ref.parent as AstNode | undefined;

          if (contract.release.kind === "call") {
            // The acquired value IS the releaser. Calling it discharges the
            // resource; reaching for any property of it (`release.call(…)`,
            // `release.bind(…)`) is an indirect call this rule will not
            // second-guess. Both are silence.
            if (parent?.type === "CallExpression" && (parent.callee as AstNode) === ref) return;
            if (parent?.type === "MemberExpression" && (parent.object as AstNode) === ref) return;
            return; // anything else: the releaser was handed somewhere else
          }

          // WHITELIST: only `binding.<prop>` keeps the resource in view. Anything
          // else — returned, passed, stored, spread, captured — may be released
          // somewhere this rule cannot see, so it stays silent.
          if (parent?.type === "MemberExpression" && (parent.object as AstNode) === ref) {
            const property = getMethodName(parent);
            // A dynamic property (`client[key]()`) could be the release. An
            // unknown call is not evidence of a leak.
            if (property === null) return;
            if (property === contract.release.name) return; // released
            continue;
          }
          return; // escapes
        }

        // `pool.connect().release()` — released inline, never bound to a name we
        // would have had to follow.
        const chained = init.parent as AstNode | undefined;
        if (
          contract.release.kind === "method" &&
          chained?.type === "MemberExpression" &&
          (chained.object as AstNode) === init &&
          (chained.property as AstNode | undefined)?.name === contract.release.name
        ) {
          return;
        }

        const releaseText =
          contract.release.kind === "method" ? `${name}.${contract.release.name}()` : `${name}()`;
        ctx.report(
          init,
          `This ${contract.resource} is acquired and never released — \`${releaseText}\` appears nowhere in its scope. ${contract.consequence[0]!.toUpperCase()}${contract.consequence.slice(1)}. Release it in a \`finally\` so an exception cannot skip it.`,
        );
      },
    };
  },
});
