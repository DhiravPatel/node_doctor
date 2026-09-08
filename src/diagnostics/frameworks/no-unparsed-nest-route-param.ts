import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import type { ProjectGraph } from "../../core/graph.ts";
import { declaresName, isFunctionLike, isLiteralTrue } from "../../core/ast.ts";
import { collectDescendants, findDescendant } from "../../core/walk.ts";

/**
 * A NestJS `@Param()` / `@Query()` binding annotated `number` or `boolean` and
 * used as one, with nothing in the pipeline that converts it. The value arrives
 * as a STRING; the annotation is a lie TypeScript can never catch, because the
 * binding crosses a decorator and `design:paramtypes` is the only thing that
 * knows about it.
 *
 *   ❌ @Get(":id") get(@Param("id") id: number) { return id === 1; }   // always false
 *   ❌ @Get()      list(@Query("dry") dry: boolean) { if (dry) … }     // "false" is TRUTHY
 *   ✅ @Param("id", ParseIntPipe) id: number
 *   ✅ app.useGlobalPipes(new ValidationPipe({ transform: true }))
 *
 * MEASURED against NestJS 11 on platform-express, four handlers under three
 * pipelines. The middle column is the one that matters: adding a `ValidationPipe`
 * — the thing everyone reaches for — does NOT convert primitives unless
 * `transform: true` is set.
 *
 *                          no pipe        ValidationPipe()   ValidationPipe({transform:true})
 *   page + 1  (?page=2)    {"next":"21"}  {"next":"21"}      {"next":3}
 *   id === 1  (/admin/1)   false          false              true
 *   deleted ? … (=false)   INCLUDE        INCLUDE            exclude
 *   if (dry)    (?dry=false)  dry run     dry run            DELETED EVERYTHING
 *
 * Nothing throws and no status changes. `id === 1` is an authorization check
 * that never matches; `if (dry)` inverts a destructive guard, because the string
 * `"false"` is truthy and so is `"true"`. The last row is the shape of the bug:
 * the endpoint behaves correctly right up until someone adds `transform: true`
 * for an unrelated reason, and then it deletes everything.
 *
 * PROJECT SCOPE, because the conversion is configured in `main.ts` and the lie is
 * written in a controller. The rule walks every module for a pipeline that could
 * convert, and ANY of these silences the whole project:
 *
 *   - `new ValidationPipe({ transform: true })` — measured to convert.
 *   - `useGlobalPipes(x)` where `x` is not a readable `new ValidationPipe({…})`,
 *     or a `ValidationPipe` whose options are not an object literal, or whose
 *     `transform` is not a literal. Unreadable resolves to SILENCE.
 *   - any mention of `APP_PIPE`, the provider-based global-pipe registration,
 *     whose options generally live behind a factory.
 *
 * `ValidationPipe()` with no options, or with `transform: false`, is readable and
 * measured NOT to convert, so it correctly leaves the rule firing — that is the
 * common real-world shape.
 *
 * PRECISION MODEL. Per binding, all of these must hold:
 *
 *   - The decorator is `@Param` or `@Query` with EXACTLY ONE argument. A second
 *     argument is a pipe (`@Param("id", ParseIntPipe)`, measured to convert), and
 *     any pipe at all — readable or not — silences the binding.
 *   - `@UsePipes` on the method or the class silences it, since that is the local
 *     form of the same configuration.
 *   - The name is neither re-declared, re-assigned, nor taken as a nested
 *     function's own parameter anywhere in the body, so `id = Number(id)` and
 *     every shadowing inner binding are out. The scope resolver does not model
 *     nested blocks, so this is deliberately a whole-body name check rather than
 *     a resolution.
 *   - The body uses it in a way that is WRONG FOR A STRING, not merely typed as
 *     one. A `number` must reach `+` against a numeric literal (concatenation) or
 *     `===`/`!==` against a numeric literal (never equal). A `boolean` must reach
 *     a condition, `!`, `&&`/`||`, or `===`/`!==` against a boolean literal.
 *
 * `-`, `*`, `/` and `<`/`>` are deliberately excluded: they coerce and the code
 * works. This is the same line drawn by `no-tofixed-as-number`, for the same
 * reason — a string standing in for a number is only a defect where the operator
 * does not coerce.
 */

