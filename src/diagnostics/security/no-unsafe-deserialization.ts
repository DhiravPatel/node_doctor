import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, getCalleeName, rootObjectName, looksCallerControlled } from "../../core/ast.ts";

/**
 * Deserializing caller-controlled data with a deserializer that can execute code
 * or instantiate arbitrary types. `node-serialize`'s `unserialize` runs embedded
 * `$$ND_FUNC$$` functions (RCE by design); a legacy `js-yaml` `load` without the
 * safe schema instantiates arbitrary tags.
 *
 * ❌ const obj = unserialize(req.body.data);          // node-serialize RCE
 * ❌ const cfg = yaml.load(req.body.yaml);            // legacy js-yaml: arbitrary tags
 * ✅ const obj = JSON.parse(req.body.data);           // data only, no code
 * ✅ const cfg = yaml.load(input, { schema: yaml.JSON_SCHEMA }); // js-yaml >= 4 load is safe
 */

/** `unserialize`/`deserialize` from a serialization library (node-serialize, funcster). */
const isCodeDeserializer = (call: AstNode): boolean => {
  const method = getMethodName(call);
  const callee = getCalleeName(call);
  const name = method ?? callee ?? "";
  return /^(un|de)serialize$/i.test(name) || name.toLowerCase() === "deepdeserialize";
};

/** `yaml.load(...)` / `yaml.loadAll(...)` on a yaml-ish receiver. */
const isYamlLoad = (call: AstNode): boolean => {
  const method = getMethodName(call);
  if (method !== "load" && method !== "loadAll") return false;
  const root = rootObjectName(call.callee);
  return !!root && /ya?ml/i.test(root);
};

export const noUnsafeDeserialization = defineDiagnostic({
  id: "no-unsafe-deserialization",
  title: "Unsafe deserialization of caller-controlled data",
  severity: "error",
  category: "Security",
  tags: ["injection", "deserialization"],
  recommendation:
    "Never deserialize untrusted input with a code-executing deserializer. Use `JSON.parse` for data; for YAML use `js-yaml` v4+ `load` (safe by default) or pass `{ schema: JSON_SCHEMA }`. Drop `node-serialize`/`funcster` `unserialize` on request data entirely.",
  create: (ctx) => ({
    CallExpression: (node) => {
      const arg = (node.arguments as AstNode[] | undefined)?.[0];
      if (!arg) return;
      if (!isCodeDeserializer(node) && !isYamlLoad(node)) return;
      // Precision: only when the payload is caller-controlled.
      if (!looksCallerControlled(arg, ctx.taintedBindings)) return;
      ctx.report(
        node,
        "Caller-controlled data is deserialized by a code-executing deserializer — an attacker-crafted payload can run code or instantiate arbitrary objects.",
      );
    },
  }),
});
