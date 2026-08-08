import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { collectDescendants } from "../../core/walk.ts";

/**
 * §199 — `__dirname` / `__filename` in a file that is an ES module.
 *
 * They are CommonJS wrapper parameters. In an ES module they are not defined at
 * all, so the first line that reads one throws `ReferenceError: __dirname is not
 * defined` — at module evaluation, before anything else in the process runs:
 *
 *   ❌ const templates = join(__dirname, "templates");
 *   ✅ const here = dirname(fileURLToPath(import.meta.url));
 *   ✅ const here = import.meta.dirname;          // Node 20.11+
 *
 * This is the single commonest breakage when a package flips `"type": "module"`,
 * and it is invisible until the module is actually loaded — a lazily-imported
 * route file or a CLI subcommand can carry it to production untouched.
 *
 * PRECISION MODEL. The claim is "this file is an ES module", and being wrong
 * about that turns a correct CommonJS file into a false report — so the module
 * system has to be PROVEN, not inferred from the presence of `import`:
 *
 *   - `.mjs` / `.mts` is conclusive by extension.
 *   - `import.meta` anywhere in the file is conclusive by syntax: it does not
 *     parse in CommonJS, and TypeScript rejects it unless the module target is
 *     an ES one.
 *   - Otherwise, only a `.js`/`.jsx` file in a package whose manifest declares
 *     `"type": "module"`, and only when it really has `import`/`export` syntax.
 *     A `.ts` file is NOT judged this way: whether its output is ESM or CJS is a
 *     `tsconfig` question this cannot see.
 *   - A LOCAL `__dirname` — the `fileURLToPath` shim everybody writes — is an
 *     ordinary variable, and the rule says nothing about it.
 *   - A `typeof __dirname` guard makes the file DUAL-MODE, and the rule goes
 *     silent for that name across the whole file. `typeof` is the one operator
 *     that may name an undeclared binding without throwing, so the guard itself
 *     is safe — and the branch it protects is the one that only runs where the
 *     name does exist:
 *         const here = typeof __dirname === "undefined"
 *           ? dirname(fileURLToPath(import.meta.url))
 *           : __dirname;                              // never evaluated in ESM
 *   - A TOOL CONFIG file (`*.config.js`, `vite.config.mjs`, …) is exempt. This
 *     rule claims what NODE does when it evaluates the module, and a config is
 *     loaded by the tool's own loader: Vite and friends bundle it through
 *     esbuild with `__dirname`, `__filename` and `import.meta.url` defined, so
 *     the CommonJS names really are there.
 *   - A BUNDLER MARKER — `import.meta.env`, `import.meta.hot`,
 *     `import.meta.webpackHot` — is the same story without the filename. None of
 *     them exists in Node, so a file using one is compiled by Vite or webpack
 *     before it runs, and those compilers define `__dirname` in a Node-targeted
 *     build. The electron-vite main-process template is verbatim this shape.
 *   - Only a REFERENCE counts. An interface member, a class field, a re-export
 *     specifier, an import alias and a TypeScript parameter property all merely
 *     spell the name; none of them reads a binding.
 */

const CJS_WRAPPER_NAMES = new Set(["__dirname", "__filename"]);

/** ESM by extension, with no appeal. */
const isEsmExtension = (filePath: string): boolean => /\.(mjs|mts)$/i.test(filePath);

/** CommonJS by extension, with no appeal. */
const isCjsExtension = (filePath: string): boolean => /\.(cjs|cts)$/i.test(filePath);

/**
 * A tool's config file, which that tool loads itself. Vite, Vitest, Nuxt, Astro
 * and the rest bundle the config through esbuild with `__dirname` defined, so
 * the CommonJS names are present however the package declares its type.
 */
const isToolConfig = (filePath: string): boolean =>
  /(^|[\\/])[^\\/]*\.config\.[cm]?[jt]sx?$/i.test(filePath);

/** `import.meta` members that only a bundler ever provides. */
const BUNDLER_META = new Set(["env", "hot", "webpackHot", "webpackContext", "glob", "globEager"]);

/**
 * Parent slots that hold a NAME rather than a reference. An identifier sitting
 * in one of these is spelling something — a member, an export, a type — and
 * never reads a binding, so it cannot throw.
 */
const NAME_SLOTS = new Set(["key", "id", "imported", "exported", "local", "label", "typeName", "parameter"]);

/** Is `node` occupying a name slot of its parent, rather than a value slot? */
const isNamePosition = (node: AstNode): boolean => {
  const parent = node.parent as AstNode | undefined;
  if (!parent) return false;
  // A computed key IS an expression: `{ [__dirname]: 1 }` really reads it.
  if (parent.computed === true && (parent.key as AstNode | undefined) === node) return false;
  if (parent.type === "MemberExpression" && (parent.property as AstNode) === node && !parent.computed) return true;
  for (const slot of NAME_SLOTS) {
    if ((parent as Record<string, unknown>)[slot] === node) return true;
  }
  return false;
};

