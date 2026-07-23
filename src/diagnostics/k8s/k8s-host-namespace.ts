import { defineTextDiagnostic } from "../../core/text-scan.ts";
import { isTrue, kubernetesDocuments, walkNodes } from "./context.ts";

/**
 * A pod that shares one of the host's namespaces.
 *
 * Each flag removes a different wall. `hostNetwork` puts the container on the
 * node's network stack: it sees every other pod's traffic, binds node ports
 * directly, and reaches the kubelet and cloud metadata endpoint as if it were
 * the node. `hostPID` exposes every process on the node — including their
 * command lines, where credentials are routinely passed — and makes them
 * signalable. `hostIPC` shares System V IPC and POSIX shared memory with every
 * other host process. Any one of them turns a pod compromise into a node one.
 *
 * ❌ spec: { hostNetwork: true, containers: [...] }
 * ✅ spec: { containers: [...] }   # reach it through a Service
 */

const HOST_NAMESPACE_FIELDS: Record<string, string | undefined> = {
  hostIPC: "shares System V IPC and shared memory with every process on the node",
  hostNetwork:
    "puts the container on the node's network stack, where it can sniff other pods' traffic and reach the kubelet and the cloud metadata endpoint as the node",
  hostPID:
    "exposes every process on the node, including the command lines that carry other workloads' credentials",
};

export const k8sHostNamespace = defineTextDiagnostic({
  id: "k8s-host-namespace",
  title: "Pod shares a host namespace",
  severity: "error",
  category: "Security",
  confidence: "high",
  tags: ["iac", "k8s"],
  files: ["**/*.yml", "**/*.yaml"],
  maxBytes: 256 * 1024,
  recommendation:
    "Remove the host-namespace flag and reach the workload through a Service (NodePort or LoadBalancer if you need a fixed port on the node). Where host visibility is genuinely the job — a metrics agent, a CNI plugin — keep it in a dedicated DaemonSet with its own service account rather than in an application pod.",
  scan: (ctx) => {
    for (const document of kubernetesDocuments(ctx.content)) {
      // A DaemonSet is the node-agent shape: node-exporter, Fluent Bit, the CNI
      // and every CSI driver share the host network/PID by design, and that is
      // upstream's own manifest. The rule keeps full strength on Deployment,
      // StatefulSet, Job, CronJob, Pod and ReplicaSet, where a host namespace is
      // never the intent.
      if (document.kind === "DaemonSet") continue;
      walkNodes(document.root, (node, parent) => {
        if (node.key === null) return;
        // These fields are valid only on a PodSpec, which is always the value
        // of a `spec:` key — `spec.hostNetwork` for a Pod, `spec.template.spec`
        // for a Deployment. Anchoring to that parent keeps look-alike keys in
        // unrelated config out of the rule.
        if (parent.key !== "spec") return;
        const consequence = HOST_NAMESPACE_FIELDS[node.key];
        if (consequence === undefined || !isTrue(node.value)) return;
        ctx.report({
          line: node.line + 1,
          column: node.column,
          message: `Pod spec sets \`${node.key}: true\` — it ${consequence}.`,
        });
      });
    }
  },
});
