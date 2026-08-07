import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getStaticStringValue, staticMemberPath } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";

/**
 * §175 — a mock that has drifted from the module it stands in for.
 *
 * THE BUG. A test mocks `./services/user` and stubs `getUser`. Six months later
 * someone renames the real export to `fetchUser`. Nothing fails: the mock still
 * defines `getUser`, the module is still replaced, the suite is still green —
 * and the test now exercises a stub of a function that does not exist. The
 * coverage number does not move. The confidence is entirely false.
 *
 *   ❌ // services/user.ts exports `fetchUser`
 *      vi.mock("./services/user", () => ({ getUser: vi.fn() }));
 *
 *   ✅ vi.mock("./services/user", () => ({ fetchUser: vi.fn() }));
 *
 * This is the one piece of test-reality drift that is decidable without running
 * anything: the mock names a member, the module has an export surface, and
 * either the name is in it or it is not.
 *
 * PRECISION MODEL. The claim is "this module does not export that name", which
 * is false the moment the export surface cannot be fully enumerated. So the rule
 * abstains — for the WHOLE mock, not just the doubtful key — whenever:
 *
 *   - The specifier is not relative. A package's exports are not in the graph.
 *   - The target is not a module this scan parsed.
 *   - The target uses `export * from "…"`. Those names are real exports this
 *     cannot see, and a barrel file is nothing but those.
 *   - The target assigns `module.exports` or `exports.x`. A CommonJS surface is
 *     built at runtime; reading it syntactically would call every key missing.
 *   - The target has no ESM exports at all — that is the same case, seen from
 *     the other side, and it is the difference between "you mocked a name that
 *     is gone" and "I could not read this module".
 *   - The factory is not a plain object literal, or it spreads
 *     (`...(await vi.importActual(…))`). A spread supplies names this cannot
 *     enumerate, which is exactly how a partial mock is written.
 *
 * `default` and `__esModule` are module-interop keys, never checked. Type-only
 * exports COUNT as exports: a mock of a type-exported name is odd, but claiming
 * the module does not export it would be false.
 */

/** The mocking calls this understands. Both take (specifier, factory?). */
const MOCK_CALLS = new Set(["jest.mock", "vi.mock", "jest.doMock", "vi.doMock"]);

/** Interop keys that are never a real named export. */
const INTEROP_KEYS = new Set(["default", "__esModule"]);

/**
 * Every name a module exports, or null when the surface cannot be enumerated.
 * Null is the abstain signal and is returned generously — an unreadable surface
 * must never be mistaken for an empty one.
 */
const exportedNames = (program: AstNode): Set<string> | null => {
  const names = new Set<string>();
  let sawEsmExport = false;

  for (const stmt of (program.body as AstNode[] | undefined) ?? []) {
    if (stmt.type === "ExportAllDeclaration") return null; // `export * from` — opaque
    if (stmt.type === "ExportDefaultDeclaration") {
      sawEsmExport = true;
      continue;
    }
    if (stmt.type !== "ExportNamedDeclaration") continue;
    sawEsmExport = true;

    // `export { a, b as c }` and `export { a } from "./x"` — both explicit.
    for (const spec of (stmt.specifiers as AstNode[] | undefined) ?? []) {
      const exported = spec.exported as AstNode | undefined;
      const name =
        exported?.type === "Identifier" ? (exported.name as string) : getStaticStringValue(exported);
      if (name !== null) names.add(name);
    }

    const declaration = stmt.declaration as AstNode | undefined;
    if (!declaration) continue;
    if (declaration.type === "VariableDeclaration") {
      for (const d of (declaration.declarations as AstNode[] | undefined) ?? []) {
        const id = d.id as AstNode | undefined;
        if (id?.type === "Identifier") names.add(id.name as string);
        // A destructured export (`export const { a } = x`) is enumerable too,
        // but rare enough that abstaining is cheaper than getting it wrong.
        else return null;
      }
      continue;
    }
    const id = declaration.id as AstNode | undefined;
    if (id?.type === "Identifier") names.add(id.name as string);
    else if (declaration.type !== "TSDeclareFunction") return null;
  }

  // CommonJS: the surface is assembled at runtime.
  for (const assignment of collectDescendants(
    program,
    (n) => n.type === "AssignmentExpression",
    undefined,
    true,
  )) {
    const left = staticMemberPath(assignment.left as AstNode);
    if (left === "module.exports" || left?.startsWith("exports.") === true) return null;
  }

  // A module with no ESM exports is UNREADABLE here, not empty: it is either
  // CommonJS assembled at runtime or something this cannot see. Returning an
  // empty set would call every mocked member missing.
  return sawEsmExport ? names : null;
};

