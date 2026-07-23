import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import {
  getCalleeName,
  getMethodName,
  getReceiverName,
  isFunctionLike,
  findEnclosingFunction,
  rootObjectName,
  unwrapChain,
} from "../../core/ast.ts";
import { collectDescendants, findDescendant } from "../../core/walk.ts";
import { importsMatching } from "../api/context.ts";
import { AI_SDK_IMPORT_RE, isModelResultCall, unwrapAwait } from "./shared.ts";

/**
 * Model OUTPUT used without validation in a dangerous position — the mirror of
 * prompt injection, where the *model* is the untrusted source. An LLM (especially
 * one an attacker has already prompt-injected) can return `rm -rf /`, a `DROP
 * TABLE`, a `<script>` tag, or `http://169.254.169.254/`. Feeding that text into
 * `eval`, a shell, a raw SQL string, an HTML response body, or an outbound URL
 * turns the model into a remote code / injection / SSRF primitive.
 *
 * A binding is treated as model-tainted when it is initialized directly from a
 * recognized LLM call, from a `.choices[0].message.content` / `.text` /
 * `.output_text` access on one, or aliased from another model-tainted binding.
 * Model output that is merely returned to the caller (`res.json({ answer })`),
 * logged, or stored is NOT a sink and stays silent.
 *
 * Gated twice: the `ai` capability and an AI-SDK import in the file.
 *
 * ❌ const { text } = await generateText(...); eval(text);
 * ❌ const c = (await openai.chat.completions.create(...)).choices[0].message.content; exec(c);
 * ❌ res.send(`<div>${answer}</div>`); // answer from the model → stored/reflected XSS
 * ✅ res.json({ answer });             // returned as data, not executed
 * ✅ const parsed = JSON.parse(text); if (ALLOWED.has(parsed.action)) run(parsed.action);
 */

// --- sink vocabularies ------------------------------------------------------

const EXEC_METHODS = new Set([
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "spawn",
  "spawnSync",
]);
const CHILD_PROCESS_RECEIVERS = new Set(["child_process", "childProcess", "cp", "cproc"]);

const RAW_SQL_SINKS = new Set(["$queryRawUnsafe", "$executeRawUnsafe"]);
const AMBIGUOUS_SQL_SINKS = new Set(["query", "execute", "raw"]);
const SQL_KEYWORD_RE =
  /\b(select|insert\s+into|update|delete\s+from|from|where|join|values|drop|alter|truncate)\b/i;

const HTML_BODY_SINKS = new Set(["send", "write", "end"]);
const RESPONSE_RECEIVERS = new Set(["res", "response", "reply"]);
const HTML_TAG_RE =
  /<\s*(?:\/\s*)?[a-zA-Z][a-zA-Z0-9-]*(?:[\s/>]|$)|<!\s*doctype/i;
const SANITIZER_RE = /(escape|sanitiz|encode|purif|xss|striptag|htmlspecialchars)/i;

const OUTBOUND_RECEIVERS = new Set(["http", "https", "axios"]);
const OUTBOUND_METHODS = new Set(["get", "request", "post", "put", "patch", "delete", "head"]);
const URL_GUARD_METHODS = new Set([
  "startsWith",
  "includes",
  "some",
  "every",
  "has",
  "indexOf",
  "test",
  "match",
]);

/** Result fields destructured off an LLM response that still hold model text. */
const RESULT_FIELDS = new Set(["text", "content", "output_text"]);

/** The static text of a template/`+`/literal, for keyword and tag tests. */
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

