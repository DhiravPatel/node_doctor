import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { isFunctionLike, isLiteralTrue, getPropertyValue } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";
import type { Binding } from "../../core/scope.ts";

/**
 * A NestJS controller method that injects `@Res()` and then RETURNS a value
 * instead of sending. The request hangs — no response, ever.
 *
 *   ❌ @Get() find(@Res() res: Response) { return { ok: true }; }
 *   ❌ @Get() find(@Res() res: Response) { res.setHeader("x-a", "1"); return data; }
 *   ✅ @Get() find(@Res({ passthrough: true }) res: Response) { return { ok: true }; }
 *   ✅ @Get() find(@Res() res: Response) { res.json({ ok: true }); }
 *   ✅ @Get() find() { return { ok: true }; }
 *
 * Injecting `@Res()` switches the handler into Nest's **library-specific mode**:
 * Nest stops managing the response, so the value you return is discarded and
 * nothing is ever written to the socket. MEASURED against NestJS 11.2.3, each
 * case booted as a real server and fetched:
 *
 *   return value, no @Res                          → 200 {"ok":true}
 *   @Res, res.json({ok:true})                      → 200 {"ok":true}
 *   @Res({passthrough:true}), returns value        → 200 {"ok":true}
 *   @Res({passthrough:true}), setHeader + returns  → 200 {"ok":true}
 *   @Res, returns value, never sends               → NO RESPONSE, hung until timeout
 *   @Res, setHeader then returns                   → NO RESPONSE, hung until timeout
 *
 * The last two are the defect, and the second of them is the shape that actually
 * occurs: someone needs one header, reaches for `@Res()` to set it, and leaves
 * the `return` that was already there. Nothing throws, nothing is logged, and the
 * handler looks like every other handler in the file.
 *
 * The cost is worse than a wrong response. The socket stays open until the client
 * or a proxy gives up, so under load these accumulate — connections, and the
 * memory of every request still pinned to them — until the server stops accepting
 * new ones. The symptom shows up as a saturated pool, far from the route that
 * caused it.
 *
 * PRECISION MODEL. Four structural conditions, and the analysis defaults to
 * silence at every point it cannot prove the response was left unsent:
 *
 *   - The method carries an HTTP-method decorator (`@Get`, `@Post`, …), so a
 *     plain helper on the controller class is not a route.
 *   - It has a parameter decorated `@Res()` or `@Response()` **without**
 *     `{ passthrough: true }`. Passthrough is the documented escape hatch that
 *     keeps Nest's response handling, and it is verified to answer 200 both with
 *     and without a header write.
 *   - The method body has a `return` WITH a value, not counting returns inside
 *     nested functions. A bare `return;` or no return at all is a different
 *     shape — it may be piping a stream, and this rule does not claim it.
 *   - The response parameter is never used in a way that could send. A call
 *     anywhere in its member chain naming a terminal method — `send`, `json`,
 *     `end`, `sendFile`, `sendStatus`, `redirect`, `render`, `download`, `jsonp`,
 *     `write`, `writeHead`, `pipe`, `stream` — silences it, including through
 *     chains like `res.status(201).json(x)`. So does ANY other use of the
 *     binding: passed as an argument (`stream.pipe(res)`, `helper(res)`),
 *     assigned to another name, returned, spread. Only the provably-benign
 *     member reads (`res.setHeader(…)`, `res.locals`) leave the finding standing,
 *     and those are exactly the measured hang.
 *
 * Gated on the `nest` capability.
 */

/** Decorators that make a controller method a route. */
const HTTP_METHOD_DECORATORS = new Set(["Get", "Post", "Put", "Patch", "Delete", "All", "Options", "Head", "Search"]);

/** Parameter decorators that hand over the raw response object. */
const RESPONSE_DECORATORS = new Set(["Res", "Response"]);

/** Methods that actually write to the socket. */
const TERMINAL_METHODS = new Set([
  "send",
  "json",
  "end",
  "sendFile",
  "sendStatus",
  "redirect",
  "render",
  "download",
  "jsonp",
  "write",
  "writeHead",
  "pipe",
  "stream",
]);

/** The decorator's callee name (`@Get(":id")` → "Get", `@Res` → "Res"). */
const decoratorName = (decorator: AstNode): string | null => {
  const expression = decorator.expression as AstNode | undefined;
  if (!expression) return null;
  if (expression.type === "Identifier") return String(expression.name);
  if (expression.type === "CallExpression") {
    const callee = expression.callee as AstNode | undefined;
    if (callee?.type === "Identifier") return String(callee.name);
  }
  return null;
};