/** Is any ancestor a TypeScript type construct, where nothing is evaluated? */
const inTypePosition = (node: AstNode): boolean => {
  let current: AstNode | null | undefined = node.parent;
  for (let depth = 0; current && depth < 64; depth++) {
    const type = current.type as string;
    if (type.startsWith("TS") && type !== "TSNonNullExpression" && type !== "TSAsExpression") return true;
    current = current.parent;
  }
  return false;
};

export const noDirnameInEsm = defineDiagnostic({
  id: "no-dirname-in-esm",
  title: "__dirname / __filename in an ES module is a ReferenceError",
  severity: "error",
  category: "Bugs",
  confidence: "high",
  tags: ["correctness", "esm", "modules"],
  recommendation:
    "Derive the directory from the module's own URL: `import { fileURLToPath } from \"node:url\"; const here = dirname(fileURLToPath(import.meta.url));` — or `import.meta.dirname` on Node 20.11+. `__dirname` and `__filename` are CommonJS wrapper parameters and do not exist in an ES module.",
  create: (ctx) => {
    const importMetas = collectDescendants(
      ctx.program,
      (n) => n.type === "MetaProperty" && (n.meta as AstNode | undefined)?.name === "import",
      undefined,
      true,
    );

    /** Does the file use `import.meta`? That alone proves it is an ES module. */
    const hasImportMeta = (): boolean => importMetas.length > 0;

    /** `import.meta.env` / `.hot` — proof the file is compiled before it runs. */
    const hasBundlerMarker = importMetas.some((meta) => {
      const parent = meta.parent as AstNode | undefined;
      if (parent?.type !== "MemberExpression" || parent.computed) return false;
      const property = (parent.property as AstNode | undefined)?.name;
      return typeof property === "string" && BUNDLER_META.has(property);
    });

    /** Top-level `import`/`export` syntax — necessary, but never sufficient alone. */
    const hasModuleSyntax = (): boolean =>
      ((ctx.program.body as AstNode[] | undefined) ?? []).some(
        (n) =>
          n.type === "ImportDeclaration" ||
          n.type === "ExportNamedDeclaration" ||
          n.type === "ExportDefaultDeclaration" ||
          n.type === "ExportAllDeclaration",
      );

    /**
     * Names the file guards with `typeof`. One such guard anywhere is proof the
     * author wrote for both module systems, and the rule steps back entirely.
     */
    const guardedNames = new Set<string>();
    for (const unary of collectDescendants(
      ctx.program,
      (n) => n.type === "UnaryExpression" && n.operator === "typeof",
      undefined,
      true,
    )) {
      const argument = unary.argument as AstNode | undefined;
      if (argument?.type === "Identifier" && typeof argument.name === "string") {
        guardedNames.add(argument.name as string);
      }
    }

    const provenEsm =
      !isCjsExtension(ctx.filePath) &&
      !isToolConfig(ctx.filePath) &&
      !hasBundlerMarker &&
      (isEsmExtension(ctx.filePath) ||
      hasImportMeta() ||
      // A `.js` file in a `"type": "module"` package IS an ES module. A `.ts`
      // file is not judged here — its emitted module format is a tsconfig
      // question, and guessing it would report correct CommonJS code.
        (/\.(js|jsx)$/i.test(ctx.filePath) && ctx.hasCapability("esm") && hasModuleSyntax()));

    return {
      Identifier: (node) => {
        if (!provenEsm) return;
        const name = node.name as string | undefined;
        if (typeof name !== "string" || !CJS_WRAPPER_NAMES.has(name)) return;
        if (guardedNames.has(name)) return;

        // Not a *reference*: `obj.__dirname`, `{ __dirname: x }`, an interface
        // member, a class field, `export { dir as __dirname }`, a type.
        if (isNamePosition(node) || inTypePosition(node)) return;

        // The `fileURLToPath` shim declares its own `__dirname`; that is a
        // normal variable and the whole point of the recommended fix.
        if (ctx.scope.getBinding(name, node) !== null) return;

        ctx.report(
          node,
          `\`${name}\` does not exist in an ES module — reading it throws \`ReferenceError: ${name} is not defined\` when this module is evaluated, before any of its own code runs. Use \`${
            name === "__dirname" ? "dirname(fileURLToPath(import.meta.url))" : "fileURLToPath(import.meta.url)"
          }\`, or \`import.meta.${name === "__dirname" ? "dirname" : "filename"}\` on Node 20.11+.`,
        );
      },
    };
  },
});
