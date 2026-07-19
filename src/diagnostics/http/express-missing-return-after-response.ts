import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, rootObjectName } from "../../core/ast.ts";

/**
 * A guard clause sends a response but does not `return`, so execution falls
 * through into the code the guard was meant to prevent — running the protected
 * logic anyway and then responding a second time (`ERR_HTTP_HEADERS_SENT`).
 *
 * ❌ if (!req.body.email) { res.status(400).json({ error: "email required" }); }
 *    const user = await db.user.findUnique(...); // runs even when email is missing
 * ✅ if (!req.body.email) { return res.status(400).json({ error: "email required" }); }
 */

const TERMINAL = new Set(["json", "send", "end", "redirect", "render", "sendFile", "sendStatus", "jsonp", "download"]);
const RESPONSE_ROOTS = new Set(["res", "response", "reply"]);

const isResponseTerminalCall = (expr: AstNode): boolean => {
  if (expr.type !== "CallExpression") return false;
  const method = getMethodName(expr);
  if (!method || !TERMINAL.has(method)) return false;
  const root = rootObjectName(expr.callee);
  return !!root && RESPONSE_ROOTS.has(root);
};

const containingBody = (node: AstNode): AstNode[] | null => {
  const parent = node.parent;
  if (!parent) return null;
  if (parent.type === "BlockStatement" || parent.type === "Program") return parent.body as AstNode[];
  return null;
};

export const expressMissingReturnAfterResponse = defineDiagnostic({
  id: "express-missing-return-after-response",
  title: "Response sent in a guard without a return",
  severity: "error",
  category: "Bugs",
  requires: ["express"],
  tags: ["express"],
  recommendation:
    "Prefix the guard's response with `return` (`return res.status(400).json(...)`). A response call does not stop the handler — without `return`, the 'rejected' request runs the protected logic and responds twice.",
  create: (ctx) => ({
    IfStatement: (node) => {
      if (node.alternate) return; // has else → not a fall-through guard

      const consequent = node.consequent;
      const stmts = consequent.type === "BlockStatement" ? (consequent.body as AstNode[]) : [consequent];
      const last = stmts[stmts.length - 1];
      if (!last || last.type !== "ExpressionStatement") return;
      if (!isResponseTerminalCall(last.expression)) return;

      // There must be code after the guard for the fall-through to bite.
      const body = containingBody(node);
      if (!body) return;
      const idx = body.indexOf(node);
      if (idx === -1 || idx === body.length - 1) return;

      ctx.report(
        last.expression,
        "This guard sends a response but does not `return` — execution falls through into the protected code and responds twice.",
      );
    },
  }),
});
