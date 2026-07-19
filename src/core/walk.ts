/**
 * ESTree traversal with parent-link attachment and enter/`:exit` dispatch.
 *
 * The walker is generic: it discovers child nodes structurally (any
 * array-of-nodes or node-valued property) so it never needs a hand-written
 * visitor-keys table and stays correct as the parser's node set grows.
 */

import type { AstNode } from "./types.ts";

/** Keys that are never child AST nodes. `parent` is our own back-link. */
const NON_CHILD_KEYS = new Set(["parent", "type", "start", "end", "range", "loc"]);

const isNode = (value: unknown): value is AstNode =>
  value !== null && typeof value === "object" && typeof (value as AstNode).type === "string";

/** Yield the direct child AST nodes of `node`, in property order. */
export function* childNodes(node: AstNode): Generator<AstNode> {
  for (const key in node) {
    if (NON_CHILD_KEYS.has(key)) continue;
    const value = node[key];
    if (value === null || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isNode(item)) yield item;
      }
    } else if (isNode(value)) {
      yield value;
    }
  }
}

/**
 * Attach `parent` back-links to every node under `root` (root.parent = null).
 * Idempotent. Runs before taint and diagnostic execution.
 */
export const attachParents = (root: AstNode): void => {
  const stack: Array<[AstNode, AstNode | null]> = [[root, null]];
  while (stack.length > 0) {
    const [node, parent] = stack.pop()!;
    node.parent = parent;
    for (const child of childNodes(node)) {
      stack.push([child, node]);
    }
  }
};

export interface WalkVisitor {
  enter?: (node: AstNode, parent: AstNode | null) => void;
  exit?: (node: AstNode, parent: AstNode | null) => void;
}

interface Frame {
  node: AstNode;
  parent: AstNode | null;
  entered: boolean;
  children: AstNode[] | null;
  index: number;
}

/**
 * Depth-first traversal dispatching `enter` (pre-order) and `exit` (post-order),
 * attaching parent links as it goes. The recursion is an explicit array stack so
 * deeply nested inputs cannot blow the native call stack.
 */
export const walk = (root: AstNode, visitor: WalkVisitor): void => {
  const enter = visitor.enter;
  const exit = visitor.exit;
  const stack: Frame[] = [{ node: root, parent: null, entered: false, children: null, index: 0 }];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (!frame.entered) {
      frame.entered = true;
      frame.node.parent = frame.parent;
      if (enter) enter(frame.node, frame.parent);
      frame.children = [...childNodes(frame.node)];
    }
    if (frame.index < frame.children!.length) {
      const child = frame.children![frame.index++]!;
      stack.push({ node: child, parent: frame.node, entered: false, children: null, index: 0 });
    } else {
      if (exit) exit(frame.node, frame.parent);
      stack.pop();
    }
  }
};

/**
 * Find the first descendant of `node` for which `predicate` is true, without
 * descending into any subtree for which `skip` is true. The starting node is
 * not tested.
 */
export const findDescendant = (
  node: AstNode,
  predicate: (n: AstNode) => boolean,
  skip?: (n: AstNode) => boolean,
): AstNode | null => {
  const stack: AstNode[] = [...childNodes(node)];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (predicate(current)) return current;
    if (skip && skip(current)) continue; // prune subtree, keep siblings
    for (const child of childNodes(current)) stack.push(child);
  }
  return null;
};

/**
 * Collect every descendant (and optionally the node itself) matching a
 * predicate, pruning `skip` subtrees. Pre-order, deterministic.
 */
export const collectDescendants = (
  node: AstNode,
  predicate: (n: AstNode) => boolean,
  skip?: (n: AstNode) => boolean,
  includeSelf = false,
): AstNode[] => {
  const out: AstNode[] = [];
  const visit = (n: AstNode): void => {
    if (predicate(n)) out.push(n);
    if (skip && skip(n)) return;
    for (const child of childNodes(n)) visit(child);
  };
  if (includeSelf && predicate(node)) out.push(node);
  for (const child of childNodes(node)) visit(child);
  return out;
};
