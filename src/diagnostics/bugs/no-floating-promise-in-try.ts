import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { isFunctionLike } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";

/**
 * §166 — a `try`/`catch` that structurally cannot catch what it appears to guard.
 *
 * THE BUG. An `async` function never throws. It returns a promise, and it signals
 * failure by REJECTING that promise — always, without exception, even if the very
 * first line of its body throws. So this:
 *
 *   ❌ try {
 *        sendReceipt(order);          // async function, result discarded
 *      } catch (err) {
 *        logger.error({ err }, "receipt failed");
 *      }
 *
 * is not error handling. The `catch` runs for exactly nothing: `sendReceipt`
 * returns immediately with a pending promise, the `try` completes normally, and
 * when the promise later rejects there is no handler anywhere on the stack. Node
 * raises `unhandledRejection` — which since v15 terminates the process by default.
 *
 * That is the worst kind of defect: code that LOOKS handled. The reviewer sees a
 * try/catch, the author remembers writing one, and the failure still takes the
 * service down. One keyword fixes it.
 *
 *   ✅ try { await sendReceipt(order); } catch (err) { … }
 *   ✅ sendReceipt(order).catch((err) => logger.error({ err }));   // deliberate
 *   ✅ void sendReceipt(order);                                     // deliberate
 *
 * PRECISION MODEL. The claim is "this catch cannot observe this call's failure",
 * and it is proven, never inferred:
 *
 *   - The callee is a plain identifier that RESOLVES IN THIS FILE, through the
 *     scope chain, to a declaration marked `async`. Not a name that looks async,
 *     not a call that returns something promise-shaped — the binding itself.
 *     A parameter, an import, or a method call is unprovable and stays silent.
 *   - The name is declared EXACTLY ONCE in the file. The scope resolver models
 *     no block scopes and defines first-wins, so with two declarations of a name
 *     it can hand back the wrong one — an adversarial hunt produced a file where
 *     a block-scoped `const send = async …` made the rule flag a call that
 *     actually invoked a synchronous `send` from another scope. One declaration
 *     means there is nothing to get wrong.
 *   - The callee must be able to REJECT. A function whose entire body is one
 *     `try`/`catch` that swallows everything cannot, and telling its author their
 *     rejection escapes would be false.
 *   - The result is DISCARDED: the call is the whole expression of an expression
 *     statement. Awaited, returned, assigned, `void`-ed, or `.then`/`.catch`
 *     chained are all deliberate and silent.
 *   - The statement sits in the `try` BLOCK of a `try` that has a `catch`, with
 *     no function boundary in between. A call inside a nested callback was never
 *     covered by that try in the first place — a different fact, not this one.
 *
 * NOT a duplicate of `no-unreachable-code`: nothing here is dead. The statements
 * all run. What cannot run is the handler, and only for this one call — which is
 * why the message says so rather than calling the catch dead. The `try` may still
 * be protecting its other statements perfectly well.
 */

/**
 * Nodes that introduce a binding named `name`. Used to prove there is exactly
 * one, so the scope resolver cannot hand back a declaration from another block.
 */
const declarationCount = (program: AstNode, name: string): number => {
  let count = 0;
  const isNamed = (n: AstNode | null | undefined): boolean =>
    !!n && n.type === "Identifier" && n.name === name;

  for (const node of collectDescendants(program, () => true, undefined, true)) {
    switch (node.type) {
      case "VariableDeclarator":
      case "FunctionDeclaration":
      case "ClassDeclaration":
      case "FunctionExpression":
      case "ClassExpression":
        if (isNamed(node.id as AstNode | undefined)) count += 1;
        break;
      case "CatchClause":
        if (isNamed(node.param as AstNode | undefined)) count += 1;
        break;
      case "ImportSpecifier":
      case "ImportDefaultSpecifier":
      case "ImportNamespaceSpecifier":
        if (isNamed(node.local as AstNode | undefined)) count += 1;
        break;
      default:
        break;
    }
    if (isFunctionLike(node)) {
      for (const param of (node.params as AstNode[] | undefined) ?? []) {
        if (isNamed(param)) count += 1;
        else if (param?.type === "AssignmentPattern" && isNamed(param.left as AstNode | undefined)) count += 1;
        else if (param?.type === "RestElement" && isNamed(param.argument as AstNode | undefined)) count += 1;
      }
    }
  }
  return count;
};

