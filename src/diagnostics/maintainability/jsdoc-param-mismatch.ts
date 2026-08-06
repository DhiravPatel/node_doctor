import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode, CommentNode } from "../../core/types.ts";
import { collectDescendants } from "../../core/walk.ts";

/**
 * §178 — a JSDoc `@param` that names a parameter the function does not have.
 *
 * THE BUG. A comment that lies is worse than no comment: it actively misdirects
 * the next reader, and — increasingly — the next coding agent, which has no way
 * to tell a stale doc from a current one and will happily generate a call
 * matching the comment rather than the signature.
 *
 *   ❌ /**
 *       * @param userId  the user to charge
 *       * @param amount  in cents
 *       *\/
 *      export function charge(customerId, amountCents) { … }
 *
 * The rename happened; the doc did not. Every caller written from that doc
 * passes the right values under names that no longer exist, and every reader
 * spends a minute working out which is authoritative.
 *
 * PRECISION MODEL. This rule makes exactly one claim — "this `@param` name is
 * not a parameter of this function" — and it fires only where all six of these
 * hold. Each was chosen because its absence produces a wrong claim, not merely a
 * noisy one:
 *
 *   1. A JSDoc block (`/** … *\/`) is attached to the function by the strict
 *      association below: immediately above it, separated by at most one
 *      newline, with no other comment in between and no chance of it being the
 *      previous line's trailing comment. A module header two blank lines above
 *      the first function is NOT its documentation.
 *   2. The block has at least one `@param` tag.
 *   3. EVERY parameter is a plain identifier. Destructuring (`{ id, name }`),
 *      arrays, and rest params leave nothing to name-match against, and
 *      `@param options.timeout` documents a property, not a parameter.
 *   4. EVERY `@param` name is a bare identifier — no dots, no brackets. `[opts]`
 *      is JSDoc's optional-parameter syntax and `opts.timeout` is a property
 *      path; neither is a claim this rule can check.
 *   5. The function's name is unique among the file's declarations. TypeScript
 *      overload sets put one JSDoc above the first of several declarations that
 *      share a name and differ in parameters — reading it against the wrong one
 *      is a guaranteed false positive.
 *   6. The block documents THIS function and not some other subject. `@callback`,
 *      `@typedef`, `@event` and the named forms of `@function`/`@name`/`@method`
 *      all declare a subject of their own — a `@callback` typedef placed
 *      directly above its single consumer is ordinary style, and its `@param`
 *      tags describe the callback's signature, not the consumer's.
 *   7. Every `@param` line sits at the same indentation. An options-object block
 *      that indents its nested tags is describing properties, whatever the tag
 *      says.
 *   8. At least one documented name is absent from the parameter list.
 *
 * DELIBERATELY NOT REPORTED: a parameter with no `@param` tag. That is
 * incomplete documentation, not a contradiction, and reporting it turns this
 * into a doc-coverage linter — burying the one signal that is actually a defect
 * under a pile of style noise. Tag order and tag count are not reported either.
 */

/** JSDoc tag scanning, hand-rolled — the project takes no new dependencies. */

/**
 * A JSDoc block's text with the comment furniture removed: the leading `*` of
 * the block marker and each line's leading ` * `.
 */
const jsdocBody = (comment: CommentNode): string =>
  comment.value.replace(/^\*/, "").replace(/^[ \t]*\*[ \t]?/gm, "");

/**
 * Parameter names claimed by `@param` tags. Both the typed form
 * (`@param {string} name`) and the bare form (`@param name`) are read; a name
 * this rule cannot check (a property path, an optional bracket) is returned as
 * `null` so the caller can abstain rather than guess.
 */
const documentedParams = (body: string): Array<string | null> => {
  const names: Array<string | null> = [];
  for (const line of body.split("\n")) {
    const tag = /^\s*@(?:param|arg|argument)\s+(.*)$/.exec(line);
    if (!tag) continue;
    let rest = (tag[1] ?? "").trim();
    // Skip an optional `{type}` — braces can nest (`{Array<{a: 1}>}`).
    if (rest.startsWith("{")) {
      let depth = 0;
      let i = 0;
      for (; i < rest.length; i++) {
        if (rest[i] === "{") depth += 1;
        else if (rest[i] === "}") {
          depth -= 1;
          if (depth === 0) {
            i += 1;
            break;
          }
        }
      }
      if (depth !== 0) {
        names.push(null); // unbalanced — unreadable
        continue;
      }
      rest = rest.slice(i).trim();
    }
    const token = /^[^\s]+/.exec(rest)?.[0];
    if (!token) continue;
    // `[opts]` / `[opts=1]` is optional-parameter syntax and `a.b` is a
    // property path. Neither is a bare parameter name this rule can check.
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(token)) names.push(token);
    else names.push(null);
  }
  return names;
};

