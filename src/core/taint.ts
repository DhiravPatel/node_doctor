/**
 * A small intra-file taint pass.
 *
 * It propagates "this value came from the caller" from request-shaped roots
 * (`req`, `request`, `ctx`, `context`, `event`) through a few assignment hops to
 * a fixpoint. `const { name } = req.query` marks `name` tainted; `const id =
 * lookup(req.params.id)` marks `id` tainted.
 *
 * The result **sharpens messages** (an injection sink built from a tainted value
 * says "caller-controlled — this is injection"). It must never *gate* a finding:
 * an unsound analysis silencing a real sink would ship a false negative people
 * trust. See §3.4 / guardrail 3.
 *
 * ## Keyed by BINDING, not by name
 *
 * The set used to be a file-global `Set<string>` of NAMES, and
 * `looksCallerControlled` asked only "does this expression mention such a
 * name?". One tainted binding therefore contaminated every same-named binding
 * in the file — a `const state = …` local collided with a `state` destructured
 * from `request.query` in a DIFFERENT handler, and `no-open-redirect` reported
 * five error-severity false positives from it. One measured file had 908 of its
 * 2,232 distinct identifiers (41%) in the tainted set, including bare `user`,
 * `key`, `row`, `item` and `id`.
 *
 * Taint is now keyed by the `Binding` a name resolves to at the use site
 * (`ScopeResolver.getBinding`), so `req.query.state` in handler A taints only
 * A's `state`. Names that resolve to no binding at all (ambient/undeclared)
 * keep a name-keyed fallback, because there is nothing better to key them by.
 */

import type { AstNode, TaintLookup } from "./types.ts";
import { walk, findDescendant } from "./walk.ts";
import { REQUEST_ROOTS, isFunctionLike } from "./ast.ts";
import type { Binding, ScopeResolver } from "./scope.ts";

const MAX_ROUNDS = 6;

const patternNames = (
  pattern: AstNode | null | undefined,
  out: [AstNode, string][],
): void => {
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
      for (const el of (pattern.elements as (AstNode | null)[]) ?? []) patternNames(el, out);
      break;
    case "ObjectPattern":
      for (const prop of (pattern.properties as AstNode[]) ?? []) {
        if (prop.type === "RestElement") patternNames(prop.argument, out);
        else patternNames(prop.value, out);
      }
      break;
    default:
      break;
  }
};

/**
 * An Identifier is only a VARIABLE READ in some positions. `row.user_id` and
 * `{ token: … }` are a property name and a key — not references — and treating
 * them as such let taint spread by NAME COLLISION alone.
 */
const isReferencePosition = (n: AstNode): boolean => {
  const parent = n.parent as AstNode | undefined;
  if (parent?.type === "MemberExpression" && parent.property === n && parent.computed !== true) return false;
  if (parent?.type === "Property" && parent.key === n && parent.computed !== true) return false;
  return true;
};

/**
 * The caller-controlled bindings of one file.
 *
 * `has(name)` is kept for the one consumer that legitimately asks a name-only
 * question and then confirms against the binding itself
 * (`no-cross-request-state-mutation`); everything else should ask `hasRef`,
 * which resolves the identifier to its binding first.
 */
export class TaintSet implements TaintLookup {
  /** Bindings known to hold caller data. Identity-keyed: one per (scope, name). */
  private readonly bindings = new Set<Binding>();
  /** Names that resolve to no binding at all — ambient/undeclared globals. */
  private readonly unresolved = new Set<string>();
  /** Every tainted NAME, for the loose `has` query. */
  private readonly names = new Set<string>();

  private readonly scope: ScopeResolver;

  constructor(scope: ScopeResolver) {
    this.scope = scope;
  }

  get size(): number {
    return this.bindings.size + this.unresolved.size;
  }

  /** Loose, name-only. Prefer `hasRef`. */
  has(name: string): boolean {
    return this.names.has(name);
  }