/**
 * Can this async function's promise ever reject? A body that is nothing but one
 * `try`/`catch` with a handler that neither throws nor awaits swallows every
 * failure it can produce, so claiming its rejection escapes would be false.
 *
 * Deliberately narrow: anything less obvious is treated as "it can reject",
 * which is the direction that keeps the rule useful.
 */
const cannotReject = (fn: AstNode): boolean => {
  const body = fn.body as AstNode | undefined;
  if (body?.type !== "BlockStatement") return false;
  const statements = (body.body as AstNode[] | undefined) ?? [];
  if (statements.length !== 1) return false;
  const tryStatement = statements[0]!;
  if (tryStatement.type !== "TryStatement") return false;
  const handler = tryStatement.handler as AstNode | undefined;
  if (!handler) return false;

  const escapes = (root: AstNode | undefined): boolean =>
    !!root &&
    collectDescendants(
      root,
      (n) => n.type === "ThrowStatement" || n.type === "AwaitExpression" || n.type === "ReturnStatement",
      isFunctionLike,
      true,
    ).length > 0;

  return !escapes(handler.body as AstNode | undefined) && !escapes(tryStatement.finalizer as AstNode | undefined);
};

/** The declaration a callee identifier resolves to, if it is provably `async`. */
const asyncDeclarationFor = (
  callee: AstNode,
  scope: { resolveIdentifier(node: AstNode): { kind: string; declNode: AstNode; initNode: AstNode | null } | null },
): AstNode | null => {
  const binding = scope.resolveIdentifier(callee);
  if (!binding) return null;

  // `async function f() {}` — the declaration node itself carries the flag.
  if (binding.kind === "function") return binding.declNode.async === true ? binding.declNode : null;

  // `const f = async () => {}` / `const f = async function () {}`. Only a
  // `const` can be trusted: a `let`/`var` may hold something else by the time
  // this line runs, and "may" is not proof.
  if (binding.kind !== "const") return null;
  const init = binding.initNode;
  if (!init) return null;
  if (init.type !== "ArrowFunctionExpression" && init.type !== "FunctionExpression") return null;
  return init.async === true ? init : null;
};

/**
 * The nearest enclosing `try` whose BLOCK (not its catch, not its finally)
 * contains `node`, searching outward and stopping at the first function
 * boundary — beyond that boundary the try never covered this call at all.
 */
const enclosingGuardedTry = (node: AstNode): AstNode | null => {
  let child: AstNode = node;
  let cur: AstNode | null | undefined = node.parent;
  let guard = 0;
  while (cur && guard++ < 128) {
    if (isFunctionLike(cur)) return null;
    if (cur.type === "TryStatement" && (cur.block as AstNode) === child && cur.handler) return cur;
    child = cur;
    cur = cur.parent;
  }
  return null;
};

export const noFloatingPromiseInTry = defineDiagnostic({
  id: "no-floating-promise-in-try",
  title: "try/catch cannot catch this discarded async call",
  severity: "warn",
  category: "Bugs",
  confidence: "high",
  tags: ["async", "error-handling", "control-flow"],
  defaultEnabled: false,
  recommendation:
    "`await` the call so the catch can actually see the rejection, or handle it where it happens with `.catch(…)`. An async function signals failure by rejecting its promise, never by throwing — so a try/catch around a discarded call catches nothing and the rejection becomes an unhandledRejection, which terminates the process by default.",
  create: (ctx) => ({
    ExpressionStatement: (node) => {
      const expression = node.expression as AstNode | undefined;
      // Awaited, `void`-ed, assigned, returned: all deliberate, all silent.
      if (expression?.type !== "CallExpression") return;

      const callee = expression.callee as AstNode | undefined;
      if (callee?.type !== "Identifier") return;

      const declaration = asyncDeclarationFor(callee, ctx.scope);
      if (!declaration) return;

      // With more than one declaration of the name, the resolver may have handed
      // back a different one than the code will actually call.
      if (declarationCount(ctx.program, callee.name as string) !== 1) return;

      // A function that swallows everything cannot reject, so the sentence below
      // would not be true of it.
      if (cannotReject(declaration)) return;

      const guarded = enclosingGuardedTry(node);
      if (!guarded) return;

      ctx.report(
        expression,
        `\`${callee.name}\` is an async function and its result is discarded, so its failure is never propagated into this \`try\` — the \`catch\` below cannot observe it, whatever else the block does. If it rejects, the rejection escapes as an unhandledRejection, which terminates the process by default. \`await\` it, or handle it with \`.catch(…)\`.`,
      );
    },
  }),
});
