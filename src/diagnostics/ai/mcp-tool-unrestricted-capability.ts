import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode, Visitors } from "../../core/types.ts";
import {
  getMethodName,
  getStaticStringValue,
  isFunctionLike,
  rootObjectName,
} from "../../core/ast.ts";
import { collectDescendants, findDescendant } from "../../core/walk.ts";
import { hasMcpImport, referencesNames } from "./signals.ts";

/**
 * An MCP tool handler that runs a high-blast-radius operation on an argument the
 * MODEL controls. An MCP tool is called by the language model, not by a person
 * who read your code — so a tool that shells out, writes the filesystem, runs a
 * raw SQL string, or `eval`s a value built from its own arguments is a direct
 * remote-code-execution / path-traversal surface the moment the model is
 * prompt-injected. The schema only constrains the argument's *type*
 * (`z.string()`), never its *value*, so `"; rm -rf /"` or `"../../etc/passwd"`
 * passes validation untouched.
 *
 * Fires only when a tool-handler parameter actually flows into such a sink, and
 * the sink call (`exec`, `writeFile`, `$queryRawUnsafe`, …) is provably the
 * dangerous one — the `child_process`/`fs` binding is resolved from the file's
 * own imports, so `regex.exec(x)` or an ORM `.query()` is not mistaken for it.
 *
 * Silent when the tool only reads/returns data, and when the argument is first
 * narrowed by an allowlist (`switch`, `.includes(...)`, or a `z.enum(...)`
 * schema) — that value-level restriction is exactly the fix.
 *
 * ❌ server.tool("run", schema, async ({ cmd }) => exec(cmd));
 * ❌ server.registerTool("read", schema, async ({ path }) => fs.writeFile(path, data));
 * ✅ server.tool("run", { cmd: z.enum(["ls", "pwd"]) }, async ({ cmd }) => exec(cmd));
 * ✅ server.tool("weather", schema, async ({ city }) => db.city.findUnique({ where: { name: city } }));
 */

// Registration entry points that hand a model-driven handler an arguments object.
const REGISTER_METHODS = new Set(["tool", "registerTool", "setRequestHandler"]);

// child_process execution APIs — a shell or a new process, model-controlled.
const CP_EXEC = new Set([
  "exec",
  "execSync",
  "spawn",
  "spawnSync",
  "execFile",
  "execFileSync",
  "fork",
]);

// fs mutation APIs — write, delete, truncate. A model-controlled path is traversal.
const FS_WRITE = new Set([
  "writeFile",
  "writeFileSync",
  "appendFile",
  "appendFileSync",
  "unlink",
  "unlinkSync",
  "rm",
  "rmSync",
  "rmdir",
  "rmdirSync",
  "createWriteStream",
]);

// Always-raw SQL sinks, plus the ambiguous ones that need a SQL keyword.
const RAW_SQL = new Set(["$queryRawUnsafe", "$executeRawUnsafe"]);
const AMBIGUOUS_SQL = new Set(["query", "execute", "raw"]);
const SQL_KEYWORD_RE =
  /\b(select|insert\s+into|update|delete\s+from|from|where|join|values|drop|alter|truncate)\b/i;

interface ModuleBindings {
  cpNamespaces: Set<string>;
  cpNamed: Map<string, string>;
  fsNamespaces: Set<string>;
  fsNamed: Map<string, string>;
}

const CP_MODULES = new Set(["child_process", "node:child_process"]);
const FS_MODULES = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);

/** Names bound in a (possibly destructuring) binding target. */
const collectBindingNames = (pattern: AstNode | null | undefined, out: string[]): void => {
  if (!pattern) return;
  switch (pattern.type) {
    case "Identifier":
      out.push(pattern.name);
      break;
    case "AssignmentPattern":
      collectBindingNames(pattern.left as AstNode, out);
      break;
    case "RestElement":
      collectBindingNames(pattern.argument as AstNode, out);
      break;
    case "ArrayPattern":
      for (const el of (pattern.elements as (AstNode | null)[]) ?? []) collectBindingNames(el, out);
      break;
    case "ObjectPattern":
      for (const prop of (pattern.properties as AstNode[]) ?? []) {
        if (prop.type === "RestElement") collectBindingNames(prop.argument as AstNode, out);
        else collectBindingNames(prop.value as AstNode, out);
      }
      break;
    default:
      break;
  }
};

