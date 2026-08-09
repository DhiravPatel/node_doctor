import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { collectDescendants } from "../../core/walk.ts";
import { isTestFile } from "../../core/test-file.ts";

/**
 * §188 — writing to a module namespace object, which is sealed.
 *
 * `import * as NS from "…"` binds a **module namespace exotic object**. Its
 * `[[Set]]` returns `false` for every key, always — and ES module code is always
 * strict mode, where an assignment whose `[[Set]]` returns `false` throws. So in
 * an ES module this is an unconditional `TypeError` at that line:
 *
 *   ❌ import * as fs from "node:fs";
 *      fs.readFile = instrumented;      // TypeError: Cannot assign to read only
 *                                       // property 'readFile' of [object Module]
 *   ✅ const patched = { ...fs, readFile: instrumented };
 *   ✅ import { createRequire } from "node:module";
 *      const require = createRequire(import.meta.url);
 *      require("node:fs").readFile = instrumented;   // CJS object, mutable
 *
 * It arrives with a migration. `require("node:fs").readFile = wrapped` is legal
 * CommonJS and is how a generation of APM shims, test doubles and polyfills were
 * written; the mechanical ESM translation of it throws. Like `__dirname` in an
 * ES module, it can sit in a lazily-imported path until production.
 *
 * PRECISION MODEL. The module system has to be PROVEN, because the identical
 * sealed object behaves in **opposite** ways depending on who is reading it:
 *
 *   - In a proven ES module the write throws. Verified.
 *   - Loaded by a CommonJS caller — sloppy mode — the same write on the same
 *     object does not throw. It **silently does nothing**, and the next read
 *     returns the original value. `Object.isSealed` is `true` in both cases, so
 *     the object cannot tell you which world it is in; only the caller's
 *     strictness decides. Reporting a crash that does not happen would be the
 *     false positive, so the ESM proof ladder here is the same one
 *     `no-dirname-in-esm` uses, with the same exclusions.
 *
 * And the silences that follow from it:
 *
 *   - A `.ts`/`.tsx` file is never judged: transpiled to CommonJS the write
 *     SUCCEEDS, and the output module format is a tsconfig question.
 *   - A TEST FILE is never judged. Under `vi.mock`, or a CJS test transform, the
 *     thing bound by `import * as mod` is a runner-synthesised **plain mutable
 *     object**, and `mod.fn = vi.fn()` genuinely works.
 *   - Only a DIRECT write to a property of the namespace binding. `NS.default.x`
 *     and `NS.config.a` write to an ordinary object reached THROUGH it.
 *   - Only `import * as`. A default or named import is an ordinary value.
 *   - `Object.assign(NS, src)` and `Object.defineProperty` are deliberately NOT
 *     matched: `Object.assign(NS, {})` copies nothing, performs no `[[Set]]`,
 *     and does not throw — so the claim would need to know the source object is
 *     non-empty, which is value analysis.
 */

/** ESM by extension, with no appeal. */
const isEsmExtension = (filePath: string): boolean => /\.(mjs|mts)$/i.test(filePath);
/** CommonJS by extension, with no appeal. */
const isCjsExtension = (filePath: string): boolean => /\.(cjs|cts)$/i.test(filePath);
/** A tool's own config, which that tool loads and may hand over an ordinary object. */
const isToolConfig = (filePath: string): boolean =>
  /(^|[\\/])[^\\/]*\.config\.[cm]?[jt]sx?$/i.test(filePath);

/** `import.meta` members only a bundler ever provides. */
const BUNDLER_META = new Set(["env", "hot", "webpackHot", "webpackContext", "glob", "globEager"]);

