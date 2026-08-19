/**
 * Type information for the type-aware diagnostics (`--typed`).
 *
 * Almost every node.doctor rule is deliberately syntactic, because syntax is
 * fast, offline and always available. A handful of the most valuable checks are
 * not expressible that way: "is this discarded call returning a promise?" needs
 * the *type* of the callee, and without it a floating-promise rule can only see
 * the `async` keyword — missing every function typed `(): Promise<T>`, which in
 * a real TypeScript codebase is most of them.
 *
 * Design constraints this satisfies:
 *
 *  - **Zero runtime dependencies stay zero.** The TypeScript compiler is loaded
 *    dynamically and only when `--typed` is passed. It is an optional peer: if
 *    the project has TypeScript (nearly every TS project does) the typed rules
 *    work, and if it does not, nothing about a normal scan changes.
 *  - **Never silently clean.** If `--typed` is requested and no usable type
 *    source can be loaded, the caller reports the reason and fails. Returning
 *    zero findings because the type checker never started is exactly the
 *    "silent clean on a coverage gap" this project treats as a bug (§5.6).
 *  - **Deterministic.** Answers are pure functions of the source tree, computed
 *    once per scan. Nothing here may time out or race: a type source that could
 *    answer differently between runs would break byte-identical output.
 *
 * The interface is deliberately tiny — a total function with an explicit
 * `"unknown"`, so a diagnostic stays silent rather than guessing when the
 * checker cannot resolve something.
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** What the checker can say about the value an expression produces. */
export type PromiseKind = "promise" | "not-promise" | "unknown";

export interface TypeSource {
  /**
   * Does the expression at this byte offset evaluate to a promise?
   *
   * `offset` is a byte offset into `filePath`'s source, matching the `start`
   * offsets oxc-parser produces, so a diagnostic can ask about a node it already
   * has without a second position mapping.
   */
  promiseKindAt(filePath: string, offset: number): PromiseKind;
  /** Free any held resources (the compiler program). */
  dispose(): void;
}

/** Why a type source could not be created — surfaced verbatim to the user. */
export interface TypeSourceFailure {
  reason: string;
  /** The exact remedy, so the message is actionable rather than a complaint. */
  remedy: string;
}

export type TypeSourceResult = { ok: true; source: TypeSource } | { ok: false; failure: TypeSourceFailure };

/**
 * The subset of the TypeScript compiler API this adapter uses.
 *
 * Declared structurally rather than imported so the package stays an optional
 * dependency — and so the adapter is testable against a faithful stub without
 * a compiler installed.
 */
export interface TsLike {
  version?: string;
  createProgram?: (rootNames: string[], options: Record<string, unknown>) => TsProgram;
  parseJsonConfigFileContent?: (
    json: unknown,
    host: unknown,
    basePath: string,
  ) => { fileNames: string[]; options: Record<string, unknown> };
  readConfigFile?: (path: string, read: (p: string) => string | undefined) => { config?: unknown };
  sys?: { readFile: (p: string) => string | undefined };
  TypeFlags?: Record<string, number>;
  /** Used to break offset ties in the node index — see `makeSource`'s walk. */
  isCallExpression?: (node: unknown) => boolean;
}

export interface TsProgram {
  getTypeChecker: () => TsChecker;
  getSourceFile: (fileName: string) => TsSourceFile | undefined;
}

export interface TsChecker {
  getTypeAtLocation: (node: unknown) => TsType;
  typeToString: (type: TsType) => string;
}

export interface TsType {
  symbol?: { name?: string };
  getCallSignatures?: () => Array<{ getReturnType: () => TsType }>;
}

export interface TsSourceFile {
  getStart?: () => number;
  forEachChild?: (cb: (node: unknown) => void) => void;
}

/**
 * Is this type name a promise?
 *
 * Matching on the printed type is deliberate: it is stable across compiler
 * versions, and it covers the shapes a `Promise`-flavoured value actually takes
 * — `Promise<T>`, a union of them, and the `PromiseLike`/`Thenable` interfaces a
 * library may return instead. `void` and `any` are explicitly NOT promises: a
 * rule that fires on `any` would fire on every untyped call in the codebase.
 */
export const typeNameIsPromise = (typeName: string): PromiseKind => {
  const name = typeName.trim();
  if (name.length === 0 || name === "any" || name === "unknown" || name === "error") return "unknown";
  // A union counts as a promise only if every arm is one — `Promise<T> | undefined`
  // is still awaited, but `string | Promise<T>` is a shape we should not guess at.
  if (name.includes("|")) {
    const arms = name.split("|").map((a) => a.trim()).filter((a) => a.length > 0);
    if (arms.length === 0) return "unknown";
    const kinds = arms.map((a) => typeNameIsPromise(a));
    if (kinds.every((k) => k === "promise")) return "promise";
    if (kinds.some((k) => k === "unknown")) return "unknown";
    return "not-promise";
  }
  if (/^(?:Promise|PromiseLike|Thenable|Bluebird)\s*</.test(name)) return "promise";
  if (name === "Promise" || name === "PromiseLike") return "promise";
  return "not-promise";
};

/**
 * Build a type source for `rootDirectory`, or explain why it is unavailable.
 *
 * `load` is injectable so the adapter is testable without a compiler present —
 * the default resolves TypeScript from the *scanned project*, not from
 * node.doctor's own tree, because the answer must come from the project's own
 * compiler and tsconfig.
 */
