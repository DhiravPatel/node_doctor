/**
 * Interprocedural taint (§56) — the sound version of the intra-file heuristic.
 *
 * `computeTaint` only sees one file, so it misses the shape real code actually
 * takes: a handler receives `req`, passes `req.body.name` to a service in another
 * module, which passes it to a repository, which interpolates it into SQL. Every
 * file looks innocent on its own.
 *
 * This walks the project call graph forward from every request handler, carrying
 * taint across call boundaries by *argument position*: if a tainted value is
 * passed as argument 2, the callee's second parameter becomes tainted, and the
 * process repeats into that function's own calls. The result is, for every
 * function, which of its parameters carry caller-controlled data — and the hop
 * trail that got them there, so a finding can explain the whole path.
 *
 * Deliberately conservative (sound toward silence): taint only crosses an edge
 * the graph can resolve to a concrete function. An unresolvable dynamic call
 * simply stops propagation rather than guessing.
 */

import type { AstNode } from "./types.ts";
import type { ProjectGraph } from "./graph.ts";
import { REQUEST_ROOTS, isFunctionLike, getMethodName, getCalleeName, hasInterpolation, isStringConcatWithVariable } from "./ast.ts";
import { SHELL_EXEC, QUERY_METHODS } from "./signals.ts";
import { looksLikeExpressHandler } from "./request-path.ts";
import { walk, findDescendant } from "./walk.ts";

/** Bound names in a parameter pattern (identifier, default, rest, array, object). */
const patternNames = (pattern: AstNode | null | undefined, out: string[]): void => {
  if (!pattern) return;
  switch (pattern.type) {
    case "Identifier":
      out.push(pattern.name as string);
      break;
    case "AssignmentPattern":
      patternNames(pattern.left as AstNode, out);
      break;
    case "RestElement":
      patternNames(pattern.argument as AstNode, out);
      break;
    case "ArrayPattern":
      for (const el of (pattern.elements as (AstNode | null)[]) ?? []) patternNames(el, out);
      break;
    case "ObjectPattern":
      for (const prop of (pattern.properties as AstNode[]) ?? []) {
        if (prop.type === "RestElement") patternNames(prop.argument as AstNode, out);
        else patternNames(prop.value as AstNode, out);
      }
      break;
    default:
      break;
  }
};

/** The names bound by parameter `index`, or [] when there is no such parameter. */
const paramNamesAt = (fn: AstNode, index: number): string[] => {
  const params = (fn.params as AstNode[]) ?? [];
  const p = params[index];
  if (!p) return [];
  const out: string[] = [];
  patternNames(p, out);
  return out;
};

export interface InterproceduralTaint {
  /** Function node → the names of its parameters that carry caller data. */
  taintedParams: Map<AstNode, Set<string>>;
  /** Function node → the hop trail (handler → … → this function). */
  pathTo: Map<AstNode, string[]>;
}

/** An injection sink inside a helper, fed by caller data through the call graph. */
export interface TaintedSinkSite {
  filePath: string;
  normalizedFilePath: string;
  /** The sink call node — from the graph's AST, reported by offset. */
  node: AstNode;
  kind: "eval" | "shell" | "sql";
  /** Hop trail: handler → … → the helper holding the sink. */
  via: string[];
}

/** A readable label for a function, for the hop trail in a message. */
const labelOf = (fn: AstNode, file: string): string => {
  const name =
    (fn.id && (fn.id as AstNode).type === "Identifier" && ((fn.id as AstNode).name as string)) ||
    (fn.parent?.type === "VariableDeclarator" &&
      fn.parent.id?.type === "Identifier" &&
      (fn.parent.id.name as string)) ||
    (fn.parent?.type === "Property" && fn.parent.key?.type === "Identifier" && (fn.parent.key.name as string)) ||
    "<anonymous>";
  const short = file.split("/").slice(-1)[0] ?? file;
  return `${short}:${name}`;
};

/** Bound to the seeding rule below so handlers and propagation agree. */
const seedHandlerTaint = (handler: AstNode): Set<string> => {
  const tainted = new Set<string>();
  const params = (handler.params as AstNode[]) ?? [];
  // Any parameter *named* like a request root is the request object.
  params.forEach((p) => {
    const names: string[] = [];
    patternNames(p, names);
    for (const n of names) if (REQUEST_ROOTS.has(n)) tainted.add(n);
  });
  // An (req, res)-shaped handler taints parameter 0 whatever it is called.
  if (tainted.size === 0 && looksLikeExpressHandler(handler)) {
    for (const n of paramNamesAt(handler, 0)) tainted.add(n);
  }
  return tainted;
};

const MAX_DEPTH = 12;

/**
 * Propagate taint forward from every request handler across resolved call edges.
 * Returns, per function, which parameters carry caller-controlled data.
 */
