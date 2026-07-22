import { defineTextDiagnostic } from "../../core/text-scan.ts";
import { isIacFile, stripComment, insideBlock } from "./context.ts";

/**
 * An ingress rule open to the entire internet (`0.0.0.0/0` or `::/0`).
 *
 * This is the single most common cloud misconfiguration that turns an internal
 * service into a public one — a database, an admin port, or SSH reachable from
 * anywhere. Egress to `0.0.0.0/0` is deliberately NOT flagged: outbound-to-
 * anywhere is the normal default, and firing on it would bury the real finding.
 *
 * ❌ ingress { from_port = 5432  cidr_blocks = ["0.0.0.0/0"] }
 * ✅ ingress { from_port = 5432  cidr_blocks = [var.vpc_cidr] }
 * ✅ egress  { cidr_blocks = ["0.0.0.0/0"] }        // normal
 */

const OPEN_CIDR_RE = /["']?(?:0\.0\.0\.0\/0|::\/0)["']?/;
const INGRESS_RE = /(^|_)ingress$|securitygroupingress/i;
const EGRESS_RE = /(^|_)egress$|securitygroupegress/i;
/** Ports where public exposure is the whole point of the service. */
const PUBLIC_WEB_PORTS = /\b(from_port|toport|fromport)\s*[:=]\s*["']?(80|443)["']?/i;

export const noOpenSecurityGroup = defineTextDiagnostic({
  id: "no-open-security-group",
  title: "Security group allows ingress from the entire internet",
  severity: "error",
  category: "Security",
  confidence: "high",
  tags: ["iac", "network"],
  files: ["**/*.tf", "**/*.tfvars", "**/*.yml", "**/*.yaml", "**/*.json"],
  maxBytes: 256 * 1024,
  recommendation:
    "Restrict the CIDR to the networks that actually need access (a VPC range, a bastion, an office block). If the service is genuinely public, terminate it behind a load balancer or WAF rather than opening the instance's security group.",
  scan: (ctx) => {
    if (!isIacFile(ctx.normalizedFilePath, ctx.content)) return;
    const lines = ctx.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = stripComment(lines[i]!);
      if (!OPEN_CIDR_RE.test(line)) continue;
      // Egress-to-anywhere is normal; only ingress is a finding.
      if (insideBlock(lines, i, EGRESS_RE)) continue;
      if (!insideBlock(lines, i, INGRESS_RE)) continue;
      // A public web port is a defensible intent; say so rather than crying wolf.
      const context = lines.slice(Math.max(0, i - 6), i + 6).join("\n");
      if (PUBLIC_WEB_PORTS.test(context)) continue;
      ctx.report({
        line: i + 1,
        column: line.search(OPEN_CIDR_RE) + 1,
        message:
          "Ingress is open to the entire internet (0.0.0.0/0) on a non-web port — anyone can reach this service directly.",
      });
    }
  },
});