/** Does `@Res({ passthrough: true })` keep Nest's response handling? */
const isPassthrough = (decorator: AstNode): boolean => {
  const expression = decorator.expression as AstNode | undefined;
  if (expression?.type !== "CallExpression") return false;
  const options = ((expression.arguments as AstNode[] | undefined) ?? [])[0];
  if (options?.type !== "ObjectExpression") return false;
  return isLiteralTrue(getPropertyValue(options, "passthrough"));
};

/** The plain identifier a parameter introduces, through a default value. */
const parameterIdentifier = (param: AstNode | null | undefined): AstNode | null => {
  if (!param) return null;
  if (param.type === "Identifier") return param;
  if (param.type === "AssignmentPattern") return parameterIdentifier(param.left as AstNode);
  return null;
};

export const noNestResWithoutSend = defineDiagnostic({
  id: "no-nest-res-without-send",
  title: "NestJS handler injects @Res() and returns a value, so the request never gets a response",
  severity: "error",
  category: "Bugs",
  confidence: "high",
  requires: ["nest"],
  tags: ["nest", "http", "correctness"],
  recommendation:
    "Either send on the response object (`res.json(payload)`) or take Nest's handling back with `@Res({ passthrough: true })` and keep returning the value. Injecting a bare `@Res()` puts the handler in library-specific mode: Nest stops managing the response, the returned value is discarded, and nothing is written — measured on NestJS 11.2.3, the request hangs until the client times out, holding the connection open. If you only needed a header, `passthrough: true` is the fix.",
  create: (ctx) => ({
    MethodDefinition: (node) => {
      const decorators = (node.decorators as AstNode[] | undefined) ?? [];
      if (!decorators.some((d) => HTTP_METHOD_DECORATORS.has(decoratorName(d) ?? ""))) return;

      const fn = node.value as AstNode | undefined;
      if (!isFunctionLike(fn)) return;

      // A `@Res()` parameter that is NOT passthrough.
      let responseParam: AstNode | null = null;
      for (const param of ((fn!.params as AstNode[] | undefined) ?? [])) {
        for (const decorator of ((param.decorators as AstNode[] | undefined) ?? [])) {
          if (!RESPONSE_DECORATORS.has(decoratorName(decorator) ?? "")) continue;
          if (isPassthrough(decorator)) return; // Nest still manages the response
          responseParam = parameterIdentifier(param);
        }
      }
      if (!responseParam) return;

      const body = fn!.body as AstNode | undefined;
      if (!body || body.type !== "BlockStatement") return;

      // A `return` with a VALUE, in this method rather than a nested function.
      const returnsValue = collectDescendants(
        body,
        (n) => n.type === "ReturnStatement" && !!n.argument,
        isFunctionLike,
      ).length > 0;
      if (!returnsValue) return;

      const responseBinding: Binding | null = ctx.scope.resolveIdentifier(responseParam);
      if (!responseBinding) return;

      // Any use of the response that could send — or that this analysis cannot
      // follow — silences the finding.
      const references = collectDescendants(
        body,
        (n) => n.type === "Identifier" && String(n.name) === String(responseParam.name),
      );
      for (const reference of references) {
        if (ctx.scope.resolveIdentifier(reference) !== responseBinding) continue;
        const parent = reference.parent as AstNode | undefined;
        // Anything other than being the OBJECT of a member read is unfollowable:
        // an argument, an assignment, a return, a spread.
        if (parent?.type !== "MemberExpression" || parent.object !== reference) return;

        // Walk the member/call chain and look for a terminal method anywhere in
        // it, so `res.status(201).json(x)` counts as sending.
        let current: AstNode | undefined = parent;
        while (current) {
          if (current.type === "MemberExpression" && !current.computed) {
            const property = current.property as AstNode | undefined;
            if (property?.type === "Identifier" && TERMINAL_METHODS.has(String(property.name))) return;
          }
          const next = current.parent as AstNode | undefined;
          if (next?.type === "MemberExpression" || next?.type === "CallExpression") current = next;
          else break;
        }
      }

      ctx.report(
        node,
        "This handler injects a bare `@Res()`, which puts it in Nest's library-specific mode: Nest stops managing the response, so the value it returns is discarded and nothing is ever written to the socket. Measured on NestJS 11.2.3, the request receives **no response at all** and hangs until the client times out — with the connection, and everything pinned to it, held open. Send on the response object, or use `@Res({ passthrough: true })` and keep returning.",
      );
    },
  }),
});
