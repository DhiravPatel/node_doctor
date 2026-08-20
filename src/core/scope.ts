/**
 * A lightweight scope + binding resolver.
 *
 * It answers the two questions diagnostics actually ask: "where is this name bound?"
 * (so `no-unbounded-module-cache` can require *module* scope) and "what does
 * this name point at?" (alias resolution — `const db = new PrismaClient()`).
 *
 * It is intentionally not a full lexical-environment model: block-scoped
 * `let`/`const` are hoisted to their enclosing function/module scope. That
 * over-approximation can only *merge* bindings, never invent one, so it stays on
 * the precision-first side (§3.4).
 */

import type { AstNode } from "./types.ts";
import { walk } from "./walk.ts";

export type BindingKind =
  | "var"
  | "let"
  | "const"
  | "function"
  | "class"
  | "param"
  | "import";

export interface Binding {
  name: string;
  kind: BindingKind;
  /** The declarator/param/specifier node. */
  declNode: AstNode;
  /** The initializer expression, if any. */
  initNode: AstNode | null;
  scopeKind: "module" | "function";
}

interface Scope {
  kind: "module" | "function" | "catch";
  node: AstNode;
  parent: Scope | null;
  bindings: Map<string, Binding>;
}

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

// A `catch (e)` clause introduces its own block scope whose only binding is the
// caught parameter. Modelling it (rather than hoisting like `let`/`const`) is a
// *precision* fix, not a recall one: without it a `catch (id)` that shadows an
// outer `const id = …` resolves to the wrong, outer binding and every rule that
// asks "what does `id` point at?" is misled. Block-scoped `let`/`const` inside
// the catch body correctly land here too; a `var` that would hoist past it only
// loses recall (resolves to null → no finding), never precision.
const isScopeNode = (node: AstNode): boolean =>
  node.type === "Program" || node.type === "CatchClause" || FUNCTION_TYPES.has(node.type);

/** Collect the identifier names bound by a (possibly destructuring) pattern. */
const patternNames = (pattern: AstNode | null | undefined, out: [AstNode, string][]): void => {
  if (!pattern) return;
  switch (pattern.type) {
    case "Identifier":
      out.push([pattern, pattern.name]);
      break;
    case "AssignmentPattern":
      patternNames(pattern.left, out);
      break;
    case "RestElement":
      patternNames(pattern.argument, out);
      break;
    case "ArrayPattern":
      for (const el of pattern.elements as (AstNode | null)[]) patternNames(el, out);
      break;
    case "ObjectPattern":
      for (const prop of pattern.properties as AstNode[]) {
        if (prop.type === "RestElement") patternNames(prop.argument, out);
        else patternNames(prop.value, out);
      }
      break;
    default:
      break;
  }
};

export class ScopeResolver {
  readonly moduleScope: Scope;
  /** Map from a scope-owning node (Program/function) to its Scope. */
  private readonly scopes = new Map<AstNode, Scope>();
  /** node → its owning scope, memoized (see `enclosingScope`). */
  private readonly enclosingCache = new WeakMap<AstNode, Scope>();

  constructor(program: AstNode) {
    this.moduleScope = { kind: "module", node: program, parent: null, bindings: new Map() };
    this.scopes.set(program, this.moduleScope);
    this.build(program);
  }