/** The Nest decorators that bind a raw request string. Both measured. */
const BINDING_DECORATORS = new Set(["Param", "Query"]);

/** The decorator's callee name, for `@Foo(…)` and bare `@Foo`. */
const decoratorName = (decorator: AstNode): string | null => {
  const expression = decorator.expression as AstNode | undefined;
  if (expression?.type === "Identifier") return String(expression.name);
  if (expression?.type === "CallExpression") {
    const callee = expression.callee as AstNode | undefined;
    if (callee?.type === "Identifier") return String(callee.name);
  }
  return null;
};

/** Does this node carry a `@UsePipes` decorator? */
const hasUsePipes = (node: AstNode): boolean =>
  ((node.decorators as AstNode[] | undefined) ?? []).some((d) => decoratorName(d) === "UsePipes");

interface Binding {
  name: string;
  kind: "number" | "boolean";
  decorator: string;
  key: string;
  node: AstNode;
}

/** A `@Param("id") id: number` style binding, or null if this parameter is not one. */
const readBinding = (param: AstNode): Binding | null => {
  // `@Query("p") p: number = 1` puts the decorators on the pattern and the
  // annotation on its left. The default only applies when the key is absent, so
  // a supplied `?p=2` is still the raw string.
  const decorators = (param.decorators as AstNode[] | undefined) ?? [];
  const identifier = param.type === "AssignmentPattern" ? (param.left as AstNode | undefined) : param;
  if (!identifier || identifier.type !== "Identifier") return null;

  let matched: AstNode | null = null;
  for (const decorator of decorators) {
    const name = decoratorName(decorator);
    if (name !== null && BINDING_DECORATORS.has(name)) matched = decorator;
    // Any other parameter decorator we do not model could itself transform.
    else if (name !== null) return null;
  }
  if (matched === null) return null;

  const expression = matched.expression as AstNode | undefined;
  if (expression?.type !== "CallExpression") return null;
  const args = (expression.arguments as AstNode[] | undefined) ?? [];
  // Exactly one argument is the key. Two means a pipe, which converts.
  if (args.length !== 1) return null;
  const key = args[0];
  if (key?.type !== "Literal" || typeof key.value !== "string") return null;

  const annotation = (identifier.typeAnnotation as AstNode | undefined)?.typeAnnotation as AstNode | undefined;
  const kind =
    annotation?.type === "TSNumberKeyword" ? "number" : annotation?.type === "TSBooleanKeyword" ? "boolean" : null;
  if (kind === null) return null;

  return {
    name: String(identifier.name),
    kind,
    decorator: String(((expression.callee as AstNode).name)),
    key: String(key.value),
    node: identifier,
  };
};

/** Is this operand provably a number literal (so `+` concatenates rather than adds)? */
const isNumericLiteral = (node: AstNode | null | undefined): boolean => {
  if (!node) return false;
  if (node.type === "Literal") return typeof node.value === "number";
  if (node.type === "UnaryExpression" && (node.operator === "-" || node.operator === "+")) {
    return isNumericLiteral(node.argument as AstNode | undefined);
  }
  return false;
};

const isBooleanLiteral = (node: AstNode | null | undefined): boolean =>
  node?.type === "Literal" && typeof node.value === "boolean";

/**
 * Is the name written to, or re-bound, anywhere in the body? `id = Number(id)`
 * repairs the value, and a nested function taking its own `id` is a different
 * variable — the scope resolver models neither, so both take the binding out.
 */
const isRebound = (body: AstNode, name: string): boolean =>
  findDescendant(body, (n) => {
    if (n.type === "AssignmentExpression") {
      const left = n.left as AstNode | undefined;
      return left?.type === "Identifier" && String(left.name) === name;
    }
    if (n.type === "UpdateExpression") {
      const argument = n.argument as AstNode | undefined;
      return argument?.type === "Identifier" && String(argument.name) === name;
    }
    if (isFunctionLike(n)) {
      return ((n.params as AstNode[] | undefined) ?? []).some((p) => {
        const id = p.type === "AssignmentPattern" ? (p.left as AstNode | undefined) : p;
        return id?.type === "Identifier" && String(id.name) === name;
      });
    }
    return false;
  }) !== null;

