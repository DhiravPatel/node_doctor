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
  kind: "module" | "function";
  node: AstNode;
  parent: Scope | null;
  bindings: Map<string, Binding>;
}

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

const isScopeNode = (node: AstNode): boolean =>
  node.type === "Program" || FUNCTION_TYPES.has(node.type);

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

  constructor(program: AstNode) {
    this.moduleScope = { kind: "module", node: program, parent: null, bindings: new Map() };
    this.scopes.set(program, this.moduleScope);
    this.build(program);
  }

  private build(program: AstNode): void {
    // Pass 1: create a Scope for every function; wire parents.
    walk(program, {
      enter: (node, parent) => {
        if (FUNCTION_TYPES.has(node.type)) {
          const parentScope = this.enclosingScope(parent);
          this.scopes.set(node, {
            kind: "function",
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
                  scopeKind: target.kind,
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
                scopeKind: target.kind,
              });
            }
            this.defineParams(node);
            break;
          }
          case "FunctionExpression":
          case "ArrowFunctionExpression":
            this.defineParams(node);
            break;
          case "ClassDeclaration": {
            if (node.id?.type === "Identifier") {
              const target = this.enclosingScope(node.parent);
              this.define(target, {
                name: node.id.name,
                kind: "class",
                declNode: node,
                initNode: node,
                scopeKind: target.kind,
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

  /** The nearest scope that owns `node` (walking up through parents). */
  private enclosingScope(node: AstNode | null | undefined): Scope {
    let cur: AstNode | null | undefined = node;
    while (cur) {
      if (isScopeNode(cur)) {
        const scope = this.scopes.get(cur);
        if (scope) return scope;
      }
      cur = cur.parent;
    }
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
