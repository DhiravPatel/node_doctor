import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, getCalleeName, getStaticStringValue, getPropertyValue } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";

/**
 * §195 — a detached child the parent can never stop waiting for.
 *
 * THE BUG. `detached: true` puts the child in its own process group so it can
 * outlive the parent — but the parent's event loop still holds a reference to
 * it, so the parent **cannot exit** until the child does. A CLI that spawns a
 * detached background worker and then finishes its work simply hangs: no error,
 * no output, just a prompt that never comes back, and in CI a job that runs to
 * its timeout.
 *
 *   ❌ const child = spawn("node", ["worker.js"], { detached: true, stdio: "ignore" });
 *
 *   ✅ const child = spawn("node", ["worker.js"], { detached: true, stdio: "ignore" });
 *      child.unref();
 *
 * `detached` without `unref()` is the exact opposite of what the author meant:
 * they asked for a child that outlives the parent and got a parent that outlives
 * its own usefulness.
 *
 * PRECISION MODEL. The claim is "this handle is never unref'd", so every way it
 * could be is a silence:
 *
 *   - The spawn must be a `child_process` function PROVEN by import — `spawn`,
 *     `fork`, `execFile`. `spawn` is also a name in `cross-spawn`, in test
 *     helpers, and in userland process pools.
 *   - `detached` must be LITERALLY `true`. A variable, a config read, a ternary:
 *     any of them and the option is not provably set.
 *   - The result must be bound to a plain local. An unbound `spawn(...)` has no
 *     handle to unref and is a different shape.
 *   - `unref()` anywhere on that binding — in a callback, in a `finally`, on a
 *     later line, guarded by an `if` — is silence. Proving it runs on every path
 *     needs a control-flow graph this engine does not have; proving it is
 *     ABSENT needs nothing but syntax.
 *   - If the binding ESCAPES — returned, passed to a function, stored on an
 *     object — the unref may happen out of sight, and the rule says nothing.
 */

/** Module specifiers that provide the spawning functions. */
const CHILD_PROCESS_SOURCES = new Set(["child_process", "node:child_process"]);

/** Functions that return a long-lived ChildProcess handle. */
const SPAWNERS = new Set(["spawn", "fork", "execFile", "exec"]);

export const noDetachedChildWithoutUnref = defineDiagnostic({
  id: "no-detached-child-without-unref",
  title: "Detached child process is never unref'd, so the parent cannot exit",
  severity: "warn",
  category: "Reliability",
  confidence: "high",
  tags: ["lifecycle", "reliability", "async"],
  defaultEnabled: false,
  recommendation:
    "Call `child.unref()` after spawning. `detached: true` lets the child outlive the parent, but the parent's event loop still holds a reference to it — so the parent hangs until the child exits, which is the opposite of what detaching was for.",
  create: (ctx) => {
    /** Local names bound to a proven `child_process` spawner. */
    const spawners = new Set<string>();
    /** True when the module namespace is imported (`cp.spawn(...)`). */
    const namespaces = new Set<string>();

    for (const stmt of (ctx.program.body as AstNode[] | undefined) ?? []) {
      if (stmt.type !== "ImportDeclaration") continue;
      const source = stmt.source?.value;
      if (typeof source !== "string" || !CHILD_PROCESS_SOURCES.has(source)) continue;
      for (const spec of (stmt.specifiers as AstNode[] | undefined) ?? []) {
        const local = (spec.local as AstNode | undefined)?.name;
        if (typeof local !== "string") continue;
        if (spec.type === "ImportSpecifier") {
          const imported = spec.imported as AstNode | undefined;
          const name = imported?.type === "Identifier" ? (imported.name as string) : null;
          if (name !== null && SPAWNERS.has(name)) spawners.add(local);
        } else {
          namespaces.add(local);
        }
      }
    }

    // `const { spawn } = require("node:child_process")` / `const cp = require(...)`.
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
      if (source === null || !CHILD_PROCESS_SOURCES.has(source)) continue;
      const id = decl.id as AstNode | undefined;
      if (id?.type === "Identifier") {
        namespaces.add(id.name as string);
        continue;
      }
      if (id?.type !== "ObjectPattern") continue;
      for (const prop of (id.properties as AstNode[] | undefined) ?? []) {
        if (prop.type !== "Property") continue;
        const key = prop.key as AstNode | undefined;
        const local = prop.value as AstNode | undefined;
        if (key?.type !== "Identifier" || local?.type !== "Identifier") continue;
        if (SPAWNERS.has(key.name as string)) spawners.add(local.name as string);
      }
    }

    /** Is this call a proven `child_process` spawner? */
    const isSpawn = (call: AstNode): boolean => {
      const callee = call.callee as AstNode | undefined;
      if (callee?.type === "Identifier") return spawners.has(callee.name as string);
      if (callee?.type !== "MemberExpression") return false;
      const object = callee.object as AstNode | undefined;
      if (object?.type !== "Identifier" || !namespaces.has(object.name as string)) return false;
      const method = getMethodName(call);
      return method !== null && SPAWNERS.has(method);
    };

    return {
      VariableDeclarator: (node) => {
        if (spawners.size === 0 && namespaces.size === 0) return;
        const id = node.id as AstNode | undefined;
        if (id?.type !== "Identifier") return;
        let init = node.init as AstNode | undefined;
        if (init?.type === "AwaitExpression") init = init.argument as AstNode | undefined;
        if (init?.type !== "CallExpression" || !isSpawn(init)) return;

        // `detached` must be LITERALLY true. A variable or a config read is not
        // provably set, and guessing would flag a process that never detaches.
        const args = (init.arguments as AstNode[] | undefined) ?? [];
        const options = args.find((a) => a.type === "ObjectExpression");
        if (!options) return;
        const detached = getPropertyValue(options, "detached");
        if (!detached || detached.type !== "Literal" || detached.value !== true) return;

        // A spread AFTER the key overwrites it — `{ detached: true, ...opts }`
        // is `false` whenever `opts` says so, and the option is no longer
        // proven. A spread BEFORE it is harmless: the literal wins.
        const properties = (options.properties as AstNode[] | undefined) ?? [];
        const detachedIndex = properties.findIndex((prop) => (prop.value as AstNode | undefined) === detached);
        if (properties.some((prop, i) => prop.type === "SpreadElement" && i > detachedIndex)) return;

        // Search the enclosing function body — or the module — for any use of
        // the binding. `unref()` anywhere is silence; an escape is silence too.
        let region: AstNode | null | undefined = node.parent;
        let guard = 0;
        while (region && guard++ < 64) {
          if (region.type === "BlockStatement" || region.type === "Program") break;
          region = region.parent;
        }
        if (!region) return;

        const name = id.name as string;
        for (const ref of collectDescendants(
          region,
          (n) => n.type === "Identifier" && n.name === name && n !== id,
          undefined,
          true,
        )) {
          const parent = ref.parent as AstNode | undefined;
          if (parent?.type === "MemberExpression" && (parent.object as AstNode) === ref) {
            const property = getMethodName(parent);
            // A dynamic member could be the unref, and an explicit one settles it.
            if (property === null || property === "unref") return;
            continue;
          }
          // Returned, passed, stored, aliased: the unref may be out of sight.
          return;
        }

        ctx.report(
          init,
          `\`detached: true\` is set but \`${name}.unref()\` is never called, so the parent's event loop still holds a reference to the child — the parent cannot exit until the child does, which is the opposite of what detaching was for.`,
        );
      },
    };
  },
});
