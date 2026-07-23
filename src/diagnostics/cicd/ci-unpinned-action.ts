import { defineTextDiagnostic } from "../../core/text-scan.ts";
import { blockScalarMask, isWorkflowFile, parentKeyOf, parseKeyLine, scalarValue, splitLines } from "./context.ts";

/**
 * A third-party action referenced by a mutable tag or branch instead of a commit SHA.
 *
 * `@v4` and `@main` are pointers, not versions: whoever controls the action's
 * repository can move them at any time, and the next run of your pipeline
 * fetches whatever they now point at — with your `GITHUB_TOKEN` and your
 * secrets already in the environment. Every large Actions supply-chain incident
 * so far has worked exactly this way.
 *
 * Opt-in: SHA pinning is a defensible policy, not a universal one, and a
 * default-on version of this would fire on every `actions/checkout@v4` in the
 * repository — noise that would drown the checks that find real defects.
 *
 * ❌ uses: actions/checkout@v4
 * ✅ uses: actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8  # v4.1.1
 * ✅ uses: ./.github/actions/setup       // local, versioned with this repo
 */

/**
 * Git object ids: 40 hex for SHA-1, 64 for repositories that have migrated to
 * SHA-256. Accepting the whole range rather than the two exact lengths is
 * deliberate — mistyped pins of 41 characters exist in the wild, and a broken
 * reference is not a mutable tag; saying it is would be a lie.
 */
const PINNED_REF_RE = /^[0-9a-f]{40,64}$/;
/** A relative path is this repository's own code; `docker://` carries no git ref. */
const NOT_A_GIT_ACTION_RE = /^(?:\.{1,2}[/\\]|docker:\/\/)/;
/** `owner/repo@ref`, optionally with a subdirectory or reusable-workflow path. */
const ACTION_REF_RE = /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@\S+$/;

export const ciUnpinnedAction = defineTextDiagnostic({
  id: "ci-unpinned-action",
  title: "GitHub Action pinned to a mutable tag or branch",
  severity: "warn",
  category: "Security",
  confidence: "high",
  defaultEnabled: false,
  tags: ["ci", "supply-chain"],
  files: [".github/workflows/*.yml", ".github/workflows/*.yaml"],
  maxBytes: 256 * 1024,
  recommendation:
    "Pin the action to a full 40-character commit SHA and keep the human-readable version in a trailing comment (`uses: owner/repo@<sha>  # v4.1.1`). Dependabot understands that form and will raise a PR when the tag moves, so you get updates without giving the upstream repository the ability to change what runs today.",
  scan: (ctx) => {
    if (!isWorkflowFile(ctx.content)) return;
    const lines = splitLines(ctx.content);
    const mask = blockScalarMask(lines);

    for (let i = 0; i < lines.length; i++) {
      if (mask[i]) continue;
      const parsed = parseKeyLine(lines[i]!);
      if (!parsed || parsed.key !== "uses") continue;

      // `with: { uses: … }` is an action input that happens to share the name.
      if (parentKeyOf(lines, mask, i) === "with") continue;

      const value = scalarValue(parsed.value);
      if (value.length === 0) continue;
      if (NOT_A_GIT_ACTION_RE.test(value)) continue;
      // A computed `uses:` cannot be resolved offline, so say nothing.
      if (value.includes("${{")) continue;
      if (!ACTION_REF_RE.test(value)) continue;

      const at = value.lastIndexOf("@");
      if (at <= 0) continue;
      const ref = value.slice(at + 1);
      if (ref.length === 0 || PINNED_REF_RE.test(ref)) continue;

      const atInLine = lines[i]!.indexOf("@", parsed.valueColumn);
      ctx.report({
        line: i + 1,
        column: (atInLine >= 0 ? atInLine + 1 : parsed.valueColumn) + 1,
        message: `\`${value.slice(0, at)}\` is pinned to the mutable ref \`${ref}\` — whoever controls that repository can repoint it, and the new code runs in this pipeline with the workflow's token and secrets.`,
      });
    }
  },
});
