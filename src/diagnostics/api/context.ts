/**
 * Shared context helpers for the API (GraphQL / gRPC) diagnostics.
 *
 * These rules all key off *server setup*, not schema or proto contents, so what
 * they need in common is narrow: which package the file talks to, and whether a
 * risky literal sits under an environment guard. Nothing here reports; every
 * helper is a pure predicate that biases toward "unknown → stay silent".
 */

import type { AstNode } from "../../core/types.ts";
import { getStaticStringValue, staticMemberPath } from "../../core/ast.ts";
import { collectDescendants, findDescendant } from "../../core/walk.ts";

/**
 * Every module specifier the file imports or requires.
 *
 * Used as provenance: a call shape like `credentials.createInsecure()` is only
 * gRPC if the file actually pulls in a gRPC package. Without that evidence we
 * would be guessing, and a guess that fires is a false positive.
 */
export const moduleSpecifiers = (program: AstNode): Set<string> => {
  const out = new Set<string>();
  const add = (node: AstNode | null | undefined): void => {
    const value = getStaticStringValue(node);
    if (value !== null) out.add(value);
  };
  for (const node of collectDescendants(program, (n) => {
    if (n.type === "ImportDeclaration") return true;
    if (n.type === "ImportExpression") return true;
    if (n.type === "CallExpression") {
      const callee = staticMemberPath(n.callee);
      return callee === "require" || callee === "require.resolve";
    }
    return false;
  })) {
    if (node.type === "ImportDeclaration") add(node.source as AstNode);
    else if (node.type === "ImportExpression") add(node.source as AstNode);
    else add(((node.arguments as AstNode[] | undefined) ?? [])[0]);
  }
  return out;
};

/** Does any imported specifier match `pattern`? */
export const importsMatching = (program: AstNode, pattern: RegExp): boolean => {
  for (const spec of moduleSpecifiers(program)) {
    if (pattern.test(spec)) return true;
  }
  return false;
};

/**
 * Words that mark a branch as an environment/mode decision rather than a
 * production code path. Split from camelCase and snake_case, so `NODE_ENV`,
 * `isDev`, `__DEV__` and `config.appMode` all land here.
 */
const ENV_WORDS = new Set([
  "ci",
  "debug",
  "dev",
  "develop",
  "development",
  "e2e",
  "env",
  "environment",
  "local",
  "localhost",
  "mock",
  "mode",
  "offline",
  "prod",
  "production",
  "sandbox",
  "stage",
  "staging",
  "test",
  "testing",
]);

/** Lowercased words of an identifier or dotted path (`NODE_ENV` → node, env). */
const words = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase());

/** Does this identifier / member path name an environment or mode signal? */
const isEnvSignalName = (name: string): boolean => words(name).some((w) => ENV_WORDS.has(w));

/** Does the subtree at `node` read an environment or mode signal? */
export const readsEnvSignal = (node: AstNode | null | undefined): boolean => {
  if (!node) return false;
  const test = (n: AstNode): boolean => {
    if (n.type === "Identifier") return isEnvSignalName(n.name);
    if (n.type === "MemberExpression") {
      const path = staticMemberPath(n);
      return path !== null && isEnvSignalName(path);
    }
    return false;
  };
  return test(node) || findDescendant(node, test) !== null;
};

/**
 * Is `node` inside a branch chosen by an environment/mode check?
 *
 * `if (process.env.NODE_ENV !== "production") { … }` and `isDev && …` are the
 * correct way to keep a dev-only affordance out of production, and flagging them
 * would make the rule wrong on exactly the code that got it right. We accept the
 * resulting false negatives (`if (config.env === "production")` is silenced too)
 * because silence on ambiguity is the house rule.
 */
export const isUnderEnvGuard = (node: AstNode): boolean => {
  let current: AstNode | null = node;
  let parent: AstNode | null | undefined = node.parent;
  while (parent) {
    switch (parent.type) {
      case "IfStatement":
      case "ConditionalExpression":
        // Only the branches are guarded — the test itself is not.
        if (parent.test !== current && readsEnvSignal(parent.test as AstNode)) return true;
        break;
      case "LogicalExpression":
        if (parent.right === current && readsEnvSignal(parent.left as AstNode)) return true;
        break;
      case "SwitchCase":
        if (readsEnvSignal((parent.parent as AstNode | undefined)?.discriminant)) return true;
        break;
      default:
        break;
    }
    current = parent;
    parent = parent.parent;
  }
  return false;
};

/**
 * The literal prefix of a string-ish node: a plain string, or the leading static
 * chunk of a template (`` `localhost:${port}` `` → "localhost:"). Returns null
 * when nothing static is knowable.
 */
export const staticStringPrefix = (node: AstNode | null | undefined): string | null => {
  if (!node) return null;
  const whole = getStaticStringValue(node);
  if (whole !== null) return whole;
  if (node.type === "TemplateLiteral") {
    const first = (node.quasis as AstNode[] | undefined)?.[0];
    const raw = first?.value?.cooked ?? first?.value?.raw;
    return typeof raw === "string" && raw.length > 0 ? raw : null;
  }
  return null;
};
