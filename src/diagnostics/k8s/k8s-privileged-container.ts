import { defineTextDiagnostic } from "../../core/text-scan.ts";
import type { ManifestNode } from "./context.ts";
import { containerNames, isTrue, kubernetesDocuments, unquote, walkNodes } from "./context.ts";

/**
 * A container that runs privileged, may escalate privilege, or asks for a
 * capability that is equivalent to root on the node.
 *
 * `privileged: true` hands the container every capability, an unmasked `/proc`
 * and every host device — it can mount the host filesystem and write to it, so
 * a single RCE in the application is a node compromise rather than a pod
 * compromise. `SYS_ADMIN` is the same story under a smaller name, and
 * `capabilities.add: [ALL]` is privileged spelled differently.
 *
 * ❌ securityContext: { privileged: true }
 * ❌ securityContext: { capabilities: { add: [SYS_ADMIN] } }
 * ✅ securityContext: { allowPrivilegeEscalation: false,
 *      capabilities: { drop: [ALL], add: [NET_BIND_SERVICE] } }
 */

/** Capabilities that are, in practice, a container escape. */
/**
 * Deliberately only the two that are genuinely equivalent to owning the node.
 * NET_ADMIN is excluded: every Istio sidecar-injection output, every CNI plugin
 * and every VPN/proxy init container adds it, so flagging it reports the
 * service-mesh install itself — the finding would be wrong far more often than
 * right, and a rule people learn to ignore protects nobody.
 */
const DANGEROUS_CAPABILITIES = new Set(["ALL", "SYS_ADMIN"]);

/** `[SYS_ADMIN, "NET_ADMIN"]` → the entries it contains. */
const flowSequenceValues = (value: string): string[] => {
  const match = /^\[(.*)\]$/.exec(value.trim());
  if (!match) return [];
  return match[1]!
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

const normalizeCapability = (raw: string): string => unquote(raw).toUpperCase().replace(/^CAP_/, "");

export const k8sPrivilegedContainer = defineTextDiagnostic({
  id: "k8s-privileged-container",
  title: "Container runs privileged or with node-equivalent capabilities",
  severity: "error",
  category: "Security",
  confidence: "high",
  tags: ["iac", "k8s"],
  files: ["**/*.yml", "**/*.yaml"],
  maxBytes: 256 * 1024,
  recommendation:
    "Drop `privileged` and set `allowPrivilegeEscalation: false`, then `capabilities.drop: [ALL]` and add back only what the process actually needs (typically NET_BIND_SERVICE, or nothing at all). If the workload genuinely needs node access — a CNI agent, a node exporter — run it as its own tightly scoped DaemonSet with its own service account instead of privileging an application pod.",
  scan: (ctx) => {
    for (const document of kubernetesDocuments(ctx.content)) {
      const names = containerNames(document.root);
      const subject = (node: ManifestNode): string => {
        const name = names.get(node);
        return name ? `Container "${name}"` : "A container";
      };

      walkNodes(document.root, (node, parent) => {
        if (node.key === null) return;

        // `privileged` and `allowPrivilegeEscalation` exist only on a
        // container's securityContext. Requiring that parent is what keeps a
        // docker-compose service or a CI job's `privileged: true` out of here.
        if (parent.key === "securityContext" && isTrue(node.value)) {
          if (node.key === "privileged") {
            ctx.report({
              line: node.line + 1,
              column: node.column,
              message: `${subject(node)} runs with \`privileged: true\` — it holds every capability and every host device, so an application-level RCE becomes a node compromise.`,
            });
            return;
          }
          if (node.key === "allowPrivilegeEscalation") {
            ctx.report({
              line: node.line + 1,
              column: node.column,
              message: `${subject(node)} sets \`allowPrivilegeEscalation: true\` — a setuid binary in the image can then gain privileges the pod spec never granted.`,
            });
            return;
          }
        }

        // `capabilities.add` only. `drop` is the hardening we want, so a
        // `drop: [ALL]` right next to it must never be read as a finding.
        if (node.key !== "add" || parent.key !== "capabilities") return;

        const inline = flowSequenceValues(node.value);
        if (inline.length > 0) {
          const dangerous = inline.map(normalizeCapability).filter((c) => DANGEROUS_CAPABILITIES.has(c));
          if (dangerous.length > 0) {
            ctx.report({
              line: node.line + 1,
              column: node.column,
              message: `${subject(node)} adds the \`${dangerous[0]}\` capability — that is equivalent to running privileged on the node.`,
            });
          }
          return;
        }

        for (const entry of node.children) {
          if (!entry.item) continue;
          const capability = normalizeCapability(entry.value);
          if (!DANGEROUS_CAPABILITIES.has(capability)) continue;
          ctx.report({
            line: entry.line + 1,
            column: entry.column,
            message: `${subject(node)} adds the \`${capability}\` capability — that is equivalent to running privileged on the node.`,
          });
        }
      });
    }
  },
});