/** Resolve which local names bind `child_process` / `fs`, from imports and requires. */
const resolveModuleBindings = (program: AstNode): ModuleBindings => {
  const b: ModuleBindings = {
    cpNamespaces: new Set(),
    cpNamed: new Map(),
    fsNamespaces: new Set(),
    fsNamed: new Map(),
  };

  const bindImport = (node: AstNode): void => {
    const source = getStaticStringValue(node.source as AstNode);
    if (source === null) return;
    const isCp = CP_MODULES.has(source);
    const isFs = FS_MODULES.has(source);
    if (!isCp && !isFs) return;
    for (const spec of (node.specifiers as AstNode[]) ?? []) {
      const local = spec.local?.name as string | undefined;
      if (!local) continue;
      if (spec.type === "ImportDefaultSpecifier" || spec.type === "ImportNamespaceSpecifier") {
        (isCp ? b.cpNamespaces : b.fsNamespaces).add(local);
      } else if (spec.type === "ImportSpecifier") {
        const imported = (spec.imported?.name as string | undefined) ?? local;
        (isCp ? b.cpNamed : b.fsNamed).set(local, imported);
      }
    }
  };

  const bindRequire = (decl: AstNode): void => {
    const init = decl.init as AstNode | undefined;
    if (!init || init.type !== "CallExpression") return;
    if ((init.callee as AstNode)?.type !== "Identifier" || (init.callee as AstNode).name !== "require") {
      return;
    }
    const source = getStaticStringValue((init.arguments as AstNode[])?.[0]);
    if (source === null) return;
    const isCp = CP_MODULES.has(source);
    const isFs = FS_MODULES.has(source);
    if (!isCp && !isFs) return;
    const id = decl.id as AstNode;
    if (id.type === "Identifier") {
      (isCp ? b.cpNamespaces : b.fsNamespaces).add(id.name);
    } else if (id.type === "ObjectPattern") {
      for (const prop of (id.properties as AstNode[]) ?? []) {
        if (prop.type !== "Property") continue;
        const imported = prop.key?.name as string | undefined;
        const local = prop.value?.name as string | undefined;
        if (imported && local) (isCp ? b.cpNamed : b.fsNamed).set(local, imported);
      }
    }
  };

  for (const node of collectDescendants(program, (n) => n.type === "ImportDeclaration")) {
    bindImport(node);
  }
  for (const node of collectDescendants(program, (n) => n.type === "VariableDeclaration")) {
    for (const decl of (node.declarations as AstNode[]) ?? []) bindRequire(decl);
  }
  return b;
};

/** The static text an expression contributes, folding template + string concat. */
const staticText = (a: AstNode | null | undefined): string => {
  if (!a) return "";
  const s = getStaticStringValue(a);
  if (s !== null) return s;
  if (a.type === "TemplateLiteral") {
    return (a.quasis as AstNode[]).map((q) => q.value?.cooked ?? q.value?.raw ?? "").join(" ");
  }
  // `"SELECT … " + name + " …"` — recurse so a concatenated query is still
  // recognized as SQL (a dynamic value between two static SQL fragments).
  if (a.type === "BinaryExpression" && a.operator === "+") {
    return `${staticText(a.left as AstNode)} ${staticText(a.right as AstNode)}`;
  }
  return "";
};

const argsText = (args: AstNode[]): string => args.map(staticText).join(" ");

/** Classify a sink call/new as a dangerous operation, or null. */
const classifySink = (node: AstNode, b: ModuleBindings): string | null => {
  if (node.type === "NewExpression") {
    const callee = node.callee as AstNode;
    return callee?.type === "Identifier" && callee.name === "Function" ? "code (new Function)" : null;
  }
  if (node.type !== "CallExpression") return null;

  const callee = node.callee as AstNode;

  // Bare identifier calls: eval, or a named import of exec/writeFile/…
  if (callee?.type === "Identifier") {
    if (callee.name === "eval") return "code (eval)";
    const cp = b.cpNamed.get(callee.name);
    if (cp && CP_EXEC.has(cp)) return "a shell/process";
    const fsm = b.fsNamed.get(callee.name);
    if (fsm && FS_WRITE.has(fsm)) return "the filesystem";
    return null;
  }

  const method = getMethodName(node);
  if (!method) return null;
  const root = rootObjectName(callee);

  if (CP_EXEC.has(method) && root !== null && b.cpNamespaces.has(root)) return "a shell/process";
  if (FS_WRITE.has(method) && root !== null && b.fsNamespaces.has(root)) return "the filesystem";
  if (RAW_SQL.has(method)) return "a raw SQL query";
  if (AMBIGUOUS_SQL.has(method) && SQL_KEYWORD_RE.test(argsText((node.arguments as AstNode[]) ?? []))) {
    return "a raw SQL query";
  }
  return null;
};