/** The object literal a mock factory returns, or null when it is not one. */
const factoryObject = (factory: AstNode | undefined): AstNode | null => {
  if (!factory) return null;
  if (factory.type !== "ArrowFunctionExpression" && factory.type !== "FunctionExpression") return null;
  const body = factory.body as AstNode | undefined;
  if (!body) return null;
  if (body.type === "ObjectExpression") return body;
  if (body.type !== "BlockStatement") return null;
  const statements = (body.body as AstNode[] | undefined) ?? [];
  // `() => { return { … }; }` — and nothing else, or the factory computes.
  if (statements.length !== 1 || statements[0]!.type !== "ReturnStatement") return null;
  const returned = statements[0]!.argument as AstNode | undefined;
  return returned?.type === "ObjectExpression" ? returned : null;
};

export const noMockOfMissingExport = defineDiagnostic({
  id: "no-mock-of-missing-export",
  title: "Mock stubs a member the module does not export",
  severity: "warn",
  category: "Maintainability",
  scope: "project",
  confidence: "high",
  tags: ["testing", "maintainability"],
  defaultEnabled: false,
  recommendation:
    "Rename the mocked member to match the real export, or delete it. A mock that stubs a name the module no longer exports keeps the suite green while testing a stub of something that does not exist — the coverage number does not move, and the confidence is false.",
  create: (ctx) => ({
    Program: () => {
      const graph = ctx.graph;
      if (!graph) return;

      for (const call of collectDescendants(
        ctx.program,
        (n) => n.type === "CallExpression",
        undefined,
        true,
      )) {
        const callee = staticMemberPath(call.callee as AstNode);
        if (callee === null || !MOCK_CALLS.has(callee)) continue;

        const args = (call.arguments as AstNode[] | undefined) ?? [];
        const specifier = getStaticStringValue(args[0]);
        // A package's export surface is not in the graph.
        if (specifier === null || !specifier.startsWith(".")) continue;

        const object = factoryObject(args[1]);
        if (!object) continue; // auto-mock, or a factory that computes its shape

        const properties = (object.properties as AstNode[] | undefined) ?? [];
        // A spread supplies names this cannot enumerate — which is exactly how a
        // partial mock is written, and exactly when the claim would be wrong.
        if (properties.some((p) => p.type !== "Property")) continue;

        const targetPath = graph.resolveImport(specifier, ctx.filePath);
        if (targetPath === null) continue;
        const target = graph.modules.get(targetPath);
        if (!target) continue;

        const exported = exportedNames(target.program);
        if (exported === null) continue; // surface not enumerable — say nothing

        for (const property of properties) {
          if (property.computed) continue;
          const key = property.key as AstNode | undefined;
          const name =
            key?.type === "Identifier" ? (key.name as string) : getStaticStringValue(key);
          if (name === null || INTEROP_KEYS.has(name)) continue;
          if (exported.has(name)) continue;

          ctx.report(
            key ?? property,
            `This mock stubs \`${name}\`, but \`${specifier}\` (${target.normalizedFilePath}) does not export it — the mock has drifted from the module it stands in for. The suite stays green while exercising a stub of something that does not exist.`,
          );
        }
      }
    },
  }),
});