/** The uses of `name` that a string genuinely breaks, given the annotated kind. */
const brokenUses = (body: AstNode, binding: Binding): { node: AstNode; effect: string }[] => {
  const out: { node: AstNode; effect: string }[] = [];
  for (const reference of collectDescendants(body, (n) => n.type === "Identifier" && String(n.name) === binding.name)) {
    const parent = reference.parent as AstNode | undefined;
    if (!parent) continue;

    if (parent.type === "BinaryExpression") {
      const other = (parent.left === reference ? parent.right : parent.left) as AstNode | undefined;
      const operator = String(parent.operator);
      if (binding.kind === "number") {
        if (operator === "+" && isNumericLiteral(other)) {
          out.push({ node: parent, effect: "concatenates instead of adding" });
        } else if ((operator === "===" || operator === "!==") && isNumericLiteral(other)) {
          out.push({ node: parent, effect: `is always ${operator === "===" ? "false" : "true"}` });
        }
      } else if ((operator === "===" || operator === "!==") && isBooleanLiteral(other)) {
        out.push({ node: parent, effect: `is always ${operator === "===" ? "false" : "true"}` });
      }
      continue;
    }

    if (binding.kind !== "boolean") continue;

    if (parent.type === "UnaryExpression" && parent.operator === "!") {
      out.push({ node: parent, effect: "is always false, because every string that arrives is truthy" });
    } else if (parent.type === "LogicalExpression" && (parent.operator === "&&" || parent.operator === "||")) {
      out.push({ node: reference, effect: "is truthy for `?key=false` as well as `?key=true`" });
    } else if (
      (parent.type === "IfStatement" ||
        parent.type === "WhileStatement" ||
        parent.type === "DoWhileStatement" ||
        parent.type === "ConditionalExpression") &&
      parent.test === reference
    ) {
      out.push({ node: reference, effect: "takes the true branch for `?key=false` as well as `?key=true`" });
    }
  }
  return out;
};

/** Computed once per project graph — the walk is O(modules), not O(modules²). */
const transformCache = new WeakMap<ProjectGraph, boolean>();

/** Is `node` a `new ValidationPipe(...)`, however it was imported? */
const isValidationPipeConstruction = (node: AstNode | null | undefined): boolean => {
  if (!node || node.type !== "NewExpression") return false;
  const callee = node.callee as AstNode | undefined;
  if (callee?.type === "Identifier") return String(callee.name) === "ValidationPipe";
  if (callee?.type === "MemberExpression" && !callee.computed) {
    const property = callee.property as AstNode | undefined;
    return property?.type === "Identifier" && String(property.name) === "ValidationPipe";
  }
  return false;
};

/**
 * Could anything in the project convert primitives? Resolves every unreadable
 * pipeline to `true`, i.e. to silence.
 */