/**
 * Does this block declare a subject other than the node below it? `@callback`
 * and `@typedef` define a type; `@event` documents a payload; the NAMED forms of
 * `@function`/`@name`/`@method` explicitly retarget the block. In every case the
 * `@param` tags belong to that subject, so reading them against the following
 * declaration produces a claim that is not merely noisy but false — and the
 * recommendation ("delete the tag") would destroy a type definition.
 *
 * The BARE `@function` / `@method` form is deliberately not matched: with no
 * name argument it applies to the attached symbol, and a real stale-doc block
 * can carry it.
 */
const redirectsSubject = (body: string): boolean =>
  body
    .split("\n")
    .some(
      (line) =>
        /^\s*@(?:callback|typedef|event|external|host|module|namespace|interface)\b/.test(line) ||
        /^\s*@(?:function|func|method|name|alias|memberof)\s+\S/.test(line),
    );

/**
 * Are all `@param` tags at the same indentation? An options-object block that
 * indents its nested tags under a parent is documenting properties — the same
 * claim `opts.timeout` makes explicitly, written differently.
 */
const paramsUniformlyIndented = (body: string): boolean => {
  const indents = new Set<number>();
  for (const line of body.split("\n")) {
    const m = /^([ \t]*)@(?:param|arg|argument)\s/.exec(line);
    if (m) indents.add(m[1]!.replace(/\t/g, "  ").length);
  }
  return indents.size <= 1;
};

/** The function-shaped node a declaration statement carries, if any. */
const functionOf = (statement: AstNode): { fn: AstNode; name: string | null } | null => {
  let node = statement;
  if (node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration") {
    const declaration = node.declaration as AstNode | undefined;
    if (!declaration) return null;
    node = declaration;
  }
  if (node.type === "FunctionDeclaration") {
    // A `TSDeclareFunction` (an overload signature) has no body; oxc gives it
    // its own type, so a FunctionDeclaration here is always the implementation.
    return { fn: node, name: (node.id as AstNode | undefined)?.name ?? null };
  }
  if (node.type === "VariableDeclaration") {
    const declarators = (node.declarations as AstNode[] | undefined) ?? [];
    if (declarators.length !== 1) return null;
    const declarator = declarators[0]!;
    const id = declarator.id as AstNode | undefined;
    const init = declarator.init as AstNode | undefined;
    if (id?.type !== "Identifier") return null;
    if (init?.type !== "ArrowFunctionExpression" && init?.type !== "FunctionExpression") return null;
    return { fn: init, name: id.name as string };
  }
  if (node.type === "MethodDefinition" || node.type === "PropertyDefinition") {
    const value = node.value as AstNode | undefined;
    if (value?.type !== "FunctionExpression" && value?.type !== "ArrowFunctionExpression") return null;
    // A computed key (`[handlerName](a) {}`) has no name to report, and using
    // the inner identifier would both mis-name the function in the message and
    // key the uniqueness gate on the wrong symbol.
    if (node.computed) return null;
    const key = node.key as AstNode | undefined;
    return { fn: value, name: key?.type === "Identifier" ? (key.name as string) : null };
  }
  return null;
};

/** Parameter names, or null when any parameter is not a plain identifier. */
const parameterNames = (fn: AstNode): string[] | null => {
  const names: string[] = [];
  for (const param of (fn.params as AstNode[] | undefined) ?? []) {
    // A TypeScript `this` parameter is a type annotation, not an argument —
    // listing it back to the reader as one of the parameters is wrong.
    if (param.type === "Identifier" && param.name === "this") continue;
    if (param.type === "Identifier") {
      names.push(param.name as string);
      continue;
    }
    if (param.type === "AssignmentPattern") {
      const left = param.left as AstNode | undefined;
      if (left?.type !== "Identifier") return null;
      names.push(left.name as string);
      continue;
    }
    // ObjectPattern / ArrayPattern / RestElement / TSParameterProperty: there is
    // no name to match a `@param` against.
    return null;
  }
  return names;
};