export const noLlmOutputInSink = defineDiagnostic({
  id: "no-llm-output-in-sink",
  title: "LLM output used unvalidated in a dangerous sink",
  severity: "error",
  category: "Security",
  requires: ["ai"],
  confidence: "high",
  tags: ["ai", "injection"],
  recommendation:
    "Treat model output as untrusted. Never eval/exec it or splice it into SQL, HTML, or a URL. Parse structured output and dispatch through an explicit allowlist, parameterize SQL, escape before rendering, and validate a URL's host against an allowlist.",
  create: (ctx) => {
    const isAiFile = importsMatching(ctx.program, AI_SDK_IMPORT_RE);

    /**
     * Does the root of this expression chain resolve to a recognized LLM call?
     * Walks down through `await`, member access, and call chains so
     * `(await openai...).choices[0].message.content` is recognized.
     */
    const isModelDerivedExpr = (node: AstNode | null | undefined): boolean => {
      let cur = unwrapChain(node ?? null);
      let hops = 0;
      while (cur && hops++ < 64) {
        if (isModelResultCall(cur)) return true;
        switch (cur.type) {
          case "AwaitExpression":
            cur = unwrapChain(cur.argument as AstNode);
            break;
          case "MemberExpression":
            cur = unwrapChain(cur.object as AstNode);
            break;
          case "CallExpression":
            cur = unwrapChain(cur.callee as AstNode);
            break;
          default:
            return false;
        }
      }
      return false;
    };

    // Names bound to model output. Collected in document order so an alias of an
    // earlier model binding (`const c = resp.choices[0].message.content`) is seen.
    const modelBindings = new Set<string>();

    const initIsModel = (init: AstNode | null | undefined): boolean => {
      if (!init) return false;
      const expr = unwrapAwait(init);
      if (isModelDerivedExpr(expr)) return true;
      // Alias / field access off an already-known model binding.
      const root = rootObjectName(expr);
      return root !== null && modelBindings.has(root);
    };

    /** Does the subtree reference model output — a model binding or an inline call? */
    const referencesModel = (node: AstNode | null | undefined): boolean => {
      if (!node) return false;
      if (isModelDerivedExpr(node)) return true;
      const isModelIdent = (d: AstNode): boolean =>
        d.type === "Identifier" && modelBindings.has(d.name);
      if (isModelIdent(node)) return true;
      return findDescendant(node, isModelIdent, isFunctionLike) !== null;
    };

    const report = (node: AstNode, message: string): void => ctx.report(node, message);

    /** Is this an exec/spawn call on child_process (not `regex.exec`)? */
    const isChildProcessExec = (node: AstNode): boolean => {
      const method = getMethodName(node);
      if (!method || !EXEC_METHODS.has(method)) return false;
      const callee = node.callee as AstNode;
      if (callee?.type === "Identifier") return true; // bare `exec(...)` (destructured)
      const root = rootObjectName(callee);
      return !!root && (CHILD_PROCESS_RECEIVERS.has(root) || root === "require");
    };

    /** The URL argument of a recognized outbound call, or null. */
    const outboundUrlArg = (node: AstNode): AstNode | null => {
      const callee = getCalleeName(node);
      const args = (node.arguments as AstNode[]) ?? [];
      if (callee === "fetch" || callee === "axios") return args[0] ?? null;
      const receiver = getReceiverName(node);
      const method = getMethodName(node);
      if (receiver && OUTBOUND_RECEIVERS.has(receiver) && method && OUTBOUND_METHODS.has(method)) {
        return args[0] ?? null;
      }
      return null;
    };

    const hasUrlGuard = (fn: AstNode | null): boolean =>
      !!fn &&
      findDescendant(fn, (n) => {
        if (n.type === "NewExpression" && getCalleeName(n) === "URL") return true;
        if (n.type === "CallExpression") {
          const m = getMethodName(n);
          if (m && URL_GUARD_METHODS.has(m)) return true;
        }
        return false;
      }) !== null;

    return {
      // Pass 1: collect model-tainted bindings in document order.
      Program: (root) => {
        for (const decl of collectDescendants(root, (n) => n.type === "VariableDeclarator")) {
          const init = decl.init as AstNode | undefined;
          if (!init || !initIsModel(init)) continue;
          const id = decl.id as AstNode;
          if (id.type === "Identifier") {
            modelBindings.add(id.name);
          } else if (id.type === "ObjectPattern") {
            // `const { text } = await generateText(...)` — only text-bearing fields.
            for (const prop of (id.properties as AstNode[]) ?? []) {
              if (prop.type !== "Property" || prop.computed) continue;
              const key = prop.key as AstNode;
              const keyName = key?.type === "Identifier" ? key.name : undefined;
              const val = prop.value as AstNode;
              if (keyName && RESULT_FIELDS.has(keyName) && val?.type === "Identifier") {
                modelBindings.add(val.name);
              }
            }
          }
        }
      },

      // Pass 2: model output reaching a dangerous sink.
      CallExpression: (node) => {
        if (!isAiFile) return;
        const args = (node.arguments as AstNode[]) ?? [];

        // eval(modelOutput)
        if (getCalleeName(node) === "eval") {
          if (args[0] && referencesModel(args[0])) {
            report(args[0], "LLM output is passed to `eval` — the model can return arbitrary source that then runs in your process. Parse structured output and dispatch through an allowlist instead.");
          }
          return;
        }

        // child_process exec*(modelOutput)
        if (isChildProcessExec(node)) {
          if (args[0] && referencesModel(args[0])) {
            report(args[0], "LLM output is passed to a child_process exec call — the model can return an arbitrary shell command. Use an argument array with a fixed executable and validate any model-chosen value against an allowlist.");
          }
          return;
        }

        // Raw SQL query built from model output.
        const method = getMethodName(node);
        if (method && (RAW_SQL_SINKS.has(method) || AMBIGUOUS_SQL_SINKS.has(method))) {
          const arg0 = args[0];
          if (arg0 && referencesModel(arg0)) {
            const alwaysSql = RAW_SQL_SINKS.has(method);
            if (alwaysSql || SQL_KEYWORD_RE.test(staticText(arg0))) {
              report(arg0, "LLM output is used in a raw SQL query string — the model can return SQL that alters the statement. Use parameter binding and pass model output only as a bound value.");
              return;
            }
          }
        }

        // HTML response body built from model output.
        if (method && HTML_BODY_SINKS.has(method)) {
          const receiver = rootObjectName(node.callee as AstNode);
          if (receiver && RESPONSE_RECEIVERS.has(receiver.toLowerCase())) {
            const arg0 = args[0];
            if (
              arg0 &&
              referencesModel(arg0) &&
              HTML_TAG_RE.test(staticText(arg0)) &&
              !SANITIZER_RE.test(ctx.sourceText.slice(arg0.start, arg0.end))
            ) {
              report(arg0, "LLM output is written into an HTML response body without escaping — a model can return `<script>`, giving stored/reflected XSS. Escape model output before rendering it as HTML.");
              return;
            }
          }
        }

        // Outbound request to a URL built from model output (SSRF).
        const url = outboundUrlArg(node);
        if (url && referencesModel(url) && !hasUrlGuard(findEnclosingFunction(node))) {
          report(url, "LLM output is used as an outbound request URL with no host allowlist — a model can return an internal or metadata endpoint (SSRF). Validate the host against an allowlist before the request.");
        }
      },

      // new Function(modelOutput)
      NewExpression: (node) => {
        if (!isAiFile) return;
        if (getCalleeName(node) !== "Function") return;
        const args = (node.arguments as AstNode[]) ?? [];
        for (const arg of args) {
          if (referencesModel(arg)) {
            report(arg, "LLM output is passed to `new Function` — the model can return arbitrary source that then runs in your process. Parse structured output and dispatch through an allowlist instead.");
            return;
          }
        }
      },
    };
  },
});