const projectMayTransform = (graph: ProjectGraph): boolean => {
  const cached = transformCache.get(graph);
  if (cached !== undefined) return cached;

  let mayTransform = false;
  outer: for (const facts of graph.modules.values()) {
    for (const node of collectDescendants(facts.program, () => true)) {
      // `APP_PIPE` hides its options behind a provider, generally a factory.
      if (node.type === "Identifier" && String(node.name) === "APP_PIPE") {
        mayTransform = true;
        break outer;
      }

      if (isValidationPipeConstruction(node)) {
        const options = ((node.arguments as AstNode[] | undefined) ?? [])[0];
        // `new ValidationPipe()` — measured NOT to convert primitives.
        if (options === undefined) continue;
        if (options.type !== "ObjectExpression") {
          mayTransform = true;
          break outer;
        }
        let transform: AstNode | undefined;
        let readable = true;
        for (const property of ((options.properties as AstNode[] | undefined) ?? [])) {
          // A spread could carry `transform` in from anywhere.
          if (property.type !== "Property" || property.computed) {
            readable = false;
            break;
          }
          const key = property.key as AstNode | undefined;
          const name =
            key?.type === "Identifier" ? String(key.name) : key?.type === "Literal" ? String(key.value) : null;
          if (name === "transform") transform = property.value as AstNode | undefined;
        }
        if (!readable) {
          mayTransform = true;
          break outer;
        }
        if (transform === undefined) continue; // defaults to false, measured
        if (isLiteralTrue(transform)) {
          mayTransform = true;
          break outer;
        }
        if (transform.type !== "Literal") {
          mayTransform = true;
          break outer;
        }
        continue; // `transform: false`, readable and measured not to convert
      }

      // A global pipe we cannot read at all.
      if (node.type === "CallExpression") {
        const callee = node.callee as AstNode | undefined;
        if (callee?.type !== "MemberExpression" || callee.computed) continue;
        const property = callee.property as AstNode | undefined;
        if (property?.type !== "Identifier" || String(property.name) !== "useGlobalPipes") continue;
        for (const argument of ((node.arguments as AstNode[] | undefined) ?? [])) {
          if (!isValidationPipeConstruction(argument)) {
            mayTransform = true;
            break outer;
          }
        }
      }
    }
  }
  transformCache.set(graph, mayTransform);
  return mayTransform;
};

export const noUnparsedNestRouteParam = defineDiagnostic({
  id: "no-unparsed-nest-route-param",
  title: "NestJS route param typed number or boolean arrives as a string, and is used as one",
  severity: "error",
  category: "Bugs",
  confidence: "high",
  scope: "project",
  requires: ["nest"],
  tags: ["nest", "http", "correctness"],
  recommendation:
    "Attach a pipe to the binding (`@Param(\"id\", ParseIntPipe)`, `@Query(\"dry\", ParseBoolPipe)`), or enable `app.useGlobalPipes(new ValidationPipe({ transform: true }))`. A `@Param()`/`@Query()` value is always the raw request string: measured on NestJS 11, `@Param(\"id\") id: number` gives `\"1\"`, so `id === 1` is false, and `@Query(\"dry\") dry: boolean` gives the truthy string `\"false\"` for `?dry=false`. A plain `new ValidationPipe()` does NOT convert primitives — only `transform: true` does.",
  create: (ctx) => ({
    Program: (root) => {
      if (!ctx.graph) return;
      if (projectMayTransform(ctx.graph)) return;

      for (const method of collectDescendants(root, (n) => n.type === "MethodDefinition")) {
        if (hasUsePipes(method)) continue;
        const owner = (method.parent as AstNode | undefined)?.parent as AstNode | undefined;
        if (owner && hasUsePipes(owner)) continue;

        const fn = method.value as AstNode | undefined;
        if (!isFunctionLike(fn)) continue;
        const body = fn!.body as AstNode | undefined;
        if (!body || body.type !== "BlockStatement") continue;

        for (const param of ((fn!.params as AstNode[] | undefined) ?? [])) {
          const binding = readBinding(param);
          if (binding === null) continue;
          // The resolver does not model nested blocks, so a re-declaration or a
          // write anywhere in the body takes the whole binding out.
          if (declaresName(body, binding.name) || isRebound(body, binding.name)) continue;

          for (const use of brokenUses(body, binding)) {
            const observed = binding.kind === "number" ? '`"1"`' : '`"false"`';
            ctx.report(
              use.node,
              `\`@${binding.decorator}("${binding.key}")\` binds the raw request string, so \`${binding.name}\` is a **string** at runtime despite the \`${binding.kind}\` annotation — and this ${use.effect}. Measured on NestJS 11: the value arrives as ${observed}, so \`id === 1\` is false and \`if (dry)\` takes the true branch for \`?dry=false\`. A plain \`new ValidationPipe()\` does not convert primitives; add a pipe to the binding, or set \`transform: true\`.`,
            );
          }
        }
      }
    },
  }),
});
