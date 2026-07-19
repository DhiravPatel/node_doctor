import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, rootObjectName, looksCallerControlled, findEnclosingFunction } from "../../core/ast.ts";
import { findDescendant } from "../../core/walk.ts";

/**
 * A filesystem path built from caller input without a containment check.
 * `path.join(UPLOAD_DIR, req.params.name)` looks scoped, but `join` happily
 * resolves `../../../etc/passwd` — it normalizes, it does not confine.
 *
 * ❌ const full = path.join("./uploads", req.params.name); res.sendFile(full);
 * ✅ const full = path.resolve(root, req.params.name);
 *    if (!full.startsWith(root + path.sep)) return res.status(400).end();
 * ✅ const full = path.join("./uploads", path.basename(req.params.name));
 */

const GUARD_METHODS = new Set(["startsWith", "relative", "realpath", "realpathSync", "basename", "isAbsolute"]);

const hasContainmentGuard = (scope: AstNode): boolean =>
  findDescendant(scope, (n) => {
    if (n.type !== "CallExpression") return false;
    const m = getMethodName(n);
    return !!m && GUARD_METHODS.has(m);
  }) !== null;

export const noPathTraversal = defineDiagnostic({
  id: "no-path-traversal",
  title: "Filesystem path built from caller input without containment",
  severity: "error",
  category: "Security",
  tags: ["fs", "injection"],
  recommendation:
    "Resolve against a root and enforce containment: `const full = path.resolve(root, name); if (!full.startsWith(root + path.sep)) reject;` — or strip traversal with `path.basename(name)`. `join`/`resolve` normalize but do not confine.",
  create: (ctx) => ({
    CallExpression: (node) => {
      const method = getMethodName(node);
      if (method !== "join" && method !== "resolve") return;
      const root = rootObjectName(node.callee);
      if (!root || !/path/i.test(root)) return;

      const callerControlled = (node.arguments as AstNode[]).some((a) =>
        looksCallerControlled(a, ctx.taintedBindings),
      );
      if (!callerControlled) return;

      const scope = findEnclosingFunction(node) ?? ctx.program;
      if (hasContainmentGuard(scope)) return;

      ctx.report(
        node,
        "A filesystem path is built from caller-controlled input with no containment check — `../` escapes the intended directory (path traversal).",
      );
    },
  }),
});
