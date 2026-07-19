import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import {
  getMethodName,
  hasInterpolation,
  isStringConcatWithVariable,
  looksCallerControlled,
} from "../../core/ast.ts";

/**
 * SQL built by string interpolation instead of parameter binding. An interpolated
 * query has already lost the data/grammar boundary before the driver sees it.
 * Prisma's *tagged* `$queryRaw` template parameterizes every `${}` and is a
 * `TaggedTemplateExpression` (not a call), so it is naturally not matched — only
 * the unsafe call forms are.
 *
 * ❌ db.query(`SELECT * FROM users WHERE email = '${req.body.email}'`);
 * ❌ db.$queryRawUnsafe(`SELECT * FROM users WHERE id = ${id}`);
 * ✅ db.query("SELECT * FROM users WHERE email = $1", [email]);
 * ✅ db.$queryRaw`SELECT * FROM users WHERE id = ${id}`;  // tagged template, safe
 */

// Always-SQL Prisma raw sinks — no keyword heuristic needed.
const RAW_SINKS = new Set(["$queryRawUnsafe", "$executeRawUnsafe"]);
// Ambiguous method names — require a SQL keyword to avoid flagging non-SQL calls.
const AMBIGUOUS_SINKS = new Set(["query", "execute", "raw", "unsafe"]);
const SQL_KEYWORD_RE = /\b(select|insert\s+into|update|delete\s+from|from|where|join|values|drop|alter|truncate)\b/i;

/** Concatenate the static text of a template/concat so we can keyword-test it. */
const staticText = (node: AstNode): string => {
  if (node.type === "TemplateLiteral") {
    return (node.quasis as AstNode[]).map((q) => q.value?.cooked ?? q.value?.raw ?? "").join(" ");
  }
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "BinaryExpression" && node.operator === "+") {
    return `${staticText(node.left)} ${staticText(node.right)}`;
  }
  return "";
};

export const noSqlTemplateInterpolation = defineDiagnostic({
  id: "no-sql-template-interpolation",
  title: "SQL built by string interpolation",
  severity: "error",
  category: "Security",
  tags: ["db", "injection"],
  recommendation:
    "Use parameter binding: `db.query('SELECT ... WHERE id = $1', [id])`, Prisma's tagged `$queryRaw` template, or the query builder. Interpolation loses the data/grammar boundary before the driver sees it.",
  create: (ctx) => ({
    CallExpression: (node) => {
      const method = getMethodName(node);
      if (!method) return;
      const isRaw = RAW_SINKS.has(method);
      const isAmbiguous = AMBIGUOUS_SINKS.has(method);
      if (!isRaw && !isAmbiguous) return;

      const arg0 = (node.arguments as AstNode[])[0];
      if (!arg0) return;
      if (!hasInterpolation(arg0) && !isStringConcatWithVariable(arg0)) return;

      // For ambiguous sinks, require the string to actually look like SQL.
      if (isAmbiguous && !SQL_KEYWORD_RE.test(staticText(arg0))) return;

      const tainted = looksCallerControlled(arg0, ctx.taintedBindings);
      ctx.report(
        arg0,
        tainted
          ? "SQL is built from caller-controlled input via interpolation — this is SQL injection."
          : "SQL built by string interpolation instead of parameter binding — the data/grammar boundary is lost before the driver sees it.",
      );
    },
  }),
});
