import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, getPropertyValue, getStaticStringValue } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";

/**
 * §7 — extracting an archive to wherever its entries say. "Zip slip."
 *
 * An archive entry carries its own path, and that path is attacker-chosen. Join
 * it onto a destination and it walks straight back out:
 *
 *   ❌ join("/srv/app/uploads", "../../../etc/cron.d/pwn")
 *      → "/etc/cron.d/pwn"                          (measured)
 *   ❌ tar.x({ file, cwd: dest, preservePaths: true })
 *   ✅ tar.x({ file, cwd: dest })                    // the default is safe
 *   ✅ const out = resolve(dest, entry.fileName);
 *      if (!out.startsWith(dest + sep)) throw new Error("unsafe entry");
 *
 * The upload arrives as a legitimate `.zip`, the extraction succeeds, and the
 * file lands outside the directory the application believes it owns — a cron
 * file, an SSH key, a config the next request reads back.
 *
 * TWO SHAPES, and they are not equally provable.
 *
 * **The flag.** `tar` defends itself by default, and `preservePaths` turns that
 * off. Verified against the installed package rather than its docs: `unpack.js`
 * gates three separate protections on it — stripping `/` from absolute paths,
 * rejecting an entry containing `..`, and refusing to extract through a symbolic
 * link. Setting it re-enables the whole class at once, which is why the option
 * is worth a finding on its own.
 *
 * **The manual join.** Extracting by hand, where the entry's own name becomes
 * the output path with nothing checking it stays inside the destination.
 *
 * PRECISION MODEL.
 *
 *   - The flag must be a LITERAL `true` on a call `tar` proves it owns. A
 *     variable is not folded, and `preservePaths: false` is the default said
 *     out loud.
 *   - For the manual shape, all three of these must hold: the value is an entry
 *     property read off the parameter of an `"entry"`-event handler, it reaches
 *     a filesystem WRITE, and the enclosing function contains no containment
 *     check at all. Any `relative`, `startsWith`, `isAbsolute` or `normalize` in
 *     that function is a silence — whether the check is CORRECT is not a claim
 *     this makes; that one exists is.
 *   - Only entry properties verified against a shipped implementation:
 *     `fileName` (yauzl, confirmed in its source) and `path` (tar's
 *     `read-entry.js`). `adm-zip`'s `entryName` is documented but was not
 *     installed here to check, and this analyzer does not assert APIs it cannot
 *     verify.
 */

/** Modules whose extraction API this rule knows. */
const TAR_MODULES = new Set(["tar", "node-tar"]);

/** `tar` methods that extract. */
const EXTRACT_METHODS = new Set(["x", "extract"]);

/** Entry properties that carry the attacker-chosen path, verified in source. */
const ENTRY_PATH_PROPS = new Set(["fileName", "path"]);

/** Filesystem writes an extracted path can reach. */
const WRITE_SINKS = new Set([
  "createWriteStream",
  "writeFile",
  "writeFileSync",
  "appendFile",
  "appendFileSync",
  "mkdir",
  "mkdirSync",
  "rename",
  "renameSync",
  "copyFile",
  "copyFileSync",
  "open",
  "openSync",
]);

/** Any containment check at all. Its correctness is a different question. */
const CONTAINMENT = new Set(["relative", "startsWith", "isAbsolute", "normalize", "resolve"]);

