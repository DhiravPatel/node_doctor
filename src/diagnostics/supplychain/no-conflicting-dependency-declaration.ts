import { defineTextDiagnostic } from "../../core/text-scan.ts";

/**
 * §19 — a package declared in both `dependencies` and `devDependencies`.
 *
 * It reads like a harmless duplicate. It is not: npm resolves the package as a
 * **dev** dependency, and a production install then removes it.
 *
 *   ❌ "dependencies":    { "semver": "^7.0.0" },
 *      "devDependencies": { "semver": "^6.0.0" }
 *
 * Measured, twice, against real npm rather than assumed:
 *
 *   - With **different** ranges the devDependencies range wins — that pair
 *     resolves `semver@6.3.1`, not the `^7` the runtime code was written for.
 *   - With **identical** ranges it still resolves as dev.
 *   - In both cases the lockfile entry carries `"dev": true`, and after
 *     `npm install --omit=dev` the package is **absent from `node_modules`**
 *     entirely — verified by looking for the directory afterwards.
 *
 * So the failure is production-only and total. Locally everything works: the
 * package is installed, the tests pass, the types resolve. The deployed image
 * runs `--omit=dev`, the module is not there, and the first request that reaches
 * that `require` gets `MODULE_NOT_FOUND` — for a dependency the manifest plainly
 * declares as a runtime one.
 *
 * npm itself says nothing. `npm install` prints no warning for this.
 *
 * PRECISION MODEL. The claim is an intersection of two key sets in one file,
 * which is as syntactic as it gets:
 *
 *   - Only `dependencies` against `devDependencies`. A package in both
 *     `peerDependencies` and `dependencies` is the ORDINARY way to ship a peer
 *     with a fallback, and is never reported.
 *   - `optionalDependencies` is likewise left alone: npm documents it as
 *     overriding `dependencies`, which is a deliberate pattern rather than a
 *     mistake.
 *   - A manifest that does not parse is skipped rather than guessed at.
 *
 * SCOPE. The text scan excludes `node_modules`, so this only ever reads
 * FIRST-PARTY manifests — which is exactly where the behaviour above was
 * measured. A published package's own dual declaration is a different question
 * (its devDependencies are never installed by a consumer at all), and this rule
 * deliberately makes no claim about it, because it never sees one. Across the
 * eight projects swept it found nothing in 27 first-party manifests; the
 * fourteen instances in their dependency trees are out of scope by design.
 */

/** Where in the file a top-level key's entry sits, for an honest line number. */
const lineOfKeyInSection = (content: string, section: string, key: string): number => {
  const lines = content.split(/\r?\n/);
  const sectionRe = new RegExp(`"${section}"\\s*:`);
  const keyRe = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:`);
  let inSection = false;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!inSection && sectionRe.test(line)) {
      inSection = true;
      depth = 0;
      continue;
    }
    if (!inSection) continue;
    if (keyRe.test(line)) return i + 1;
    // Leave the section at its closing brace.
    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        if (depth === 0) return 1;
        depth--;
      }
    }
  }
  return 1;
};

export const noConflictingDependencyDeclaration = defineTextDiagnostic({
  id: "no-conflicting-dependency-declaration",
  title: "Package declared in both dependencies and devDependencies",
  severity: "error",
  category: "Reliability",
  confidence: "high",
  tags: ["dependencies", "supply-chain", "correctness"],
  recommendation:
    "Remove the `devDependencies` entry. npm resolves a package declared in both as a DEV dependency and marks it `dev: true` in the lockfile, so `npm install --omit=dev` drops it from the production image — and the first `require` of a dependency your manifest calls a runtime one fails with `MODULE_NOT_FOUND`.",
  files: ["**/package.json"],
  scan: (ctx) => {
    let manifest: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(ctx.content);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
      manifest = parsed as Record<string, unknown>;
    } catch {
      // A manifest that does not parse is somebody else's finding.
      return;
    }

    const runtime = manifest.dependencies;
    const dev = manifest.devDependencies;
    if (runtime === null || typeof runtime !== "object" || Array.isArray(runtime)) return;
    if (dev === null || typeof dev !== "object" || Array.isArray(dev)) return;

    const devEntries = dev as Record<string, unknown>;
    for (const name of Object.keys(runtime as Record<string, unknown>).sort()) {
      if (!Object.hasOwn(devEntries, name)) continue;
      const runtimeRange = (runtime as Record<string, unknown>)[name];
      const devRange = devEntries[name];
      const ranges =
        typeof runtimeRange === "string" && typeof devRange === "string"
          ? runtimeRange === devRange
            ? `both at \`${runtimeRange}\``
            : `\`${runtimeRange}\` as a runtime dependency and \`${devRange}\` as a dev one`
          : "in both sections";

      ctx.report({
        line: lineOfKeyInSection(ctx.content, "devDependencies", name),
        message: `\`${name}\` is declared ${ranges}. npm resolves it as a **dev** dependency — the devDependencies range wins, and the lockfile entry is marked \`dev: true\` — so \`npm install --omit=dev\` removes it from the production image. Everything works locally; the first \`require\` in production fails with \`MODULE_NOT_FOUND\`, for a package this manifest declares as a runtime dependency. Remove the \`devDependencies\` entry.`,
      });
    }
  },
});
