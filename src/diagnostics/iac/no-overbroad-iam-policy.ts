import { defineTextDiagnostic } from "../../core/text-scan.ts";
import { isIacFile, stripComment, blockStackAt } from "./context.ts";

/**
 * An IAM statement that allows every action on every resource — `"Action": "*"`
 * together with `"Resource": "*"`. That is a full-access grant: any principal
 * holding it can read every bucket, mint credentials, and delete the account's
 * infrastructure.
 *
 * Both wildcards together are the dangerous shape. Either one **alone** is
 * routinely legitimate (`s3:GetObject` on `*`, or `s3:*` on one bucket ARN), so
 * firing on a single wildcard would be noise.
 *
 * ❌ Effect: Allow · Action: "*"          · Resource: "*"
 * ✅ Effect: Allow · Action: "s3:GetObject" · Resource: "*"
 * ✅ Effect: Allow · Action: "s3:*"         · Resource: "arn:aws:s3:::my-bucket/*"
 */

const ALLOW_RE = /["']?Effect["']?\s*[:=]\s*["']Allow["']/i;
const WILDCARD_ACTION_RE = /["']?Action["']?\s*[:=]\s*(\[[^\]]*)?["']\*["']/i;
const WILDCARD_RESOURCE_RE = /["']?Resource["']?\s*[:=]\s*(\[[^\]]*)?["']\*["']/i;
/** Terraform's aws_iam_policy_document uses bare `actions`/`resources` lists. */
const TF_WILDCARD_ACTIONS_RE = /\bactions\s*=\s*\[[^\]]*["']\*["']/i;
const TF_WILDCARD_RESOURCES_RE = /\bresources\s*=\s*\[[^\]]*["']\*["']/i;

/** Lines belonging to the same statement, bounded so we never span two policies. */
const STATEMENT_WINDOW = 25;

export const noOverbroadIamPolicy = defineTextDiagnostic({
  id: "no-overbroad-iam-policy",
  title: "IAM policy allows every action on every resource",
  severity: "error",
  category: "Security",
  confidence: "high",
  tags: ["iac", "iam"],
  files: ["**/*.tf", "**/*.tfvars", "**/*.yml", "**/*.yaml", "**/*.json"],
  maxBytes: 256 * 1024,
  recommendation:
    "Scope the statement: list the specific actions the principal needs and the specific resource ARNs they apply to. `Action: \"*\"` with `Resource: \"*\"` is administrator access — grant it deliberately and never to a service role.",
  scan: (ctx) => {
    if (!isIacFile(ctx.normalizedFilePath, ctx.content)) return;
    const lines = ctx.content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = stripComment(lines[i]!);

      // --- Terraform aws_iam_policy_document: one `statement { … }` block ---
      if (TF_WILDCARD_ACTIONS_RE.test(line) && blockStackAt(lines, i).includes("statement")) {
        const window = lines.slice(Math.max(0, i - STATEMENT_WINDOW), i + STATEMENT_WINDOW).map(stripComment).join("\n");
        if (TF_WILDCARD_RESOURCES_RE.test(window)) {
          ctx.report({ line: i + 1, message: "This IAM statement allows every action on every resource — it is full administrator access." });
        }
        continue;
      }

      // --- JSON/YAML policy statement ---
      if (!ALLOW_RE.test(line)) continue;
      const window = lines.slice(i, i + STATEMENT_WINDOW).map(stripComment).join("\n");
      // Stop at the next Effect so two adjacent statements never combine.
      const nextEffect = window.slice(line.length).search(ALLOW_RE);
      const statement = nextEffect > 0 ? window.slice(0, line.length + nextEffect) : window;
      if (WILDCARD_ACTION_RE.test(statement) && WILDCARD_RESOURCE_RE.test(statement)) {
        ctx.report({ line: i + 1, message: "This IAM statement allows every action on every resource — it is full administrator access." });
      }
    }
  },
});
