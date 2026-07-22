import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { REQUEST_ROOTS, isFunctionLike, findAncestor } from "../../core/ast.ts";
import { isOnRequestPath } from "../../core/request-path.ts";
import { childNodes } from "../../core/walk.ts";

/**
 * Caller-derived data stored in a module-scope `let`/`var` from inside a request
 * handler.
 *
 * Module scope is process scope. One module-scope binding is shared by *every*
 * concurrent request the process is serving, so `currentUser = req.user` means
 * request A can overwrite the value request B is about to read. The result is
 * user data bleeding between users — intermittent, load-dependent, and
 * essentially impossible to reproduce locally where requests never overlap. No
 * per-file linter catches it because each line looks perfectly correct on its
 * own; only the combination of *module scope* + *request path* + *caller data*
 * is the defect.
 *
 * ❌ let currentUser;
 *    app.get("/me", (req, res) => { currentUser = req.user; res.json(profile()); });
 * ✅ app.get("/me", (req, res) => { const currentUser = req.user; ... });  // per-request local
 * ✅ app.get("/me", (req, res) => { store.run({ user: req.user }, next); }); // AsyncLocalStorage
 *
 * Where the line is drawn (all three are deliberate, and tested):
 *
 * 1. **Only caller-derived values.** `requestCount++` and `lastSweepAt =
 *    Date.now()` at module scope are ubiquitous and benign: concurrent writes
 *    race, but no user ever reads another user's data. Requiring the assigned
 *    value to be caller-derived (`ctx.taintedBindings` / a request parameter)
 *    cleanly separates "data bleed" from "harmless counter". Consequently
 *    `UpdateExpression` (`x++`, `--y`) never fires — its value is derived from
 *    the variable itself, never from the caller.
 * 2. **Only storing operators** (`=`, `??=`, `||=`, `&&=`). `total += req.body.n`
 *    is an accumulator, not a bleed; unbounded accumulation is a memory shape.
 * 3. **Only plain `let`/`var` identifier reassignment.** A `const` binding cannot
 *    be reassigned, so a module-scope `const` cache (`cache.set(k, req.body)`) is
 *    structurally excluded here and left to `no-unbounded-module-cache` — no
 *    double reporting. Property writes (`req.user = x`, `res.locals.y = z`,
 *    `this.state = req.body`) are request-scoped or instance-scoped, not shared,
 *    and are likewise excluded. An undeclared assignment resolves to no binding
 *    and stays silent rather than guessing.
 * 4. **Taint is confirmed per binding, not per name.** The shared taint set is
 *    keyed by name for the whole file, so a `const id = DEFAULTS.id` in one
 *    handler would otherwise inherit the taint of a `const id = req.params.id`
 *    in another. A binding must prove *itself* caller-derived: either it is a
 *    request root bound as a parameter of a function that really is a request
 *    handler, or its own initializer is caller-derived. A binding we cannot
 *    confirm — a `catch (err)`, a `for (const item of LIST)`, an unassigned
 *    `let`, an arbitrary callback parameter — never counts, however tainted its
 *    *name* is elsewhere in the file. That is the difference between a proven
 *    bleed and a name collision, and only the proven one is worth an `error`.
 */

/** Operators that *store* the right-hand value (as opposed to accumulating into it). */
const STORING_OPERATORS = new Set(["=", "??=", "||=", "&&="]);

/** Bindings that can actually be reassigned and outlive a single request. */
const MUTABLE_KINDS = new Set(["let", "var"]);