export const noNamespaceObjectWrite = defineDiagnostic({
  id: "no-namespace-object-write",
  title: "Write to a module namespace object, which is sealed",
  severity: "error",
  category: "Bugs",
  confidence: "high",
  tags: ["correctness", "esm", "modules"],
  recommendation:
    "A module namespace object is sealed, and ES module code is strict, so assigning to one of its properties throws. Build a new object instead (`{ ...ns, fn: wrapped }`), or reach the mutable CommonJS export object through `createRequire(import.meta.url)` if you really are monkeypatching.",
  create: (ctx) => {
    const importMetas = collectDescendants(
      ctx.program,
      (n) => n.type === "MetaProperty" && (n.meta as AstNode | undefined)?.name === "import",
      undefined,
      true,
    );

    /** `import.meta.env` / `.hot` — the file is compiled before it runs. */
    const hasBundlerMarker = importMetas.some((meta) => {
      const parent = meta.parent as AstNode | undefined;
      if (parent?.type !== "MemberExpression" || parent.computed) return false;
      const property = (parent.property as AstNode | undefined)?.name;
      return typeof property === "string" && BUNDLER_META.has(property);
    });

    const hasModuleSyntax = ((ctx.program.body as AstNode[] | undefined) ?? []).some(
      (n) =>
        n.type === "ImportDeclaration" ||
        n.type === "ExportNamedDeclaration" ||
        n.type === "ExportDefaultDeclaration" ||
        n.type === "ExportAllDeclaration",
    );

    const provenEsm =
      !isCjsExtension(ctx.filePath) &&
      !isToolConfig(ctx.filePath) &&
      !hasBundlerMarker &&
      // A `.ts` file's emitted module format is a tsconfig question, and
      // transpiled to CommonJS this write succeeds.
      !/\.(ts|tsx|mts|cts)$/i.test(ctx.filePath) &&
      (isEsmExtension(ctx.filePath) ||
        importMetas.length > 0 ||
        (/\.(js|jsx)$/i.test(ctx.filePath) && ctx.hasCapability("esm") && hasModuleSyntax));

    // A test runner's module mock hands over a plain, mutable object.
    const inert = !provenEsm || isTestFile(ctx.program, ctx.normalizedFilePath);

    /** Names bound by `import * as NS`, mapped to the specifier that bound them. */
    const namespaces = new Map<string, AstNode>();
    for (const stmt of (ctx.program.body as AstNode[] | undefined) ?? []) {
      if (stmt.type !== "ImportDeclaration") continue;
      for (const spec of (stmt.specifiers as AstNode[] | undefined) ?? []) {
        if (spec.type !== "ImportNamespaceSpecifier") continue;
        const local = (spec.local as AstNode | undefined)?.name;
        if (typeof local === "string") namespaces.set(local, spec);
      }
    }

    /**
     * Is `node` a direct property write on a namespace binding — and does the
     * name still resolve to that import here, rather than to a nearer shadow?
     */
    const namespaceTarget = (node: AstNode | null | undefined): string | null => {
      if (!node || node.type !== "MemberExpression") return null;
      const object = node.object as AstNode | undefined;
      if (object?.type !== "Identifier") return null;
      const name = object.name as string;
      const specifier = namespaces.get(name);
      if (!specifier) return null;
      const binding = ctx.scope.getBinding(name, object);
      // A parameter, an inner const or a catch binding of the same name is a
      // different, ordinary object.
      if (binding !== null && binding.declNode !== specifier) return null;
      return name;
    };

    const report = (at: AstNode, name: string, what: string): void => {
      ctx.report(
        at,
        `\`${name}\` is a module namespace object, which is sealed — and ES module code is always strict, so ${what} throws \`TypeError\` when this line runs. Loaded from a CommonJS caller the same write silently does nothing instead, which is why this is worth catching here rather than in a test. Build a new object (\`{ ...${name}, … }\`), or reach the mutable CommonJS export through \`createRequire(import.meta.url)\`.`,
      );
    };

    return {
      AssignmentExpression: (node) => {
        if (inert || namespaces.size === 0) return;
        const target = node.left as AstNode | undefined;
        const name = namespaceTarget(target);
        if (name !== null && target) report(target, name, "assigning to one of its properties");
      },

      UpdateExpression: (node) => {
        if (inert || namespaces.size === 0) return;
        const target = node.argument as AstNode | undefined;
        const name = namespaceTarget(target);
        if (name !== null && target) report(target, name, `\`${node.operator as string}\` on one of its properties`);
      },

      UnaryExpression: (node) => {
        if (inert || namespaces.size === 0 || node.operator !== "delete") return;
        const target = node.argument as AstNode | undefined;
        const name = namespaceTarget(target);
        if (name !== null && target) report(target, name, "deleting one of its properties");
      },
    };
  },
});