export const noUnsafeArchiveExtraction = defineDiagnostic({
  id: "no-unsafe-archive-extraction",
  title: "Archive extracted to a path its own entries control (zip slip)",
  severity: "error",
  category: "Security",
  confidence: "high",
  tags: ["security", "path-traversal", "filesystem"],
  recommendation:
    "Resolve the entry against the destination and confirm it stayed inside before writing: `const out = resolve(dest, entry.path); if (relative(dest, out).startsWith(\"..\")) throw new Error(\"unsafe entry\")`. With `tar`, simply do not set `preservePaths` — the default already strips absolute paths, rejects `..`, and refuses to extract through a symlink.",
  create: (ctx) => {
    /** Local names bound to a tar module, proven by import. */
    const tarNames = new Set<string>();
    for (const stmt of (ctx.program.body as AstNode[] | undefined) ?? []) {
      if (stmt.type !== "ImportDeclaration") continue;
      const source = stmt.source?.value;
      if (typeof source !== "string" || !TAR_MODULES.has(source)) continue;
      for (const spec of (stmt.specifiers as AstNode[] | undefined) ?? []) {
        const local = (spec.local as AstNode | undefined)?.name;
        if (typeof local === "string") tarNames.add(local);
      }
    }
    for (const decl of collectDescendants(ctx.program, (n) => n.type === "VariableDeclarator", undefined, true)) {
      const init = decl.init as AstNode | undefined;
      if (init?.type !== "CallExpression" || (init.callee as AstNode | undefined)?.name !== "require") continue;
      const source = getStaticStringValue(((init.arguments as AstNode[] | undefined) ?? [])[0]);
      if (source === null || !TAR_MODULES.has(source)) continue;
      const id = decl.id as AstNode | undefined;
      if (id?.type === "Identifier") tarNames.add(id.name as string);
      else if (id?.type === "ObjectPattern") {
        for (const prop of (id.properties as AstNode[] | undefined) ?? []) {
          if (prop.type !== "Property") continue;
          const value = prop.value as AstNode | undefined;
          if (value?.type === "Identifier") tarNames.add(value.name as string);
        }
      }
    }

    /** The nearest enclosing function, so a check can be looked for in it. */
    const enclosingFunction = (node: AstNode): AstNode | null => {
      let current: AstNode | null | undefined = node.parent;
      for (let depth = 0; current && depth < 128; depth++) {
        if (
          current.type === "FunctionDeclaration" ||
          current.type === "FunctionExpression" ||
          current.type === "ArrowFunctionExpression"
        ) {
          return current;
        }
        current = current.parent;
      }
      return null;
    };

    /** Does this function contain any containment check at all? */
    const hasContainmentCheck = (fn: AstNode): boolean =>
      collectDescendants(
        fn,
        (n) => n.type === "CallExpression" && CONTAINMENT.has(getMethodName(n) ?? ""),
        undefined,
        true,
      ).length > 0;

    return {
      CallExpression: (node) => {
        const method = getMethodName(node);
        const args = (node.arguments as AstNode[] | undefined) ?? [];

        // Shape 1 — `tar.x({ …, preservePaths: true })`, the flag that turns
        // off three protections at once.
        if (method !== null && EXTRACT_METHODS.has(method) && tarNames.size > 0) {
          const callee = node.callee as AstNode | undefined;
          const receiver = (callee as AstNode | undefined)?.object as AstNode | undefined;
          const named = receiver?.type === "Identifier" && tarNames.has(receiver.name as string);
          if (named) {
            for (const arg of args) {
              if (arg.type !== "ObjectExpression") continue;
              for (const key of ["preservePaths", "P"]) {
                const value = getPropertyValue(arg, key);
                if (value?.type === "Literal" && value.value === true) {
                  ctx.report(
                    value,
                    "`preservePaths` turns off the three protections `tar` applies by default — it stops stripping `/` from absolute paths, stops rejecting an entry containing `..`, and stops refusing to extract through a symbolic link (all three gated on this flag in the library's own `unpack.js`). An archive is attacker-supplied data, so this lets its entries write wherever they name. Drop the option; the default is the safe one.",
                  );
                  return;
                }
              }
            }
          }
        }

        // Shape 2 — a hand-rolled extraction writing to a path the entry names.
        if (method === null || !WRITE_SINKS.has(method)) return;
        const target = args[0];
        if (!target) return;

        // The path must be built from an entry property of an `"entry"` handler.
        const usesEntryPath = collectDescendants(
          target,
          (n) =>
            n.type === "MemberExpression" &&
            !n.computed &&
            ENTRY_PATH_PROPS.has(((n.property as AstNode | undefined)?.name as string) ?? ""),
          undefined,
          true,
        ).some((member) => {
          const object = (member.object as AstNode | undefined) ?? null;
          if (object?.type !== "Identifier") return false;
          // That identifier must be the parameter of an `"entry"` listener.
          const binding = ctx.scope.getBinding(object.name as string, object);
          if (!binding || binding.kind !== "param") return false;
          const owner = binding.declNode ? enclosingFunction(binding.declNode as AstNode) : null;
          const registration = owner?.parent as AstNode | undefined;
          if (registration?.type !== "CallExpression") return false;
          return getStaticStringValue(((registration.arguments as AstNode[] | undefined) ?? [])[0]) === "entry";
        });
        if (!usesEntryPath) return;

        const fn = enclosingFunction(node);
        if (fn && hasContainmentCheck(fn)) return;

        ctx.report(
          target,
          "This writes to a path the archive ENTRY names, with nothing in this function checking the result stayed inside the destination. An entry path is attacker-chosen: `join(\"/srv/uploads\", \"../../../etc/cron.d/pwn\")` resolves to `/etc/cron.d/pwn`, measured. Resolve against the destination and reject anything that escapes it.",
        );
      },
    };
  },
});
