import { defineTextDiagnostic } from "../../core/text-scan.ts";

/**
 * §156 — Lockfile Integrity & Build Reproducibility.
 *
 * A `package.json` dependency whose version spec is NOT a registry semver range
 * makes the install non-reproducible from `package.json` + lockfile and/or is a
 * supply-chain risk. We flag two shapes across `dependencies`,
 * `devDependencies`, `optionalDependencies`, and `peerDependencies`:
 *
 *   1. GIT / URL specs — `git+…`, `git:`, `github:`/`gitlab:`/`bitbucket:`/
 *      `gist:` shorthands, an `http(s)://`/`git://` URL, anything ending in
 *      `.git`, or a GitHub `owner/repo#ref` shorthand. These pull code from
 *      outside the registry, so the resolved tree bypasses registry integrity
 *      and a moving branch/tag ref (`#main`) can change under a fixed spec.
 *
 *   2. FLOATING wildcard / dist-tag — a spec that, trimmed, is exactly `*`,
 *      `x`, `X`, `latest`, `next`, `beta`, `alpha`, `canary`, or empty. A bare
 *      wildcard or dist-tag resolves to whatever the registry currently serves,
 *      so two installs of the same `package.json` can differ.
 *
 * ❌ "dep": "github:foo/bar"      (code can change under a moving ref)
 * ❌ "dep": "*"  /  "dep": "latest"  (floats to whatever is published)
 * ❌ "dep": "git+https://x.git"   (bypasses the registry)
 * ✅ "dep": "^1.2.3" / "~1.0" / "1.2.x" / ">=1 <2"   (registry semver range)
 *
 * PRECISION / DELIBERATE SILENCE. A false positive here is a release blocker,
 * so anything that is not unambiguously one of the two offending shapes stays
 * silent. In particular we never fire on:
 *   - a normal semver range (`^1.2.3`, `~1.2`, `1.2.3`, `>=1 <2`, `1.x`,
 *     `1.2.x`, `1.x.x`) — the lockfile pins the resolved version and these are
 *     reproducible. Note a wildcard *inside* a range (`1.x`) pins the major and
 *     is fine; only a BARE `x`/`*` floats;
 *   - intentional non-registry protocols that a monorepo/tooling opts into:
 *     `workspace:` (pnpm/yarn workspaces), `file:` / `link:` / `portal:`
 *     (local paths), `catalog:` (pnpm catalog), and `npm:` aliases.
 * The protocol-silence checks run BEFORE the git/URL checks so a local
 * `file:../pkg.git` (which ends in `.git`) is not mistaken for a git URL.
 *
 * We parse with `JSON.parse` and report nothing on a parse failure (a malformed
 * `package.json` is another tool's problem, not a place to guess). Line numbers
 * are recovered by locating the `"<name>"` entry line in the raw text, which is
 * deterministic for the one-entry-per-line layout every real `package.json` and
 * every serializer produces.
 */

/** Non-registry protocol prefixes that are intentional and reproducible-enough. */
const INTENTIONAL_PROTOCOLS = ["workspace:", "file:", "link:", "portal:", "catalog:", "npm:", "jsr:"];

/** Bare specs that float to whatever the registry currently serves. */
const FLOATING_TAGS = new Set(["*", "x", "X", "latest", "next", "beta", "alpha", "canary"]);

/** GitHub-style `owner/repo#ref` shorthand: an explicit git ref pin. */
const OWNER_REPO_REF_RE = /^[^/@\s#]+\/[^/@\s#]+#/;
/** An `http(s)://` or `git://` URL. */
const URL_RE = /^(https?|git):\/\//;

const DEPENDENCY_MAPS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

type Offense = "git" | "floating";

/** Classify a version spec. Returns the offense kind, or `null` to stay silent. */
const classify = (rawSpec: string): Offense | null => {
  const spec = rawSpec.trim();

  // Intentional, opted-into protocols — silent (checked first so `file:../x.git`
  // is never treated as a git URL).
  if (INTENTIONAL_PROTOCOLS.some((p) => spec.startsWith(p))) return null;

  // Git / URL specs.
  if (
    spec.startsWith("git+") ||
    spec.startsWith("git:") ||
    spec.startsWith("github:") ||
    spec.startsWith("gitlab:") ||
    spec.startsWith("bitbucket:") ||
    spec.startsWith("gist:") ||
    URL_RE.test(spec) ||
    spec.endsWith(".git") ||
    OWNER_REPO_REF_RE.test(spec)
  ) {
    return "git";
  }

  // Floating wildcard / bare dist-tag (empty spec floats too).
  if (spec === "" || FLOATING_TAGS.has(spec)) return "floating";

  // Everything else — treat as a semver range and stay silent (precision-first).
  return null;
};

/** 1-based line and column of the `"<name>"` entry in the raw JSON text. */
const locate = (lines: string[], name: string, spec: string): { line: number; column: number } => {
  const key = `"${name}"`;
  // Prefer the line that also contains the spec, to disambiguate a name that
  // appears in more than one dependency map; fall back to the first key line.
  let idx = lines.findIndex((l) => l.includes(key) && l.includes(spec));
  if (idx < 0) idx = lines.findIndex((l) => l.includes(key));
  if (idx < 0) return { line: 1, column: 1 };
  const col = lines[idx]!.indexOf(key);
  return { line: idx + 1, column: (col < 0 ? 0 : col) + 1 };
};

export const noUnpinnedDependency = defineTextDiagnostic({
  id: "no-unpinned-dependency",
  title: "Unpinned dependency (git ref, URL, or floating tag) in package.json",
  severity: "warn",
  category: "Security",
  tags: ["supply-chain"],
  defaultEnabled: false,
  files: ["**/package.json"],
  maxBytes: 512 * 1024,
  recommendation:
    "Pin the dependency to an exact or registry semver range (e.g. `^1.2.3`, `~1.2.0`, `1.2.3`) so the install is reproducible from package.json + lockfile and every version resolves through the registry.",
  scan: (ctx) => {
    let pkg: unknown;
    try {
      pkg = JSON.parse(ctx.content);
    } catch {
      return; // Malformed package.json — report nothing.
    }
    if (typeof pkg !== "object" || pkg === null) return;

    const lines = ctx.content.split("\n");
    const record = pkg as Record<string, unknown>;

    for (const mapName of DEPENDENCY_MAPS) {
      const map = record[mapName];
      if (typeof map !== "object" || map === null) continue;
      for (const [name, spec] of Object.entries(map as Record<string, unknown>)) {
        if (typeof spec !== "string") continue;
        const offense = classify(spec);
        if (offense === null) continue;
        const { line, column } = locate(lines, name, spec);
        const kind = offense === "git" ? "a git ref / URL" : "a floating tag / wildcard";
        ctx.report({
          line,
          column,
          message:
            `dependency \`${name}\` is pinned to ${kind} (\`${spec}\`) — the build is not reproducible ` +
            `from the registry + lockfile, and a moving ref is a supply-chain risk. ` +
            `Pin it to an exact/registry semver range.`,
        });
      }
    }
  },
});
