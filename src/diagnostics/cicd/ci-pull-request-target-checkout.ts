import { defineTextDiagnostic } from "../../core/text-scan.ts";
import {
  blockScalarMask,
  isWorkflowFile,
  parseKeyLine,
  scalarValue,
  splitLines,
  stepRange,
  workflowTriggers,
} from "./context.ts";

/**
 * A `pull_request_target` workflow that checks out the pull request's own head.
 *
 * Unlike `pull_request`, this trigger runs in the context of the *base*
 * repository: a read-write `GITHUB_TOKEN` and every repository secret are
 * available, and no approval is required for a first-time contributor. Checking
 * out the PR's head then places untrusted code next to those credentials, and
 * anything that executes it — a build, a test, `npm install` and its lifecycle
 * scripts, even a linter that loads a config file — hands the fork's author the
 * token.
 *
 * The safe uses of `pull_request_target` (labelling, greeting, size reports)
 * never check out the head, so those stay silent.
 *
 * ❌ on: pull_request_target
 *    - uses: actions/checkout@v4
 *      with: { ref: "${{ github.event.pull_request.head.sha }}" }
 * ✅ on: pull_request                       // untrusted code, untrusted token
 * ✅ on: pull_request_target
 *    - uses: actions/checkout@v4            // base repo only — no PR code
 */

const CHECKOUT_RE = /(^|\/)actions\/checkout(@|$)/;
/** A `ref:` key, including the inline flow form `with: { ref: … }`. */
const REF_KEY_RE = /(^|[{,\s])ref\s*:/;

/**
 * Refs that resolve to code the pull request's author controls. The merge ref
 * is included because it contains the head commit; the base sha and a literal
 * branch name are not, and are the whole point of the safe pattern.
 */
const UNTRUSTED_REF_RE =
  /github\s*\.\s*event\s*\.\s*pull_request\s*\.\s*(?:head\s*\.\s*(?:sha|ref)|merge_commit_sha)|github\s*\.\s*head_ref|refs\/pull\//;

export const ciPullRequestTargetCheckout = defineTextDiagnostic({
  id: "ci-pull-request-target-checkout",
  title: "pull_request_target workflow checks out untrusted pull-request code",
  severity: "error",
  category: "Security",
  confidence: "high",
  tags: ["ci", "supply-chain"],
  files: [".github/workflows/*.yml", ".github/workflows/*.yaml"],
  maxBytes: 256 * 1024,
  recommendation:
    "Either switch the trigger to `pull_request`, which runs the fork's code with a read-only token and no secrets, or keep `pull_request_target` and do not check out the head — restrict the job to the metadata work (labelling, commenting) that needs the write token. If you genuinely need both, split them: an untrusted `pull_request` job that builds and uploads an artifact, and a separate `workflow_run` job that consumes it without executing it.",
  scan: (ctx) => {
    if (!isWorkflowFile(ctx.content)) return;
    const lines = splitLines(ctx.content);
    const mask = blockScalarMask(lines);
    if (!workflowTriggers(lines, mask).includes("pull_request_target")) return;

    for (let i = 0; i < lines.length; i++) {
      if (mask[i]) continue;
      const parsed = parseKeyLine(lines[i]!);
      if (!parsed || parsed.key !== "uses" || !CHECKOUT_RE.test(scalarValue(parsed.value))) continue;

      const { start, end } = stepRange(lines, mask, i);
      for (let j = start; j <= end; j++) {
        if (mask[j] || j === i) continue;
        const line = lines[j]!;
        if (!REF_KEY_RE.test(line) || !UNTRUSTED_REF_RE.test(line)) continue;
        ctx.report({
          line: j + 1,
          column: line.search(REF_KEY_RE) + 1,
          message:
            "This `pull_request_target` job checks out the pull request's own head, so untrusted fork code runs alongside a read-write GITHUB_TOKEN and the repository's secrets.",
        });
        break;
      }
    }
  },
});
