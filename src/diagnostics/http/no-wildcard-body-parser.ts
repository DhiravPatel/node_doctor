import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import {
  getMethodName,
  rootObjectName,
  getObjectProperty,
  getStaticStringValue,
  getCalleeName,
  unwrapChain,
  isLiteralTrue,
} from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";

/**
 * A body parser configured to swallow EVERY request regardless of its declared
 * `Content-Type`. Express / body-parser normally negotiate on the media type: a
 * `json()` parser only touches `application/json`, `urlencoded()` only touches
 * `application/x-www-form-urlencoded`, and a body carrying another type is left
 * for the parser that actually handles it. The `type` option overrides that
 * negotiation, and the two catch-all spellings —
 *
 *   express.json({ type: "*\/*" })          // any media type
 *   bodyParser.urlencoded({ type: () => true })  // predicate that always matches
 *
 * — turn the parser into an unconditional one. The confusion this creates is a
 * security problem, not a style nit:
 *
 *   - a form-encoded (or plain-text, or binary) body is now run through the JSON
 *     parser (and vice-versa for `urlencoded`), so a request is interpreted as a
 *     structure its sender never intended; and
 *   - a client can deliberately MISLABEL a body — send JSON under
 *     `Content-Type: text/plain`, say — to sail past any validation, schema
 *     check, or WAF rule that keys off the declared content type, because the
 *     parser will still decode it into the shape the handler trusts.
 *
 * The fix is always to scope the parser to the media type it genuinely handles
 * (`express.json({ type: "application/json" })`, or an explicit list / a scoped
 * subtype such as `"application/*+json"` or `"text/*"`).
 *
 * Precision-first — we fire ONLY on a provably universal `type`:
 *   - a string literal exactly equal to `*\/*`, or
 *   - a function that trivially returns `true` (`() => true`, `function(){ return true }`).
 * Anything that names a real media type or a list, omits `type` entirely (the
 * default is a specific type, which is safe), or is a dynamic/opaque value we
 * cannot prove is `*\/*`, stays silent. `raw` / `text` accepting `*\/*` fire too:
 * a raw/text parser grabbing every body is the same content-type confusion.
 *
 * Matched receivers (high-confidence shapes only):
 *   - the member forms `express.<m>(…)` / `bodyParser.<m>(…)` where
 *     `m ∈ {json, urlencoded, raw, text}` (rootObjectName in {express, bodyParser}); and
 *   - a bare `<m>(…)` call whose callee is a local bound to that same named
 *     export of `body-parser` (`import { json } from "body-parser"`, or the
 *     destructured `require` form). Aliases are followed; the member form is
 *     preferred, and an unrelated `json()` never matches.
 *
 * ❌ app.use(express.json({ type: "*\/*" }));
 * ❌ app.use(bodyParser.urlencoded({ type: () => true }));
 * ❌ express.raw({ type: "*\/*" });
 * ✅ app.use(express.json());                                  // default: application/json
 * ✅ app.use(express.json({ type: "application/json" }));
 * ✅ app.use(express.json({ type: ["application/json", "application/*+json"] }));
 * ✅ app.use(express.json({ type: userType }));                // dynamic — unprovable
 */

/** Parser methods whose `type` option governs content-type negotiation. */
const PARSER_METHODS = new Set(["json", "urlencoded", "raw", "text"]);

/** Literal member receivers we treat as the express / body-parser API. */
const PARSER_RECEIVERS = new Set(["express", "bodyParser"]);

/** Is `node` a `require("body-parser")` call? */
const isRequireOfBodyParser = (node: AstNode | null | undefined): boolean =>
  !!node &&
  node.type === "CallExpression" &&
  getCalleeName(node) === "require" &&
  getStaticStringValue((node.arguments as AstNode[])?.[0]) === "body-parser";

/**
 * Local identifiers bound to a named parser export of `body-parser`, mapped to
 * the *imported* method name (so aliases like `import { json as bpJson }` still
 * report as `json`). Covers both `import { json } from "body-parser"` and the
 * destructured `const { json } = require("body-parser")` form.
 */
const collectBodyParserLocals = (program: AstNode): Map<string, string> => {
  const locals = new Map<string, string>();

  for (const decl of collectDescendants(program, (n) => n.type === "ImportDeclaration")) {
    if (getStaticStringValue(decl.source) !== "body-parser") continue;
    for (const spec of (decl.specifiers as AstNode[]) ?? []) {
      if (spec.type !== "ImportSpecifier") continue;
      const imported = spec.imported?.name;
      const local = spec.local?.name;
      if (typeof imported === "string" && typeof local === "string" && PARSER_METHODS.has(imported)) {
        locals.set(local, imported);
      }
    }
  }

  for (const decl of collectDescendants(program, (n) => n.type === "VariableDeclarator")) {
    if (!isRequireOfBodyParser(decl.init)) continue;
    const id = decl.id as AstNode | undefined;
    if (id?.type !== "ObjectPattern") continue;
    for (const prop of (id.properties as AstNode[]) ?? []) {
      if (prop.type !== "Property" || prop.computed) continue;
      const imported = prop.key?.name;
      const local = prop.value?.type === "Identifier" ? prop.value.name : undefined;
      if (typeof imported === "string" && typeof local === "string" && PARSER_METHODS.has(imported)) {
        locals.set(local, imported);
      }
    }
  }

  return locals;
};

