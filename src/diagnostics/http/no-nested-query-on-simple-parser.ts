import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import type { ProjectGraph } from "../../core/graph.ts";
import { REQUEST_ROOTS } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";

/**
 * A nested read off `req.query` on Express 5, whose default query parser no
 * longer builds nested objects. The property is `undefined`, silently.
 *
 *   ❌ const status = req.query.filter.status;   // ?filter[status]=open
 *   ✅ app.set("query parser", "extended");      // restores Express 4 behaviour
 *   ✅ const status = req.query["filter[status]"];
 *
 * Express 4's default parser was `extended` (qs); Express 5's is `simple`
 * (`node:querystring`). MEASURED against Express 5.2.1, serving
 * `?filter[status]=open&tags[]=a&tags[]=b`:
 *
 *   default                                → { "filter[status]": "open", "tags[]": ["a","b"] }
 *   app.set("query parser", "extended")    → { filter: { status: "open" }, tags: ["a","b"] }
 *   app.set("query parser", "simple")      → { "filter[status]": "open", "tags[]": ["a","b"] }
 *
 * So `req.query.filter.status` is `undefined` under the default, and `"open"`
 * once the parser is set back to `extended`. Nothing throws: the filter is simply
 * not applied, so the endpoint returns every row instead of the matching ones, or
 * an authorization narrowing quietly stops narrowing. That is a data-exposure
 * shape, not a 500, which is why it needs finding rather than waiting for.
 *
 * PROJECT SCOPE, because the setting and the read are never in the same file.
 * `app.set("query parser", …)` lives in the bootstrap; the nested read lives in a
 * controller. The rule walks every module in the graph for that call, and any
 * value other than the string `"simple"` — `"extended"`, a custom function, a
 * `qs` reference — silences the whole diagnostic for the project. Setting it
 * explicitly to `"simple"` is the one value that leaves it firing, and correctly:
 * that is the broken behaviour, opted into by name.
 *
 * PRECISION MODEL. Gated on `express:5`, because on Express 4 the default parser
 * IS `extended` and nested access works — reporting it there would be reporting
 * working code.
 *
 * The read must be `<requestRoot>.query.<a>.<b>` — two levels past `query` — and
 * `<b>` must not be a member that a **string or an array** already has. That
 * exclusion is what makes the rule sound, and it is not a guess: repeated keys
 * still produce arrays under the simple parser (`?ids=a&ids=b` →
 * `{ ids: ["a","b"] }`, measured), so `req.query.ids.length`,
 * `req.query.ids.map(…)` and `req.query.ids.includes(…)` all work, exactly as
 * `req.query.name.trim()` and `.toLowerCase()` do on the string case. The
 * excluded set is every own property name of `String.prototype`,
 * `Array.prototype` and `Object.prototype`, taken from the runtime rather than
 * written from memory.
 *
 * What is left is a read of a CUSTOM property off a value that the simple parser
 * can only have made a string or an array of strings — which is precisely the
 * nested-object assumption, and is always `undefined`.
 */

/**
 * Members a string or an array already has, so reading one is not evidence of a
 * nested-object assumption. Enumerated from `String.prototype`,
 * `Array.prototype` and `Object.prototype` at the runtime, not from memory.
 */
const BUILTIN_MEMBERS = new Set([
  "anchor", "at", "big", "blink", "bold", "charAt", "charCodeAt", "codePointAt", "concat",
  "constructor", "copyWithin", "endsWith", "entries", "every", "fill", "filter", "find",
  "findIndex", "findLast", "findLastIndex", "fixed", "flat", "flatMap", "fontcolor", "fontsize",
  "forEach", "hasOwnProperty", "includes", "indexOf", "isPrototypeOf", "isWellFormed", "italics",
  "join", "keys", "lastIndexOf", "length", "link", "localeCompare", "map", "match", "matchAll",
  "normalize", "padEnd", "padStart", "pop", "propertyIsEnumerable", "push", "reduce",
  "reduceRight", "repeat", "replace", "replaceAll", "reverse", "search", "shift", "slice",
  "small", "some", "sort", "splice", "split", "startsWith", "strike", "sub", "substr",
  "substring", "sup", "toLocaleLowerCase", "toLocaleString", "toLocaleUpperCase", "toLowerCase",
  "toReversed", "toSorted", "toSpliced", "toString", "toUpperCase", "toWellFormed", "trim",
  "trimEnd", "trimLeft", "trimRight", "trimStart", "unshift", "valueOf", "values", "with",
]);

