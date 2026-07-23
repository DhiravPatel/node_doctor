/**
 * Shared recognition for hapi route-config objects.
 *
 * Not a diagnostic — just the shape-matching the two hapi diagnostics agree on.
 * Everything here is deliberately conservative: any construct it cannot resolve
 * statically is reported as unknown so the caller stays silent.
 */

import type { AstNode } from "../../core/types.ts";
import {
  getMethodName,
  getObjectProperty,
  getPropertyValue,
  getStaticStringValue,
} from "../../core/ast.ts";

/** True when an object literal carries a spread — its full key set is unknowable. */
export const hasSpreadProperty = (obj: AstNode | null | undefined): boolean =>
  !!obj &&
  obj.type === "ObjectExpression" &&
  Array.isArray(obj.properties) &&
  (obj.properties as AstNode[]).some(
    (p) => p.type === "SpreadElement" || p.type === "ExperimentalSpreadProperty",
  );

/**
 * The route options container, which hapi accepts under `options` (v17+) or the
 * legacy `config` key (v16). `opaque` means the key exists but is not a plain
 * object literal (a factory function, a shared constant, a spread) — callers
 * must treat that as "might contain anything" and stay silent.
 */
export type RouteOptions =
  | { kind: "absent" }
  | { kind: "opaque" }
  | { kind: "object"; node: AstNode };

export const hapiRouteOptions = (route: AstNode): RouteOptions => {
  for (const key of ["options", "config"]) {
    const value = getPropertyValue(route, key);
    if (!value) continue;
    if (value.type !== "ObjectExpression") return { kind: "opaque" };
    if (hasSpreadProperty(value)) return { kind: "opaque" };
    return { kind: "object", node: value };
  }
  return { kind: "absent" };
};

/**
 * Is this object literal unmistakably a hapi route config? It must carry both
 * `method` and `path` (fastify's route object uses `url`, so this never
 * confuses the two) plus a `handler` on the route or inside its options.
 */
const isHapiRouteObject = (node: AstNode | null | undefined): boolean => {
  if (!node || node.type !== "ObjectExpression") return false;
  if (hasSpreadProperty(node)) return false; // a spread could supply anything
  if (!getObjectProperty(node, "method")) return false;
  if (!getObjectProperty(node, "path")) return false;
  if (getObjectProperty(node, "handler")) return true;
  const options = hapiRouteOptions(node);
  return options.kind === "object" && !!getObjectProperty(options.node, "handler");
};

/**
 * The route-config object literals passed to a `.route(...)` call, covering both
 * `server.route({...})` and `server.route([{...}, {...}])`. An identifier
 * argument (`server.route(routes)`) resolves to nothing — the routes live
 * elsewhere and guessing about them would be a false positive.
 */
export const hapiRouteObjects = (node: AstNode): AstNode[] => {
  if (getMethodName(node) !== "route") return [];
  const args = (node.arguments as AstNode[]) ?? [];
  const first = args[0];
  if (!first) return [];
  const candidates: AstNode[] =
    first.type === "ArrayExpression"
      ? ((first.elements as AstNode[]) ?? []).filter((e): e is AstNode => !!e)
      : [first];
  return candidates.filter(isHapiRouteObject);
};

/**
 * The uppercased HTTP methods a route declares, or null when they are not
 * statically knowable (an identifier, a computed value, or hapi's `"*"`
 * wildcard, which also matches GET).
 */
export const hapiRouteMethods = (route: AstNode): string[] | null => {
  const value = getPropertyValue(route, "method");
  if (!value) return null;
  const single = getStaticStringValue(value);
  if (single !== null) return [single.toUpperCase()];
  if (value.type === "ArrayExpression") {
    const out: string[] = [];
    for (const element of (value.elements as AstNode[]) ?? []) {
      const text = element ? getStaticStringValue(element) : null;
      if (text === null) return null; // one unresolvable entry poisons the set
      out.push(text.toUpperCase());
    }
    return out.length > 0 ? out : null;
  }
  return null;
};

/** The route's static path string, or null when it is built dynamically. */
export const hapiRoutePath = (route: AstNode): string | null =>
  getStaticStringValue(getPropertyValue(route, "path"));