/**
 * A function value that trivially resolves to `true` — the predicate form of a
 * catch-all `type`. Accepts an arrow with a `true` expression body (`() => true`)
 * and a function/arrow whose block body is exactly `return true;`.
 */
const isTrivialTrueFn = (node: AstNode | null | undefined): boolean => {
  if (!node) return false;
  if (node.type !== "ArrowFunctionExpression" && node.type !== "FunctionExpression") return false;
  const body = node.body as AstNode | undefined;
  if (!body) return false;
  // Arrow expression body: `() => true`.
  if (body.type !== "BlockStatement") return isLiteralTrue(body);
  // Block body: a single `return true;` and nothing else.
  const stmts = body.body as AstNode[];
  if (!Array.isArray(stmts) || stmts.length !== 1) return false;
  const only = stmts[0];
  return only?.type === "ReturnStatement" && isLiteralTrue(only.argument);
};

export const noWildcardBodyParser = defineDiagnostic({
  id: "no-wildcard-body-parser",
  title: "Body parser accepts any content-type",
  severity: "warn",
  category: "Security",
  scope: "file",
  confidence: "high",
  tags: ["injection", "http"],
  defaultEnabled: false,
  recommendation:
    "Scope the parser to the media type it actually handles — `express.json({ type: 'application/json' })`, a scoped subtype like `'application/*+json'` / `'text/*'`, or an explicit list. A `type` of `'*/*'` (or a `() => true` predicate) parses every body regardless of its declared Content-Type, so a mislabeled request bypasses content-type-based validation.",
  create: (ctx) => {
    // Bare `body-parser` named exports are resolved once per file; the member
    // forms need no import evidence (the `express.`/`bodyParser.` names are the
    // signal), matching the sibling body-parser diagnostics.
    const bodyParserLocals = collectBodyParserLocals(ctx.program);

    return {
      CallExpression: (node) => {
        const callee = unwrapChain(node.callee);
        if (!callee) return;
        const method = getMethodName(node);
        if (!method) return;

        // Resolve which parser method this call targets, or bail. `displayMethod`
        // is the API method name (json/urlencoded/raw/text) used in the message.
        let displayMethod: string;
        if (callee.type === "MemberExpression") {
          // Member form: `express.json` / `bodyParser.urlencoded` / … The IMMEDIATE
          // receiver object must be a bare `express`/`bodyParser` identifier — not a
          // deeper chain like `express.response.json` (the res.json RESPONSE
          // serializer), which is a different construct that must stay silent.
          if (!PARSER_METHODS.has(method)) return;
          const receiverObj = unwrapChain(callee.object);
          if (receiverObj?.type !== "Identifier" || !PARSER_RECEIVERS.has(receiverObj.name as string)) return;
          displayMethod = method;
        } else if (callee.type === "Identifier") {
          // Bare form: `json(…)` where the local is a named body-parser export.
          const imported = bodyParserLocals.get(callee.name);
          if (!imported) return;
          displayMethod = imported;
        } else {
          return;
        }

        // The options object must be a literal we can read; an identifier or a
        // call is opaque, and no options at all means the default (specific)
        // type — both safe, so stay silent.
        const opts = (node.arguments as AstNode[])[0];
        if (!opts || opts.type !== "ObjectExpression") return;

        // We fire only on a POSITIVELY universal `type`. Absence of a `type`
        // property is the safe default; a spread that might carry one is not
        // proof of `*/*`, so it too stays silent.
        const typeProp = getObjectProperty(opts, "type");
        if (!typeProp) return;
        const typeVal = typeProp.value as AstNode;

        const wildcardString = getStaticStringValue(typeVal) === "*/*";
        const trivialTrue = isTrivialTrueFn(typeVal);
        if (!wildcardString && !trivialTrue) return;

        ctx.report(
          node,
          `this body parser accepts ANY content-type (\`type: '*/*'\`), so a form/text/binary body is parsed as \`${displayMethod}\` and a client can mislabel a body to bypass content-type-based validation. Scope the parser to the media type it handles (e.g. \`express.json({ type: 'application/json' })\`).`,
        );
      },
    };
  },
});
