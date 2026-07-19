/**
 * Shared AST helpers. These are the primitives diagnostics reach for constantly:
 * callee resolution, enclosing-function lookup, discard detection, template and
 * concatenation checks, and the caller-controlled predicate.
 *
 * Everything here is pure and tolerant of partial/odd input (a parse gap must
 * never make a helper throw).
 */

import type { AstNode } from "./types.ts";
import { findDescendant } from "./walk.ts";

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

/** Roots whose descendants are treated as caller-controlled. */
export const REQUEST_ROOTS = new Set(["req", "request", "ctx", "context", "event"]);

/** Is this node any kind of function? (A MethodDefinition wraps one in `.value`.) */
export const isFunctionLike = (node: AstNode | null | undefined): boolean =>
  !!node && FUNCTION_TYPES.has(node.type);

/** Unwrap an optional-chaining `ChainExpression` to its inner expression. */
export const unwrapChain = (node: AstNode | null | undefined): AstNode | null => {
  if (!node) return null;
  return node.type === "ChainExpression" ? node.expression : node;
};

/**
 * The dotted static path of a member/identifier expression rooted at an
 * Identifier or `this` (e.g. `res.json` → "res.json", `this.db.query` →
 * "this.db.query"). Returns null if any link is dynamic/computed-non-literal or
 * the root is not a plain identifier/this.
 */
export const staticMemberPath = (node: AstNode | null | undefined): string | null => {
  const n = unwrapChain(node);
  if (!n) return null;
  if (n.type === "Identifier") return n.name;
  if (n.type === "ThisExpression") return "this";
  if (n.type === "MemberExpression") {
    const base = staticMemberPath(n.object);
    if (base === null) return null;
    if (n.computed) {
      const key = n.property;
      if (key && key.type === "Literal" && typeof key.value === "string") {
        return `${base}.${key.value}`;
      }
      return null;
    }
    if (n.property && n.property.type === "Identifier") {
      return `${base}.${n.property.name}`;
    }
    return null;
  }
  return null;
};

/**
 * The fully-dotted callee of a call/new expression (e.g. `db.$queryRawUnsafe`),
 * or null if not fully static. Accepts a Call/New node or a bare callee node.
 */
export const getCalleeName = (node: AstNode | null | undefined): string | null => {
  if (!node) return null;
  const callee =
    node.type === "CallExpression" || node.type === "NewExpression" ? node.callee : node;
  return staticMemberPath(callee);
};

/**
 * The last segment of a call's callee — the "method name". Accepts a Call/New
 * node, a MemberExpression, or an Identifier. Resolves through optional chaining
 * and string-literal computed access.
 */
export const getMethodName = (node: AstNode | null | undefined): string | null => {
  if (!node) return null;
  let target = node;
  if (target.type === "CallExpression" || target.type === "NewExpression") {
    target = target.callee;
  }
  target = unwrapChain(target)!;
  if (!target) return null;
  if (target.type === "MemberExpression") {
    if (!target.computed && target.property?.type === "Identifier") return target.property.name;
    if (target.computed && target.property?.type === "Literal" && typeof target.property.value === "string") {
      return target.property.value;
    }
    return null;
  }
  if (target.type === "Identifier") return target.name;
  return null;
};

/** The immediate receiver object of a member call, as a dotted path (or null). */
export const getReceiverName = (node: AstNode | null | undefined): string | null => {
  if (!node) return null;
  let target = node;
  if (target.type === "CallExpression" || target.type === "NewExpression") {
    target = target.callee;
  }
  target = unwrapChain(target)!;
  if (target?.type === "MemberExpression") return staticMemberPath(target.object);
  return null;
};

/** Walk up parent links to the nearest ancestor matching `predicate`. */
export const findAncestor = (
  node: AstNode | null | undefined,
  predicate: (n: AstNode) => boolean,
): AstNode | null => {
  let cur = node?.parent ?? null;
  while (cur) {
    if (predicate(cur)) return cur;
    cur = cur.parent ?? null;
  }
  return null;
};

/** The nearest enclosing function (of any kind), or null at module scope. */
export const findEnclosingFunction = (node: AstNode | null | undefined): AstNode | null =>
  findAncestor(node, isFunctionLike);

/** Is a call/expression's result thrown away (an expression statement)? */
export const isResultDiscarded = (node: AstNode): boolean => {
  let cur: AstNode | null = node;
  let parent: AstNode | null | undefined = node.parent;
  while (parent) {
    switch (parent.type) {
      case "ExpressionStatement":
        return true;
      case "AwaitExpression":
      case "ChainExpression":
        cur = parent;
        parent = parent.parent;
        continue;
      case "SequenceExpression": {
        // Only the final expression's value is used; earlier ones are discarded.
        const exprs = parent.expressions as AstNode[];
        if (exprs[exprs.length - 1] === cur) {
          cur = parent;
          parent = parent.parent;
          continue;
        }
        return true;
      }
      default:
        return false;
    }
  }
  return false;
};