/** Does an allowlist narrow a tool argument to a fixed value set before the sink? */
const isValueGuarded = (
  handler: AstNode,
  registration: AstNode,
  paramNames: Set<string>,
): boolean => {
  // A `z.enum([...])` (or any `.enum(...)`) in the schema arguments.
  for (const arg of (registration.arguments as AstNode[]) ?? []) {
    if (isFunctionLike(arg)) continue;
    const hasEnum =
      (arg.type === "CallExpression" && getMethodName(arg) === "enum") ||
      findDescendant(arg, (n) => n.type === "CallExpression" && getMethodName(n) === "enum") !== null;
    if (hasEnum) return true;
  }
  // A `switch` on the argument, or an `.includes(...)` allowlist referencing it.
  const guard = findDescendant(handler, (n) => {
    if (n.type === "SwitchStatement") return referencesNames(n.discriminant as AstNode, paramNames);
    if (n.type === "CallExpression" && getMethodName(n) === "includes") {
      return referencesNames(n, paramNames);
    }
    return false;
  });
  return guard !== null;
};

export const mcpToolUnrestrictedCapability = defineDiagnostic({
  id: "mcp-tool-unrestricted-capability",
  title: "MCP tool runs a high-blast-radius operation on model-controlled input",
  severity: "error",
  category: "Security",
  tags: ["mcp", "ai", "injection", "rce"],
  requires: ["mcp"],
  confidence: "high",
  recommendation:
    "Never pass a tool argument straight into `exec`/`spawn`, an `fs` write/delete, a raw SQL string, or `eval`. Constrain the value with a `z.enum(...)` schema or an explicit allowlist, and prefer array-argument, shell-free APIs (`execFile`) with a fixed command.",
  create: (ctx): Visitors => {
    // `requires` gates selection in a real scan; self-check so the rule is also
    // inert when driven directly (LSP / tests) without the `mcp` capability.
    if (!ctx.hasCapability("mcp") || !hasMcpImport(ctx.program)) return {};
    const bindings = resolveModuleBindings(ctx.program);

    return {
      CallExpression: (node) => {
        const method = getMethodName(node);
        if (!method || !REGISTER_METHODS.has(method)) return;

        // The handler is the last function-valued argument.
        const args = (node.arguments as AstNode[]) ?? [];
        let handler: AstNode | null = null;
        for (let i = args.length - 1; i >= 0; i--) {
          if (isFunctionLike(args[i]!)) {
            handler = args[i]!;
            break;
          }
        }
        if (!handler) return;

        // The first parameter carries the model-controlled arguments.
        const firstParam = (handler.params as AstNode[])?.[0];
        const names: string[] = [];
        collectBindingNames(firstParam, names);
        const paramNames = new Set(names);
        if (paramNames.size === 0) return;

        if (isValueGuarded(handler, node, paramNames)) return;

        // Any sink in the handler body driven by a tool argument.
        const body = (handler.body as AstNode) ?? handler;
        const sinks = collectDescendants(
          body,
          (n) => n.type === "CallExpression" || n.type === "NewExpression",
          undefined,
          true,
        );
        for (const sink of sinks) {
          const kind = classifySink(sink, bindings);
          if (!kind) continue;
          const sinkArgs = (sink.arguments as AstNode[]) ?? [];
          if (!sinkArgs.some((a) => referencesNames(a, paramNames))) continue;
          // A parameterized query — `db.query("… WHERE id = $1", [args.id])` — is
          // the SAFE form: the tool argument is bound separately, never welded
          // into SQL, so a read-only tool's normal shape is not an injection. For
          // an *ambiguous* SQL method (`query`/`execute`/`raw`), only fire when the
          // argument reaches the query STRING itself (the first argument); a
          // reference confined to a later params array is the safe binding.
          // `$queryRawUnsafe`/`$executeRawUnsafe` take the raw string as their sole
          // query argument, so any tool arg there is unsafe by definition.
          if (kind === "a raw SQL query" && !RAW_SQL.has(getMethodName(sink) ?? "")) {
            const sqlString = sinkArgs[0];
            if (!sqlString || !referencesNames(sqlString, paramNames)) continue;
          }
          ctx.report(
            sink,
            `This MCP tool passes a model-controlled argument into ${kind} — the model, not a person, drives this call, so a prompt injection turns the tool into a remote-execution surface. Constrain the value with an allowlist/enum.`,
          );
        }
      },
    };
  },
});
