import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { staticMemberPath } from "../../core/ast.ts";
import { findDescendant } from "../../core/walk.ts";

/**
 * A required env var read as if it is always defined — `process.env.FOO!`
 * (non-null assertion) or `process.env.FOO.something` (an immediate member
 * access on a value that is `string | undefined`). This is the "works on my
 * machine, undefined in prod" bug: the code parses and passes types, then the
 * moment the var is missing in a staging/CI/prod environment the very first use
 * throws `TypeError: Cannot read properties of undefined`, taking the process
 * down at boot. The non-null `!` is worse — it silences the compiler's own
 * `string | undefined` warning, so the missing var flows onward as `undefined`
 * with no diagnostic at all.
 *
 * Opt-in (`defaultEnabled: false`): guarding every env read is a deliberate
 * house style, and a team that centralises config validation elsewhere does not
 * want this noise. When on, it fires ONLY on the two crash shapes and stays
 * silent on every defaulting/guarding form, because a false positive here would
 * flag correct, defensive code.
 *
 * ❌ const url = process.env.DATABASE_URL!;          // asserts non-null; a lie when unset
 * ❌ const parts = process.env.REGION.split("-");    // throws when REGION is unset
 * ✅ const url = process.env.DATABASE_URL ?? "";     // defaulted
 * ✅ if (process.env.REGION) process.env.REGION.split("-");  // guarded
 * ✅ const { REGION } = process.env;                 // plain read, no assumption
 */

/**
 * If `node` is a `process.env.<NAME>` read with a statically-known name, return
 * that name; otherwise null. A dynamic key (`process.env[key]`) is unknowable,
 * so we return null and stay silent rather than guess a name for the message.
 */
const envVarName = (node: AstNode | null | undefined): string | null => {
  if (!node || node.type !== "MemberExpression") return null;
  // The object must be exactly `process.env` — an aliased `env.FOO` is out of
  // scope precisely because we cannot prove `env` is `process.env`.
  if (staticMemberPath(node.object) !== "process.env") return null;
  const key = node.property as AstNode;
  if (node.computed) {
    return key?.type === "Literal" && typeof key.value === "string" ? key.value : null;
  }
  return key?.type === "Identifier" ? key.name : null;
};

/** Does the subtree at `node` read `process.env.<varName>`? */
const referencesEnvVar = (node: AstNode | null | undefined, varName: string): boolean => {
  if (!node) return false;
  const test = (n: AstNode): boolean => envVarName(n) === varName;
  return test(node) || findDescendant(node, test) !== null;
};

/**
 * Is the env read at `node` inside a branch guarded by a check of that same
 * var? `if (process.env.FOO) { process.env.FOO.trim(); }` and
 * `process.env.FOO && process.env.FOO.trim()` are the correct defensive forms;
 * firing on them would flag exactly the code that got it right. We only require
 * the *same* var name so an unrelated guard does not silence a real crash.
 */
const isGuardedForVar = (node: AstNode, varName: string): boolean => {
  let current: AstNode = node;
  let parent: AstNode | null | undefined = node.parent;
  while (parent) {
    switch (parent.type) {
      case "IfStatement":
      case "ConditionalExpression":
        // The test itself is not guarded — only the consequent/alternate are.
        if (parent.test !== current && referencesEnvVar(parent.test as AstNode, varName)) return true;
        break;
      case "LogicalExpression":
        // `left && right` / `left ?? right`: the right operand runs after left.
        if (parent.right === current && referencesEnvVar(parent.left as AstNode, varName)) return true;
        break;
      case "BlockStatement":
      case "Program":
        // Early-exit guard in a *preceding* sibling statement — the canonical
        // "validate at startup" idiom this rule's own recommendation endorses:
        //   if (!process.env.FOO) throw new Error(...);
        //   const x = process.env.FOO.split(",");   // provably defined here
        // After the guard runs, FOO is defined on every path that reaches this
        // statement, so the later access cannot crash.
        if (precededByExitGuard(parent, current, varName)) return true;
        break;
      default:
        break;
    }
    current = parent;
    parent = parent.parent;
  }
  return false;
};

/** Does this statement leave the current path — throw / return / process.exit / continue / break? */
const isEarlyExit = (stmt: AstNode | null | undefined): boolean => {
  if (!stmt) return false;
  if (stmt.type === "BlockStatement") {
    const body = (stmt.body as AstNode[]) ?? [];
    return body.some(isEarlyExit);
  }
  if (stmt.type === "ThrowStatement" || stmt.type === "ReturnStatement") return true;
  if (stmt.type === "ContinueStatement" || stmt.type === "BreakStatement") return true;
  // `process.exit(...)` as an expression statement.
  if (stmt.type === "ExpressionStatement") {
    const call = stmt.expression as AstNode | undefined;
    if (call?.type === "CallExpression" && staticMemberPath(call.callee as AstNode) === "process.exit") return true;
  }
  return false;
};

/**
 * Is there an earlier statement in this block of the form
 * `if (!process.env.VAR ...) <early exit>` before the statement containing the
 * access? Only an early-exit consequent counts: a plain `if (!FOO) log()` does
 * not make FOO defined afterwards.
 */
const precededByExitGuard = (block: AstNode, childStmt: AstNode, varName: string): boolean => {
  const body = (block.body as AstNode[]) ?? [];
  const idx = body.indexOf(childStmt);
  if (idx <= 0) return false;
  for (let i = 0; i < idx; i++) {
    const stmt = body[i]!;
    if (stmt.type !== "IfStatement") continue;
    if (!referencesEnvVar(stmt.test as AstNode, varName)) continue;
    // The guard must exit when the var is falsy; we approximate soundly by
    // requiring the consequent to be an early exit and no `else` branch.
    if (!stmt.alternate && isEarlyExit(stmt.consequent as AstNode)) return true;
  }
  return false;
};

export const noNonNullEnvAccess = defineDiagnostic({
  id: "no-unchecked-required-env",
  title: "Required env var used as if always defined",
  severity: "warn",
  category: "Reliability",
  requires: ["node"],
  defaultEnabled: false,
  tags: ["config", "env"],
  recommendation:
    "Default it (`process.env.FOO ?? fallback`), guard it (`if (process.env.FOO) …`), or validate all required vars once at startup. A non-null `!` or a direct member access crashes with `Cannot read properties of undefined` the first time the var is unset in an environment.",
  create: (ctx) => {
    const fire = (envNode: AstNode, name: string, kind: "assert" | "member"): void => {
      if (isGuardedForVar(envNode, name)) return;
      ctx.report(
        envNode,
        kind === "assert"
          ? `\`process.env.${name}!\` asserts the var is always defined — the assertion is a compile-time lie when \`${name}\` is unset, and the undefined value crashes at its first use.`
          : `\`process.env.${name}\` is used with a member access as if always defined — this crashes with "Cannot read properties of undefined" when \`${name}\` is unset in an environment.`,
      );
    };
    return {
      // `process.env.FOO!`
      TSNonNullExpression: (node) => {
        const name = envVarName(node.expression as AstNode);
        if (name !== null) fire(node.expression as AstNode, name, "assert");
      },
      // `process.env.FOO.something` — a member access whose object is the env read.
      MemberExpression: (node) => {
        // `process.env.FOO?.something` is optional-chained and cannot throw.
        if (node.optional) return;
        const objectNode = node.object as AstNode;
        const name = envVarName(objectNode);
        if (name !== null) fire(objectNode, name, "member");
      },
    };
  },
});