  private build(program: AstNode): void {
    // Pass 1: create a Scope for every function and catch clause; wire parents.
    walk(program, {
      enter: (node, parent) => {
        if (FUNCTION_TYPES.has(node.type) || node.type === "CatchClause") {
          const parentScope = this.enclosingScope(parent);
          this.scopes.set(node, {
            kind: node.type === "CatchClause" ? "catch" : "function",
            node,
            parent: parentScope,
            bindings: new Map(),
          });
        }
      },
    });

    // Pass 2: place bindings in their owning scope.
    walk(program, {
      enter: (node) => {
        switch (node.type) {
          case "VariableDeclaration": {
            const kind = node.kind as BindingKind;
            for (const decl of node.declarations as AstNode[]) {
              const names: [AstNode, string][] = [];
              patternNames(decl.id, names);
              const target = this.enclosingScope(node);
              for (const [declNode, name] of names) {
                this.define(target, {
                  name,
                  kind,
                  declNode,
                  initNode: decl.init ?? null,
                  scopeKind: ScopeResolver.kindOf(target),
                });
              }
            }
            break;
          }
          case "FunctionDeclaration": {
            if (node.id?.type === "Identifier") {
              const target = this.enclosingScope(node.parent);
              this.define(target, {
                name: node.id.name,
                kind: "function",
                declNode: node,
                initNode: node,
                scopeKind: ScopeResolver.kindOf(target),
              });
            }
            this.defineParams(node);
            break;
          }
          case "FunctionExpression":
          case "ArrowFunctionExpression":
            this.defineParams(node);
            break;
          case "CatchClause": {
            // `catch (param)` — bind the caught value in the catch's own scope so
            // it shadows any like-named outer binding. `catch {}` (no binding)
            // simply has an empty scope.
            const scope = this.scopes.get(node);
            if (scope && node.param) {
              const names: [AstNode, string][] = [];
              patternNames(node.param, names);
              for (const [declNode, name] of names) {
                this.define(scope, { name, kind: "param", declNode, initNode: null, scopeKind: "function" });
              }
            }
            break;
          }
          case "ClassDeclaration": {
            if (node.id?.type === "Identifier") {
              const target = this.enclosingScope(node.parent);
              this.define(target, {
                name: node.id.name,
                kind: "class",
                declNode: node,
                initNode: node,
                scopeKind: ScopeResolver.kindOf(target),
              });
            }
            break;
          }
          case "ImportDeclaration": {
            for (const spec of node.specifiers as AstNode[]) {
              if (spec.local?.type === "Identifier") {
                this.define(this.moduleScope, {
                  name: spec.local.name,
                  kind: "import",
                  declNode: spec,
                  initNode: node,
                  scopeKind: "module",
                });
              }
            }
            break;
          }
          default:
            break;
        }
      },
    });
  }

  private defineParams(fn: AstNode): void {
    const scope = this.scopes.get(fn);
    if (!scope) return;
    for (const param of (fn.params as AstNode[]) ?? []) {
      const names: [AstNode, string][] = [];
      patternNames(param, names);
      for (const [declNode, name] of names) {
        this.define(scope, { name, kind: "param", declNode, initNode: null, scopeKind: "function" });
      }
    }
  }

  private define(scope: Scope, binding: Binding): void {
    if (!scope.bindings.has(binding.name)) scope.bindings.set(binding.name, binding);
  }

  /** A binding's `scopeKind` only distinguishes module from everything else. */
  private static kindOf(scope: Scope): "module" | "function" {
    return scope.kind === "module" ? "module" : "function";
  }

  /**
   * The nearest scope that owns `node` (walking up through parents).
   *
   * Memoized: scope-keyed taint asks this for every identifier on every
   * fixpoint round, and the parent walk is O(depth) each time. The cache is
   * keyed by node identity and the parent chain never changes after
   * `attachParents`, so it can only save work, never change an answer.
   */
  private enclosingScope(node: AstNode | null | undefined): Scope {
    if (!node) return this.moduleScope;
    const cached = this.enclosingCache.get(node);
    if (cached) return cached;
    let cur: AstNode | null | undefined = node;
    const seen: AstNode[] = [];
    while (cur) {
      if (isScopeNode(cur)) {
        const scope = this.scopes.get(cur);
        if (scope) {
          for (const n of seen) this.enclosingCache.set(n, scope);
          this.enclosingCache.set(cur, scope);
          return scope;
        }
      }
      seen.push(cur);
      cur = cur.parent;
    }
    for (const n of seen) this.enclosingCache.set(n, this.moduleScope);
    return this.moduleScope;
  }

  /** Resolve `name` as seen from `fromNode`, walking the scope chain up. */
  getBinding(name: string, fromNode: AstNode): Binding | null {
    let scope: Scope | null = this.enclosingScope(fromNode);
    while (scope) {
      const found = scope.bindings.get(name);
      if (found) return found;
      scope = scope.parent;
    }
    return null;
  }

  /** Resolve an Identifier reference node to its binding. */
  resolveIdentifier(idNode: AstNode): Binding | null {
    if (!idNode || idNode.type !== "Identifier") return null;
    return this.getBinding(idNode.name, idNode);
  }

  /** Is `name`, as seen from `fromNode`, bound at module scope? */
  isModuleScoped(name: string, fromNode: AstNode): boolean {
    const binding = this.getBinding(name, fromNode);
    return !!binding && binding.scopeKind === "module";
  }
}

/** Build a scope resolver for a parsed program. */
export const resolveScopes = (program: AstNode): ScopeResolver => new ScopeResolver(program);