/** Does `fn`'s own body contain an `await` (not counting nested functions)? */
export const containsOwnAwait = (fn: AstNode): boolean => {
  const body = fn.body ?? fn;
  const isAwait = (n: AstNode): boolean =>
    n.type === "AwaitExpression" || (n.type === "ForOfStatement" && !!n.await);
  // Test the body node itself too — an arrow's expression body may *be* the await.
  return isAwait(body) || findDescendant(body, isAwait, isFunctionLike) !== null;
};

/** Does `fn`'s own body contain a `try` (not counting nested functions)? */
export const containsTryStatement = (fn: AstNode): boolean => {
  const body = fn.body ?? fn;
  return body.type === "TryStatement" || findDescendant(body, (n) => n.type === "TryStatement", isFunctionLike) !== null;
};

/** Does a TemplateLiteral interpolate any expressions? */
export const hasInterpolation = (node: AstNode | null | undefined): boolean =>
  !!node && node.type === "TemplateLiteral" && Array.isArray(node.expressions) && node.expressions.length > 0;

/** A `+` binary/concatenation where at least one operand is not a literal. */
export const isStringConcatWithVariable = (node: AstNode | null | undefined): boolean => {
  if (!node || node.type !== "BinaryExpression" || node.operator !== "+") return false;
  const nonLiteral = (side: AstNode): boolean => {
    if (side.type === "BinaryExpression" && side.operator === "+") {
      return isStringConcatWithVariable(side) || nonLiteral(side.left) || nonLiteral(side.right);
    }
    return side.type !== "Literal";
  };
  return nonLiteral(node.left) || nonLiteral(node.right);
};

/** The static string value of a node, or null if not statically a string. */
export const getStaticStringValue = (node: AstNode | null | undefined): string | null => {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0 && node.quasis.length === 1) {
    return node.quasis[0].value.cooked ?? node.quasis[0].value.raw ?? null;
  }
  return null;
};

/** Is `node` a boolean/`true` literal? */
export const isLiteralTrue = (node: AstNode | null | undefined): boolean =>
  !!node && node.type === "Literal" && node.value === true;

/** Find a property in an ObjectExpression by key name (Identifier or string). */
export const getObjectProperty = (
  obj: AstNode | null | undefined,
  name: string,
): AstNode | null => {
  if (!obj || obj.type !== "ObjectExpression") return null;
  for (const prop of obj.properties as AstNode[]) {
    if (prop.type !== "Property") continue;
    const key = prop.key;
    if (!prop.computed && key?.type === "Identifier" && key.name === name) return prop;
    if (key?.type === "Literal" && key.value === name) return prop;
  }
  return null;
};

/** The value node of an ObjectExpression property, or null. */
export const getPropertyValue = (
  obj: AstNode | null | undefined,
  name: string,
): AstNode | null => {
  const prop = getObjectProperty(obj, name);
  return prop ? (prop.value as AstNode) : null;
};

/**
 * Does the subtree at `node` reference caller-controlled data — a tainted
 * binding or a request root (`req`, `ctx`, …)? Used to *sharpen* messages; it
 * must never gate an injection finding.
 */
export const looksCallerControlled = (
  node: AstNode | null | undefined,
  tainted: Set<string>,
): boolean => {
  if (!node) return false;
  const isTaintedIdent = (n: AstNode): boolean =>
    n.type === "Identifier" && (tainted.has(n.name) || REQUEST_ROOTS.has(n.name));
  if (isTaintedIdent(node)) return true;
  return findDescendant(node, isTaintedIdent, isFunctionLike) !== null;
};

/** The name of a binding target (Identifier) if simple, else null. */
export const bindingName = (node: AstNode | null | undefined): string | null =>
  node && node.type === "Identifier" ? node.name : null;

/**
 * The base identifier/`this` name at the root of a member/call chain
 * (`res.status(400).json` → "res", `this.db.q()` → "this"), or null.
 */
export const rootObjectName = (node: AstNode | null | undefined): string | null => {
  let cur: AstNode | null | undefined = node;
  while (cur) {
    switch (cur.type) {
      case "Identifier":
        return cur.name;
      case "ThisExpression":
        return "this";
      case "MemberExpression":
        cur = cur.object;
        break;
      case "CallExpression":
      case "NewExpression":
        cur = cur.callee;
        break;
      case "ChainExpression":
        cur = cur.expression;
        break;
      default:
        return null;
    }
  }
  return null;
};

/** Nearest enclosing statement that owns `node` (for "is there code after" checks). */
export const enclosingStatement = (node: AstNode): AstNode | null =>
  findAncestor(node, (n) => typeof n.type === "string" && n.type.endsWith("Statement"));
