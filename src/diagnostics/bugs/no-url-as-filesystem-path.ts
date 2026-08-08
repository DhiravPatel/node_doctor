import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, getStaticStringValue } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";

/**
 * §199 — `import.meta.url` used where a filesystem path is required.
 *
 * `import.meta.url` is a **URL string** — `file:///srv/app/dist/index.js` — not a
 * path. `node:path` has no idea what a URL is, so it treats the whole thing as a
 * relative segment and produces a path that exists nowhere:
 *
 *   ❌ join(import.meta.url, "../templates")
 *      → "file:/srv/app/dist/templates"        (one slash, and relative)
 *   ❌ readFileSync(import.meta.url)           → ENOENT, on a file that is right there
 *   ✅ join(dirname(fileURLToPath(import.meta.url)), "../templates")
 *   ✅ readFileSync(new URL(import.meta.url))  // fs accepts a URL *object*
 *
 * On Windows it is worse than wrong-looking: the URL carries a leading slash
 * before the drive letter (`file:///C:/app`), so any path built from it is
 * broken in a way that reproduces on exactly one operating system.
 *
 * PRECISION MODEL. The finding is the raw `import.meta.url` node sitting in a
 * path position, so every correct form excludes itself by construction:
 *
 *   - `fileURLToPath(import.meta.url)` and `new URL(import.meta.url)` pass a
 *     CALL, not the URL — nothing to match.
 *   - `import.meta.dirname` / `import.meta.filename` are real paths and are
 *     never touched.
 *   - `path` and `fs` must be PROVEN by import, and the name at the CALL SITE
 *     must still resolve to that import. `resolve` is the single most-shadowed
 *     identifier in Node — a Promise executor's own parameter, an injected
 *     resolver, `import-meta-resolve`'s `resolve(specifier, parentURL)` whose
 *     second argument really is a URL — and a flat set of names would call
 *     every one of them `node:path`.
 *   - Only the `path` members that rewrite the string are judged; see
 *     PATH_FUNCTIONS.
 *   - Only argument 0 of an `fs` call is a path position; `import.meta.url`
 *     written into a file as data is not a bug.
 */

const PATH_MODULES = new Set(["path", "node:path", "path/posix", "node:path/posix", "path/win32", "node:path/win32"]);
const FS_MODULES = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);

/**
 * The `path` members that a `file://` URL is provably WRONG for.
 *
 * Only these four rewrite the string: `join` and `normalize` collapse `///` to
 * `/` and lose the scheme's authority slashes, and `resolve`/`relative` measure
 * against `process.cwd()`. The rest are pure segment arithmetic and work fine on
 * a URL — `basename("file:///a/b.js")` really is `"b.js"`, `dirname` really does
 * yield the parent URL — so a module name, a log label, or a sibling URL built
 * that way is correct code and is never reported.
 */
const PATH_FUNCTIONS = new Set(["join", "resolve", "normalize", "relative"]);

/** `fs` members whose FIRST argument is a path. */
const FS_PATH_FUNCTIONS = new Set([
  "readFile",
  "readFileSync",
  "writeFile",
  "writeFileSync",
  "appendFile",
  "appendFileSync",
  "stat",
  "statSync",
  "lstat",
  "lstatSync",
  "access",
  "accessSync",
  "readdir",
  "readdirSync",
  "mkdir",
  "mkdirSync",
  "rm",
  "rmSync",
  "unlink",
  "unlinkSync",
  "rename",
  "renameSync",
  "copyFile",
  "copyFileSync",
  "open",
  "openSync",
  "realpath",
  "realpathSync",
  "createReadStream",
  "createWriteStream",
  "existsSync",
  "watch",
]);

/** Is this node exactly `import.meta.url`? */
const isImportMetaUrl = (node: AstNode | null | undefined): boolean => {
  if (!node || node.type !== "MemberExpression" || node.computed) return false;
  if ((node.property as AstNode | undefined)?.name !== "url") return false;
  const object = node.object as AstNode | undefined;
  return object?.type === "MetaProperty" && (object.meta as AstNode | undefined)?.name === "import";
};