/** Computed once per project graph — the walk is O(modules), not O(modules²). */
const parserConfigured = new WeakMap<ProjectGraph, boolean>();

/** Does any module set `query parser` to something other than "simple"? */
const projectSetsExtendedParser = (graph: ProjectGraph): boolean => {
  const cached = parserConfigured.get(graph);
  if (cached !== undefined) return cached;

  let configured = false;
  for (const facts of graph.modules.values()) {
    const calls = collectDescendants(facts.program, (n) => {
      if (n.type !== "CallExpression") return false;
      const callee = n.callee as AstNode | undefined;
      if (callee?.type !== "MemberExpression" || callee.computed) return false;
      const property = callee.property as AstNode | undefined;
      if (property?.type !== "Identifier" || String(property.name) !== "set") return false;
      const first = ((n.arguments as AstNode[] | undefined) ?? [])[0];
      return first?.type === "Literal" && first.value === "query parser";
    });
    for (const call of calls) {
      const value = ((call.arguments as AstNode[] | undefined) ?? [])[1];
      // Only the literal string "simple" leaves the default behaviour in place.
      // Everything else — "extended", a function, an identifier we cannot read —
      // is treated as configured, which resolves uncertainty to SILENCE.
      if (value?.type === "Literal" && value.value === "simple") continue;
      configured = true;
      break;
    }
    if (configured) break;
  }
  parserConfigured.set(graph, configured);
  return configured;
};

/** Is this `<requestRoot>.query`? */
const isRequestQuery = (node: AstNode | null | undefined): boolean => {
  if (!node || node.type !== "MemberExpression" || node.computed) return false;
  const object = node.object as AstNode | undefined;
  const property = node.property as AstNode | undefined;
  return (
    object?.type === "Identifier" &&
    REQUEST_ROOTS.has(String(object.name)) &&
    property?.type === "Identifier" &&
    String(property.name) === "query"
  );
};

export const noNestedQueryOnSimpleParser = defineDiagnostic({
  id: "no-nested-query-on-simple-parser",
  title: "Nested req.query read on Express 5, whose default parser does not build nested objects",
  severity: "error",
  category: "Bugs",
  confidence: "high",
  scope: "project",
  requires: ["express:5"],
  tags: ["express", "http", "migration"],
  recommendation:
    "Restore the Express 4 behaviour with `app.set(\"query parser\", \"extended\")`, or read the flat key the simple parser actually produces (`req.query[\"filter[status]\"]`). Express 5 changed the default query parser from `extended` (qs) to `simple` (node:querystring), so `?filter[status]=open` arrives as the key `\"filter[status]\"` and `req.query.filter` is undefined — measured on Express 5.2.1. Nothing throws; the filter is simply never applied.",
  create: (ctx) => ({
    Program: (root) => {
      if (!ctx.graph) return;
      if (projectSetsExtendedParser(ctx.graph)) return;

      for (const node of collectDescendants(root, (n) => n.type === "MemberExpression")) {
        // `<root>.query.<a>` sitting under a further member read.
        const inner = node.object as AstNode | undefined;
        if (!isRequestQuery(inner)) continue;
        if (node.computed) continue; // `req.query[k]` — the key is dynamic

        const first = node.property as AstNode | undefined;
        if (first?.type !== "Identifier") continue;

        const outer = node.parent as AstNode | undefined;
        if (outer?.type !== "MemberExpression" || outer.object !== node) continue;

        // A member a string or an array already has is not a nested-object read.
        const second = outer.property as AstNode | undefined;
        if (!outer.computed) {
          if (second?.type !== "Identifier") continue;
          if (BUILTIN_MEMBERS.has(String(second.name))) continue;
        } else if (second?.type !== "Literal" || typeof second.value !== "string") {
          continue; // `req.query.a[i]` — an index, which an array supports
        } else if (BUILTIN_MEMBERS.has(String(second.value))) {
          continue;
        }

        const key = String(first.name);
        const leaf = outer.computed ? String((second as AstNode).value) : String((second as AstNode).name);
        ctx.report(
          outer,
          `Express 5's default query parser is \`simple\`, not \`extended\`, so \`?${key}[${leaf}]=…\` arrives as the flat key \`"${key}[${leaf}]"\` and \`req.query.${key}\` is **undefined** — measured on Express 5.2.1. Nothing throws: the value silently reads as \`undefined\`, so the filter is never applied and the endpoint returns everything instead of the matching rows. Set \`app.set("query parser", "extended")\`, or read \`req.query["${key}[${leaf}]"]\`.`,
        );
      }
    },
  }),
});
