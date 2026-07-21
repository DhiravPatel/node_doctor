import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { looksCallerControlled } from "../../core/ast.ts";

/**
 * A write whose object key is caller-controlled, or a literal `__proto__` /
 * `constructor` / `prototype` write — the classic prototype-pollution vector.
 * If an attacker can make the key `"__proto__"`, `obj[key] = value` mutates
 * `Object.prototype` for the whole process.
 *
 * ❌ target[req.body.key] = req.body.value;      // attacker sets key="__proto__"
 * ❌ obj["__proto__"] = something;                // direct prototype write
 * ✅ if (key === "__proto__" || key === "constructor") return;
 *    target[key] = value;
 * ✅ const clean = Object.create(null); clean[key] = value;   // null-proto bag
 */

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** The static string key of a member expression, if any. */
const literalKey = (member: AstNode): string | null => {
  const prop = member.property;
  if (!member.computed && prop?.type === "Identifier") return prop.name;
  if (prop?.type === "Literal" && typeof prop.value === "string") return prop.value;
  return null;
};

export const noPrototypePollution = defineDiagnostic({
  id: "no-prototype-pollution",
  title: "Prototype pollution via caller-controlled object key",
  severity: "error",
  category: "Security",
  tags: ["injection", "prototype-pollution"],
  recommendation:
    "Reject the dangerous keys before writing (`if (key === '__proto__' || key === 'constructor' || key === 'prototype') return;`), use a `Map`, or store data on a `Object.create(null)` bag. Never write to an object with an unvalidated caller-supplied key.",
  create: (ctx) => ({
    AssignmentExpression: (node) => {
      const left = node.left as AstNode | undefined;
      if (!left || left.type !== "MemberExpression") return;

      // 1. Literal write to a prototype-chain key: obj.__proto__ = / obj["constructor"] =
      const key = literalKey(left);
      if (key && DANGEROUS_KEYS.has(key)) {
        ctx.report(left, `Writing to \`${key}\` mutates the prototype chain — this is a prototype-pollution sink.`);
        return;
      }

      // 2. Computed write whose key is caller-controlled: obj[userKey] = …
      if (left.computed && left.property) {
        const prop = left.property as AstNode;
        // Only flag dynamic (non-literal) keys — a literal key is handled above / is safe.
        const isDynamic = prop.type !== "Literal";
        if (isDynamic && looksCallerControlled(prop, ctx.taintedBindings)) {
          ctx.report(
            left,
            "Object key is caller-controlled — if it can be `\"__proto__\"` or `\"constructor\"`, this write pollutes the prototype chain.",
          );
        }
      }
    },
  }),
});