export const noCrossRequestStateMutation = defineDiagnostic({
  id: "no-cross-request-state-mutation",
  title: "Request data stored in module-scope mutable state",
  severity: "error",
  // Reliability, not Bugs: the code is locally correct and passes every
  // single-request test. It only fails under concurrency — a behaviour-under-load
  // defect, which is what this bucket's lifecycle/memory rules cover.
  category: "Reliability",
  tags: ["concurrency", "state"],
  confidence: "high",
  recommendation:
    "Keep request data on the request: use a `const` local inside the handler, hang it off `req`/`res.locals`, or thread it through `AsyncLocalStorage`. A module-scope `let`/`var` is shared by every concurrent request, so one caller's write is another caller's read.",
  create: (ctx) => {
    /** Declarators currently being resolved, so `let a = b, b = a` cannot loop. */
    const resolving = new Set<AstNode>();

    /**
     * Does `root` read caller-controlled data? Walks value positions only:
     * a non-computed member *property* (`obj.id`) is a fixed key, never a read
     * of a binding named `id`, and nested functions are not evaluated here.
     */
    const referencesCaller = (root: AstNode | null | undefined): boolean => {
      if (!root) return false;
      const stack: AstNode[] = [root];
      while (stack.length > 0) {
        const node = stack.pop()!;
        if (isFunctionLike(node)) continue;
        if (node.type === "Identifier") {
          if (isCallerDerivedIdent(node)) return true;
          continue;
        }
        if (node.type === "MemberExpression") {
          if (node.object) stack.push(node.object);
          if (node.computed && node.property) stack.push(node.property);
          continue;
        }
        if (node.type === "Property") {
          if (node.computed && node.key) stack.push(node.key);
          if (node.value) stack.push(node.value);
          continue;
        }
        for (const child of childNodes(node)) stack.push(child);
      }
      return false;
    };

    /** Kinds whose initializer can be inspected; the rest are module-static. */
    const CONFIRMABLE_KINDS = new Set(["var", "let", "const"]);

    /**
     * Is this parameter binding the request object itself? It must both be
     * *named* like a request root and be a parameter of a function this file
     * actually identified as a request handler. Without the second half, any
     * `emitter.on("tick", (event) => …)` or `withContext((context) => …)`
     * callback nested in a handler reads as caller data.
     */
    const isRequestParam = (binding: { kind: string; declNode: AstNode }, name: string): boolean => {
      if (binding.kind !== "param" || !REQUEST_ROOTS.has(name)) return false;
      const owner = findAncestor(binding.declNode, isFunctionLike);
      return !!owner && ctx.requestHandlers.has(owner);
    };

    /**
     * Is this identifier reference caller-controlled?
     *
     * The shared taint set is keyed by *name* for the whole file, so it can only
     * ever be a filter here, never the proof. The binding itself has to carry
     * the evidence: a request-root parameter of a real handler, or an
     * initializer that is itself caller-derived. Everything we cannot confirm —
     * an undeclared name, a `catch (err)`, a `for (const item of LIST)`, a
     * declared-but-unassigned `let`, an ordinary callback parameter, an import —
     * is treated as clean, because a same-named binding in another handler must
     * never lend it taint.
     */
    function isCallerDerivedIdent(node: AstNode): boolean {
      const name = node.name as string;
      const binding = ctx.scope.getBinding(name, node);
      if (!binding) return false; // undeclared / ambient — do not guess
      if (binding.kind === "param") return isRequestParam(binding, name);
      if (!ctx.taintedBindings.has(name)) return false;
      if (!CONFIRMABLE_KINDS.has(binding.kind)) return false; // import/function/class
      if (!binding.initNode) return false; // nothing to confirm against — stay silent
      if (resolving.has(binding.declNode)) return false;
      resolving.add(binding.declNode);
      const derived = referencesCaller(binding.initNode);
      resolving.delete(binding.declNode);
      return derived;
    }

    return {
      AssignmentExpression: (node) => {
        if (!STORING_OPERATORS.has(node.operator as string)) return;

        // Plain identifier reassignment only — property writes are on some
        // object, whose lifetime this rule makes no claim about.
        const target = node.left as AstNode | undefined;
        if (!target || target.type !== "Identifier") return;

        // The binding must be declared at module scope with a reassignable kind.
        const binding = ctx.scope.getBinding(target.name, target);
        if (!binding) return; // undeclared / ambient — do not guess
        if (binding.scopeKind !== "module") return; // handler-local: the correct pattern
        if (!MUTABLE_KINDS.has(binding.kind)) return; // const/import/function/class

        // Module-scope bootstrap assignment is fine; the bug needs a request.
        if (!isOnRequestPath(node, ctx.requestHandlers)) return;

        // Counters and clocks race harmlessly; only caller data bleeds.
        if (!referencesCaller(node.right)) return;

        ctx.report(
          target,
          `\`${target.name}\` is module-scope mutable state shared by every concurrent request — storing caller-derived data in it lets one request overwrite what another is about to read.`,
        );
      },
    };
  },
});