export const jsdocParamMismatch = defineDiagnostic({
  id: "jsdoc-param-mismatch",
  title: "JSDoc documents a parameter the function does not have",
  severity: "warn",
  category: "Maintainability",
  confidence: "high",
  tags: ["maintainability", "hygiene"],
  defaultEnabled: false,
  recommendation:
    "Rename the `@param` to match the signature, or delete it. A doc comment naming parameters that do not exist misdirects every reader — and every coding agent, which has no way to tell a stale doc from a current one and will generate calls that match the comment rather than the code.",
  create: (ctx) => {
    const comments = [...ctx.comments].sort((a, b) => a.start - b.start);
    const hasJsdoc = comments.some((c) => c.type === "Block" && c.value.startsWith("*"));

    /**
     * Names declared more than once at any level of the file. A TypeScript
     * overload set is the motivating case: one JSDoc above several declarations
     * that share a name and differ in parameters.
     */
    const declaredNames = new Map<string, number>();
    for (const node of collectDescendants(ctx.program, () => true, undefined, true)) {
      const named =
        node.type === "FunctionDeclaration" || node.type === "TSDeclareFunction"
          ? ((node.id as AstNode | undefined)?.name as string | undefined)
          : node.type === "VariableDeclarator" && (node.id as AstNode | undefined)?.type === "Identifier"
            ? ((node.id as AstNode).name as string)
            : node.type === "MethodDefinition" && (node.key as AstNode | undefined)?.type === "Identifier"
              ? ((node.key as AstNode).name as string)
              : undefined;
      if (named) declaredNames.set(named, (declaredNames.get(named) ?? 0) + 1);
    }

    /**
     * The JSDoc block that documents `anchor`, or null.
     *
     * The gap between the comment and the node must be whitespace with AT MOST
     * ONE newline. Allowing blank lines is how a module-header JSDoc gets read
     * as the first function's documentation — and then every `@param` in the
     * header is reported against a function it was never about.
     */
    const jsdocFor = (anchor: AstNode, previousEnd: number): CommentNode | null => {
      let candidate: CommentNode | null = null;
      for (const comment of comments) {
        if (comment.end > (anchor.start as number)) break;
        candidate = comment;
      }
      if (!candidate) return null;
      if (candidate.type !== "Block" || !candidate.value.startsWith("*")) return null;
      // A comment on the SAME LINE as the previous statement is that
      // statement's trailing comment, not this one's leading doc.
      if (previousEnd >= 0) {
        if ((candidate.start as number) < previousEnd) return null;
        const between = ctx.sourceText.slice(previousEnd, candidate.start);
        if (!between.includes("\n")) return null;
      }
      const gap = ctx.sourceText.slice(candidate.end, anchor.start as number);
      if (!/^\s*$/.test(gap)) return null;
      if ((gap.match(/\n/g) ?? []).length > 1) return null;
      return candidate;
    };

    const checkList = (body: unknown): void => {
      if (!hasJsdoc || !Array.isArray(body)) return;
      const statements = body as AstNode[];
      /** End offset of the previous statement — a comment before it is ITS trailing comment. */
      let previousEnd = -1;

      for (const statement of statements) {
        const previous = previousEnd;
        previousEnd = statement.end as number;

        const target = functionOf(statement);
        if (!target || !target.name) continue;

        // An overload set, or any duplicated name: the comment may document a
        // different declaration than the one we are looking at.
        if ((declaredNames.get(target.name) ?? 0) !== 1) continue;

        const comment = jsdocFor(statement, previous);
        if (!comment) continue;

        const body = jsdocBody(comment);
        // The block is about something else entirely.
        if (redirectsSubject(body)) continue;
        if (!paramsUniformlyIndented(body)) continue;

        const documented = documentedParams(body);
        if (documented.length === 0) continue;
        // A name this rule cannot read (`opts.timeout`, `[opts]`) means the
        // block is not fully checkable — abstain on the whole function.
        if (documented.some((n) => n === null)) continue;

        const actual = parameterNames(target.fn);
        if (actual === null) continue;

        const present = new Set(actual);
        const stale = (documented as string[]).filter((n) => !present.has(n));
        if (stale.length === 0) continue;

        const list = stale.map((n) => `\`${n}\``).join(", ");
        ctx.report(
          statement,
          `This JSDoc documents ${list} but \`${target.name}\` has no such parameter — its parameters are ${
            actual.length === 0 ? "(none)" : actual.map((n) => `\`${n}\``).join(", ")
          }. A doc that names parameters the function does not have misdirects every reader, and a coding agent will generate calls that match the comment rather than the code.`,
        );
      }
    };

    return {
      Program: (node) => checkList(node.body),
      ClassBody: (node) => checkList(node.body),
    };
  },
});