export const noUrlAsFilesystemPath = defineDiagnostic({
  id: "no-url-as-filesystem-path",
  title: "import.meta.url used where a filesystem path is required",
  severity: "error",
  category: "Bugs",
  confidence: "high",
  tags: ["correctness", "esm", "filesystem"],
  recommendation:
    "Convert it first: `import { fileURLToPath } from \"node:url\"` and pass `fileURLToPath(import.meta.url)`, or hand `fs` a `new URL(…)` object rather than the string. `import.meta.url` is a `file://` URL, and `node:path` treats it as an ordinary relative segment.",
  create: (ctx) => {
    /** Local names bound to the `path` and `fs` modules, proven by import. */
    const pathNamespaces = new Set<string>();
    const pathFunctions = new Map<string, string>();
    const fsNamespaces = new Set<string>();
    const fsFunctions = new Map<string, string>();
    /**
     * Where each of those names was declared. A name is only the builtin at a
     * given call site if the scope resolver still reaches THIS declaration from
     * there — otherwise something nearer has taken the name over.
     */
    const declaredAt = new Map<string, AstNode>();

    const bindImport = (source: string, specifiers: AstNode[]): void => {
      const isPath = PATH_MODULES.has(source);
      const isFs = FS_MODULES.has(source);
      if (!isPath && !isFs) return;
      for (const spec of specifiers) {
        const local = (spec.local as AstNode | undefined)?.name;
        if (typeof local !== "string") continue;
        // The resolver records an import binding against the SPECIFIER node.
        declaredAt.set(local, spec);
        if (spec.type === "ImportSpecifier") {
          const imported = spec.imported as AstNode | undefined;
          const name = imported?.type === "Identifier" ? (imported.name as string) : null;
          if (name === null) continue;
          if (isPath && PATH_FUNCTIONS.has(name)) pathFunctions.set(local, name);
          if (isFs && FS_PATH_FUNCTIONS.has(name)) fsFunctions.set(local, name);
        } else {
          if (isPath) pathNamespaces.add(local);
          if (isFs) fsNamespaces.add(local);
        }
      }
    };

    for (const stmt of (ctx.program.body as AstNode[] | undefined) ?? []) {
      if (stmt.type !== "ImportDeclaration") continue;
      const source = stmt.source?.value;
      if (typeof source === "string") bindImport(source, (stmt.specifiers as AstNode[] | undefined) ?? []);
    }

    // `const { join } = require("node:path")` / `const path = require("path")`.
    for (const decl of collectDescendants(ctx.program, (n) => n.type === "VariableDeclarator", undefined, true)) {
      const init = decl.init as AstNode | undefined;
      if (init?.type !== "CallExpression") continue;
      const callee = init.callee as AstNode | undefined;
      if (callee?.type !== "Identifier" || callee.name !== "require") continue;
      const source = getStaticStringValue(((init.arguments as AstNode[] | undefined) ?? [])[0]);
      if (source === null) continue;
      const isPath = PATH_MODULES.has(source);
      const isFs = FS_MODULES.has(source);
      if (!isPath && !isFs) continue;
      const id = decl.id as AstNode | undefined;
      if (id?.type === "Identifier") {
        if (isPath) pathNamespaces.add(id.name as string);
        if (isFs) fsNamespaces.add(id.name as string);
        declaredAt.set(id.name as string, id);
        continue;
      }
      if (id?.type !== "ObjectPattern") continue;
      for (const prop of (id.properties as AstNode[] | undefined) ?? []) {
        if (prop.type !== "Property") continue;
        const key = prop.key as AstNode | undefined;
        const local = prop.value as AstNode | undefined;
        if (key?.type !== "Identifier" || local?.type !== "Identifier") continue;
        const name = key.name as string;
        if (isPath && PATH_FUNCTIONS.has(name)) pathFunctions.set(local.name as string, name);
        if (isFs && FS_PATH_FUNCTIONS.has(name)) fsFunctions.set(local.name as string, name);
        declaredAt.set(local.name as string, local);
      }
    }

    /**
     * Does `name`, as seen from `at`, still resolve to the import that bound
     * it? A nearer parameter, catch binding or inner `const` wins, and then the
     * callee is somebody else's function.
     */
    const stillTheBuiltin = (name: string, at: AstNode): boolean => {
      const declaration = declaredAt.get(name);
      if (!declaration) return false;
      const binding = ctx.scope.getBinding(name, at);
      // The import may not appear in the resolver's tables at all; what matters
      // is that nothing NEARER has claimed the name.
      return binding === null || binding.declNode === declaration;
    };

    /**
     * Which API does this call reach — and does it take a path everywhere, or
     * only in argument 0?
     */
    const classify = (call: AstNode): { api: string; firstArgOnly: boolean } | null => {
      const callee = call.callee as AstNode | undefined;
      if (callee?.type === "Identifier") {
        const local = callee.name as string;
        if (!stillTheBuiltin(local, callee)) return null;
        const asPath = pathFunctions.get(local);
        if (asPath !== undefined) return { api: `path.${asPath}`, firstArgOnly: false };
        const asFs = fsFunctions.get(local);
        if (asFs !== undefined) return { api: `fs.${asFs}`, firstArgOnly: true };
        return null;
      }
      if (callee?.type !== "MemberExpression") return null;
      const object = callee.object as AstNode | undefined;
      if (object?.type !== "Identifier") return null;
      const method = getMethodName(call);
      if (method === null) return null;
      const receiver = object.name as string;
      if (!stillTheBuiltin(receiver, object)) return null;
      if (pathNamespaces.has(receiver) && PATH_FUNCTIONS.has(method)) {
        return { api: `${receiver}.${method}`, firstArgOnly: false };
      }
      if (fsNamespaces.has(receiver) && FS_PATH_FUNCTIONS.has(method)) {
        return { api: `${receiver}.${method}`, firstArgOnly: true };
      }
      return null;
    };

    return {
      CallExpression: (node) => {
        const kind = classify(node);
        if (kind === null) return;
        const args = (node.arguments as AstNode[] | undefined) ?? [];
        const candidates = kind.firstArgOnly ? args.slice(0, 1) : args;
        for (const arg of candidates) {
          if (!isImportMetaUrl(arg)) continue;
          ctx.report(
            arg,
            `\`import.meta.url\` is a \`file://\` URL string, not a path — \`${kind.api}\` treats it as an ordinary relative segment and builds a path that exists nowhere (and on Windows the URL keeps a leading slash before the drive letter). Wrap it: \`fileURLToPath(import.meta.url)\`.`,
          );
        }
      },
    };
  },
});