/**
 * Resolve `typescript` from the SCANNED PROJECT, not from node.doctor's tree.
 *
 * A bare `import("typescript")` resolves relative to THIS module, so a globally
 * or locally installed node.doctor always loaded its own compiler. That is not a
 * theoretical mismatch: node.doctor dev-depends on TypeScript 7, whose native
 * build ships no `createProgram`, so `--typed` reported "the resolved TypeScript
 * does not expose the JavaScript compiler API" on every project — including
 * projects sitting on a perfectly good TypeScript 5.9 of their own. The single
 * type-aware diagnostic could therefore never run anywhere.
 *
 * `createRequire` rooted at the project reproduces Node's own lookup from that
 * directory. The bare import stays as a fallback so a globally installed
 * node.doctor still works against a project with no local compiler.
 */
const resolveFromProject = async (rootDirectory: string, specifier: string): Promise<unknown> => {
  try {
    const require = createRequire(join(rootDirectory, "__node-doctor-resolve__.js"));
    return await import(pathToFileURL(require.resolve(specifier)).href);
  } catch {
    return await import(specifier);
  }
};

export const createTypeSource = async (
  rootDirectory: string,
  load: (specifier: string) => Promise<unknown> = (s) => resolveFromProject(rootDirectory, s),
): Promise<TypeSourceResult> => {
  let ts: TsLike;
  try {
    const mod = (await load("typescript")) as { default?: TsLike } & TsLike;
    ts = (mod.default ?? mod) as TsLike;
  } catch {
    return {
      ok: false,
      failure: {
        reason: "`--typed` needs the TypeScript compiler, and `typescript` could not be resolved from this project.",
        remedy: "Install it as a dev dependency: `npm install --save-dev typescript@^5`.",
      },
    };
  }

  if (typeof ts.createProgram !== "function") {
    return {
      ok: false,
      failure: {
        reason:
          `The resolved TypeScript (${ts.version ?? "unknown version"}) does not expose the JavaScript compiler API ` +
          "that type-aware analysis needs — TypeScript 7's native build ships no `createProgram`.",
        remedy:
          "Install a 5.x compiler alongside it for type-aware runs: `npm install --save-dev typescript@^5`. " +
          "Untyped diagnostics are unaffected — drop `--typed` to run them.",
      },
    };
  }

  const program = buildProgram(ts, rootDirectory);
  if (!program) {
    return {
      ok: false,
      failure: {
        reason: "No `tsconfig.json` could be read for this project, so there is no type-checking configuration to use.",
        remedy: "Run `--typed` from a directory containing a tsconfig.json, or point `--config` at that project.",
      },
    };
  }

  return { ok: true, source: makeSource(ts, program) };
};

const buildProgram = (ts: TsLike, rootDirectory: string): TsProgram | null => {
  try {
    const configPath = `${rootDirectory.replace(/\/+$/, "")}/tsconfig.json`;
    const read = ts.sys?.readFile ?? (() => undefined);
    const raw = ts.readConfigFile?.(configPath, read);
    if (!raw?.config) return null;
    const parsed = ts.parseJsonConfigFileContent?.(raw.config, ts.sys, rootDirectory);
    if (!parsed) return null;
    return ts.createProgram!(parsed.fileNames, parsed.options);
  } catch {
    return null;
  }
};

const makeSource = (ts: TsLike, program: TsProgram): TypeSource => {
  const checker = program.getTypeChecker();
  // One offset->node index per file, built lazily: a scan asks about many
  // offsets in the same file, and re-walking per query would be quadratic.
  const nodeIndex = new Map<string, Map<number, unknown>>();

  const indexFor = (filePath: string): Map<number, unknown> | null => {
    const cached = nodeIndex.get(filePath);
    if (cached) return cached;
    const sourceFile = program.getSourceFile(filePath);
    if (!sourceFile) return null;
    const index = new Map<number, unknown>();
    const visit = (node: unknown): void => {
      const n = node as { getStart?: (sf?: unknown) => number; forEachChild?: (cb: (c: unknown) => void) => void };
      try {
        const start = n.getStart?.(sourceFile);
        if (typeof start === "number") {
          // SEVERAL NODES SHARE A START OFFSET, and the caller always wants the
          // call. `r.save("a");` begins an ExpressionStatement, a CallExpression,
          // a PropertyAccessExpression and an Identifier at the very same column.
          //
          // First-wins handed the offset to the ExpressionStatement — a statement
          // has no type, so `promiseKindAt` answered "unknown" and the only
          // type-aware diagnostic reported nothing, ever. Last-wins is not the fix
          // either: it would hand the offset to the Identifier `r`, whose type is
          // the receiver rather than the call's return.
          //
          // So the call expression claims the offset outright, and everything else
          // keeps first-wins.
          const isCall = ts.isCallExpression?.(node) === true;
          if (isCall || !index.has(start)) index.set(start, node);
        }
      } catch {
        /* a synthetic node without a position — skip it */
      }
      n.forEachChild?.(visit);
    };
    (sourceFile as { forEachChild?: (cb: (c: unknown) => void) => void }).forEachChild?.(visit);
    nodeIndex.set(filePath, index);
    return index;
  };

  return {
    promiseKindAt: (filePath, offset) => {
      const index = indexFor(filePath);
      const node = index?.get(offset);
      if (!node) return "unknown";
      try {
        const type = checker.getTypeAtLocation(node);
        // For a call expression the interesting type is what the call returns.
        const signatures = type.getCallSignatures?.() ?? [];
        const target = signatures.length > 0 ? signatures[0]!.getReturnType() : type;
        return typeNameIsPromise(checker.typeToString(target));
      } catch {
        return "unknown";
      }
    },
    dispose: () => {
      nodeIndex.clear();
      void ts;
    },
  };
};
