import { defineTextDiagnostic } from "../../core/text-scan.ts";
import { isIacFile, stripComment } from "./context.ts";

/**
 * An object-storage bucket made world-readable, or with its public-access block
 * switched off. Public buckets are the classic source of mass data exposure —
 * the leak is silent, and the config line looks unremarkable in review.
 *
 * ❌ acl = "public-read"
 * ❌ block_public_acls = false
 * ❌ AccessControl: PublicRead
 * ✅ acl = "private"   /   block_public_acls = true
 */

const PUBLIC_ACL_RE = /\bacl\s*[:=]\s*["'](public-read|public-read-write)["']/i;
const CFN_PUBLIC_ACL_RE = /\bAccessControl\s*:\s*["']?(PublicRead|PublicReadWrite)["']?/i;
const BLOCK_DISABLED_RE = /\b(block_public_acls|block_public_policy|ignore_public_acls|restrict_public_buckets)\s*[:=]\s*false\b/i;
const CFN_BLOCK_DISABLED_RE = /\b(BlockPublicAcls|BlockPublicPolicy|IgnorePublicAcls|RestrictPublicBuckets)\s*:\s*false\b/i;

export const noPublicCloudStorage = defineTextDiagnostic({
  id: "no-public-cloud-storage",
  title: "Object storage is publicly readable",
  severity: "error",
  category: "Security",
  confidence: "high",
  tags: ["iac", "storage"],
  files: ["**/*.tf", "**/*.tfvars", "**/*.yml", "**/*.yaml", "**/*.json"],
  maxBytes: 256 * 1024,
  recommendation:
    "Set the ACL to `private` and leave every public-access block enabled. Serve public objects through a CDN with a signed origin instead of exposing the bucket itself.",
  scan: (ctx) => {
    if (!isIacFile(ctx.normalizedFilePath, ctx.content)) return;
    const lines = ctx.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = stripComment(lines[i]!);
      if (PUBLIC_ACL_RE.test(line) || CFN_PUBLIC_ACL_RE.test(line)) {
        ctx.report({ line: i + 1, message: "Bucket ACL grants public read access — anyone on the internet can list and download these objects." });
        continue;
      }
      if (BLOCK_DISABLED_RE.test(line) || CFN_BLOCK_DISABLED_RE.test(line)) {
        ctx.report({ line: i + 1, message: "A public-access block is disabled — this removes the guardrail that prevents accidental public exposure." });
      }
    }
  },
});
