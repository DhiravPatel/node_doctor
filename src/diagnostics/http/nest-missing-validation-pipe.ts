import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";

/**
 * OPT-IN, intentionally conservative. A NestJS controller method takes an
 * un-argumented `@Body()` parameter in a file that shows no sign of validation.
 * A bare `@Body()` binds the raw, unvalidated request body; without a global (or
 * local) `ValidationPipe` and a typed DTO, no class-validator diagnostics run and the
 * handler trusts arbitrary input.
 *
 * Because deciding whether validation is "really" configured requires
 * whole-project knowledge, this fires only on the narrowest, highest-confidence
 * signal: `@Body()` written with *no* argument, in a file that references neither
 * `ValidationPipe` nor `UsePipes`. Any of `@Body('field')`, a `ValidationPipe`
 * mention, or a `@UsePipes` decorator anywhere in the file silences it.
 *
 * ❌ @Post() create(@Body() dto) { ... }            // no ValidationPipe in file
 * ✅ @Post() create(@Body() dto: CreateUserDto) {}  // file wires up ValidationPipe
 * ✅ @Post() create(@Body('id') id: string) {}       // sub-field bind, not whole body
 */

/** A decorator that is a bare `@Body()` call with no arguments. */
const isBareBodyDecorator = (node: AstNode): boolean => {
  if (node.type !== "Decorator") return false;
  const expr = node.expression;
  return (
    expr?.type === "CallExpression" &&
    expr.callee?.type === "Identifier" &&
    expr.callee.name === "Body" &&
    ((expr.arguments as AstNode[]) ?? []).length === 0
  );
};

export const nestMissingValidationPipe = defineDiagnostic({
  id: "nest-missing-validation-pipe",
  title: "Nest body param without validation",
  severity: "warn",
  category: "Reliability",
  requires: ["nest"],
  defaultEnabled: false,
  tags: ["nest"],
  recommendation:
    "Apply a global `ValidationPipe` (`app.useGlobalPipes(new ValidationPipe())`) and type the parameter with a DTO class (`@Body() dto: CreateUserDto`) so class-validator diagnostics run before the handler.",
  create: (ctx) => {
    // File-level escape hatch: any sign of configured validation silences the diagnostic.
    const fileMentionsValidation = /\bValidationPipe\b|\bUsePipes\b/.test(ctx.sourceText);

    return {
      Decorator: (node) => {
        if (fileMentionsValidation) return;
        if (!isBareBodyDecorator(node)) return;
        ctx.report(
          node,
          "This `@Body()` binds the raw request body with no `ValidationPipe` or DTO in the file — the handler trusts unvalidated input.",
        );
      },
    };
  },
});