export const computeInterproceduralTaint = (graph: ProjectGraph): InterproceduralTaint => {
  const taintedParams = new Map<AstNode, Set<string>>();
  const pathTo = new Map<AstNode, string[]>();

  // Which module does each function live in? (needed to resolve its calls)
  const fnFile = new Map<AstNode, string>();
  for (const facts of graph.modules.values()) {
    walk(facts.program, {
      enter: (node) => {
        if (isFunctionLike(node)) fnFile.set(node, facts.filePath);
      },
    });
  }

  interface Task {
    fn: AstNode;
    depth: number;
  }
  const queue: Task[] = [];

  // Seed from every request handler.
  for (const facts of graph.modules.values()) {
    for (const handler of facts.handlers) {
      const seeded = seedHandlerTaint(handler);
      if (seeded.size === 0) continue;
      taintedParams.set(handler, seeded);
      pathTo.set(handler, [labelOf(handler, facts.filePath)]);
      queue.push({ fn: handler, depth: 0 });
    }
  }

  while (queue.length > 0) {
    const { fn, depth } = queue.shift()!;
    if (depth >= MAX_DEPTH) continue;
    const file = fnFile.get(fn);
    if (!file) continue;
    const tainted = taintedParams.get(fn) ?? new Set<string>();

    // Is this expression carrying caller data, given what's tainted *here*?
    const carriesTaint = (expr: AstNode | null | undefined): boolean => {
      if (!expr) return false;
      const hit = (n: AstNode): boolean =>
        n.type === "Identifier" && (tainted.has(n.name as string) || REQUEST_ROOTS.has(n.name as string));
      // findDescendant does not test the root, so check it explicitly.
      return hit(expr) || findDescendant(expr, hit, isFunctionLike) !== null;
    };

    // Walk this function's own body (not nested functions — they propagate via
    // their own queue entry if they are ever called with tainted arguments).
    walk(fn.body ?? fn, {
      enter: (node) => {
        if (node.type !== "CallExpression") return;
        const callee = graph.resolveCallee(node, file);
        if (!callee) return;

        const args = (node.arguments as AstNode[]) ?? [];
        const incoming = new Set<string>();
        args.forEach((arg, i) => {
          if (!carriesTaint(arg)) return;
          for (const name of paramNamesAt(callee, i)) incoming.add(name);
        });
        if (incoming.size === 0) return;

        const existing = taintedParams.get(callee);
        const merged = new Set(existing ?? []);
        let grew = false;
        for (const n of incoming) {
          if (!merged.has(n)) {
            merged.add(n);
            grew = true;
          }
        }
        if (!grew) return;

        taintedParams.set(callee, merged);
        if (!pathTo.has(callee)) {
          const calleeFile = fnFile.get(callee) ?? file;
          pathTo.set(callee, [...(pathTo.get(fn) ?? []), labelOf(callee, calleeFile)]);
        }
        queue.push({ fn: callee, depth: depth + 1 });
      },
    });
  }

  return { taintedParams, pathTo };
};

/**
 * Every injection sink that caller data reaches through a helper. Computed on
 * the graph's own AST (Phase A) — Phase B re-parses each file, so a diagnostic
 * must report these nodes by offset rather than looking up its own AST nodes.
 */
export const collectTaintedSinkSites = (
  graph: ProjectGraph,
  taint: InterproceduralTaint,
): TaintedSinkSite[] => {
  const sites: TaintedSinkSite[] = [];
  const seen = new Set<AstNode>();

  const referencesAny = (expr: AstNode | null | undefined, names: Set<string>): boolean => {
    if (!expr || names.size === 0) return false;
    if (expr.type === "Identifier" && names.has(expr.name as string)) return true;
    return findDescendant(expr, (n) => n.type === "Identifier" && names.has(n.name as string), isFunctionLike) !== null;
  };

  // Deterministic: iterate modules in sorted path order, not Map insertion order.
  const files = [...graph.modules.keys()].sort();
  for (const file of files) {
    const facts = graph.modules.get(file)!;
    const fns: AstNode[] = [];
    walk(facts.program, {
      enter: (node) => {
        if (isFunctionLike(node)) fns.push(node);
      },
    });

    for (const fn of fns) {
      const tainted = taint.taintedParams.get(fn);
      if (!tainted || tainted.size === 0) continue;
      // A handler's own body is already covered by the intra-file diagnostics.
      if (facts.handlers.has(fn)) continue;
      const via = taint.pathTo.get(fn) ?? [];

      walk(fn.body ?? fn, {
        enter: (call) => {
          if (call.type !== "CallExpression" || seen.has(call)) return;
          const arg0 = ((call.arguments as AstNode[]) ?? [])[0];
          if (!arg0 || !referencesAny(arg0, tainted)) return;

          const method = getMethodName(call);
          const callee = getCalleeName(call);
          const name = method ?? callee ?? "";

          let kind: TaintedSinkSite["kind"] | null = null;
          if (callee === "eval" || callee === "Function") kind = "eval";
          else if (SHELL_EXEC.has(name)) kind = "shell";
          else if (method && QUERY_METHODS.has(method) && (hasInterpolation(arg0) || isStringConcatWithVariable(arg0))) {
            kind = "sql";
          }
          if (!kind) return;

          seen.add(call);
          sites.push({
            filePath: facts.filePath,
            normalizedFilePath: facts.normalizedFilePath,
            node: call,
            kind,
            via,
          });
        },
      });
    }
  }
  return sites;
};