  /**
   * A request-root NAME is the request object only when it arrives as a
   * function PARAMETER (`(req, res) => …`, `async function h(ctx)`) or is
   * ambient. A `const context = lines.join("\n")` in a diff utility is not —
   * seeding from it floods the function with false taint. The old pass had this
   * exclusion too, but keyed by name and applied to the whole FILE, so one
   * `const ctx = …` anywhere silenced every genuine `ctx` handler param in the
   * file, and (the other half of the hole) it only inspected
   * `VariableDeclarator`, so a `function f(request: any)` signature still
   * seeded the entire file. Per-binding, both halves close.
   */
  private isRequestRoot(binding: Binding | null, name: string): boolean {
    if (!REQUEST_ROOTS.has(name)) return false;
    if (!binding) return true; // ambient `req`/`ctx` — nothing declares it here
    return binding.kind === "param";
  }

  /** Is this Identifier NODE a read of a caller-controlled binding? */
  hasRef(n: AstNode | null | undefined): boolean {
    if (!n || n.type !== "Identifier") return false;
    if (!isReferencePosition(n)) return false;
    const binding = this.scope.resolveIdentifier(n);
    if (!binding) return this.unresolved.has(n.name) || this.isRequestRoot(null, n.name);
    return this.bindings.has(binding) || this.isRequestRoot(binding, binding.name);
  }

  /** @internal — mark the binding `name` resolves to from `at` as tainted. */
  taint(at: AstNode, name: string): boolean {
    const binding = this.scope.getBinding(name, at);
    const before = this.size;
    if (binding) this.bindings.add(binding);
    else this.unresolved.add(name);
    this.names.add(name);
    return this.size !== before;
  }
}

/** Compute the caller-controlled bindings of a file. */
export const computeTaint = (program: AstNode, scope: ScopeResolver): TaintSet => {
  const tainted = new TaintSet(scope);

  /**
   * Seed the NAME view with this file's genuine request roots. The binding view
   * needs no seeding — `hasRef` recognizes a request-root parameter directly,
   * so there is exactly one definition of "is this the request object?".
   */
  walk(program, {
    enter: (node) => {
      if (node.type === "Identifier" && tainted.hasRef(node)) tainted.taint(node, node.name);
    },
  });

  const referencesCaller = (expr: AstNode | null | undefined): boolean => {
    if (!expr) return false;
    if (tainted.hasRef(expr)) return true;
    return findDescendant(expr, (n) => tainted.hasRef(n), isFunctionLike) !== null;
  };

  // Propagate across statements and through assignments to a fixpoint:
  // `const a = req.body.x; const b = a; sink(b)` must reach `b`.
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let grew = false;
    const taintPattern = (pattern: AstNode | null | undefined): void => {
      const names: [AstNode, string][] = [];
      patternNames(pattern, names);
      for (const [declNode, name] of names) grew = tainted.taint(declNode, name) || grew;
    };
    walk(program, {
      enter: (node) => {
        if (
          node.type === "VariableDeclarator" &&
          node.init &&
          // A function VALUE is never caller data, whatever its body reads.
          // Without this, `const esc = (v) => v.replace(…)` becomes tainted the
          // moment `v` does, and then every `esc(x)` in the file reads as
          // caller-controlled — including `new RegExp(esc(input))`, which is
          // the escaping the rules explicitly document as the SAFE pattern.
          !isFunctionLike(node.init) &&
          referencesCaller(node.init)
        ) {
          taintPattern(node.id);
        } else if (
          node.type === "AssignmentExpression" &&
          node.operator === "=" &&
          node.left?.type === "Identifier" &&
          referencesCaller(node.right)
        ) {
          grew = tainted.taint(node.left, node.left.name) || grew;
        } else if (node.type === "ForOfStatement" && referencesCaller(node.right)) {
          // `for (const id of req.body.ids)` binds a caller-controlled element.
          // The loop variable has no initializer, so the VariableDeclarator arm
          // above never reached it; the file-global name set used to cover the
          // gap by accident, whenever some other function happened to declare
          // the same name from a request. Keyed by binding, that accident is
          // gone, so the propagation has to be real.
          //
          // `for…in` is deliberately NOT here. Its binding is a KEY, and over
          // the corpus the objects reached this way are overwhelmingly DB rows
          // that are "tainted" only because the QUERY mentioned caller input —
          // `for (let x in rows.data)` binds "0", "1", "2". Propagating there
          // added 75 false `no-prototype-pollution` findings in one file.
          const left = node.left as AstNode;
          taintPattern(left.type === "VariableDeclaration" ? (left.declarations as AstNode[])?.[0]?.id : left);
        }
      },
    });
    if (!grew) break;
  }

  return tainted;
};
