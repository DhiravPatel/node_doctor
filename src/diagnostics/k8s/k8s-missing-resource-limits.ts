import { defineTextDiagnostic } from "../../core/text-scan.ts";
import type { ManifestNode } from "./context.ts";
import { CONTAINER_KEYS, childByKey, containerItems, kubernetesDocuments, unquote } from "./context.ts";

/**
 * OPT-IN (`defaultEnabled: false`). A container with no `resources.limits`.
 *
 * Without a memory limit a single leaking workload consumes the node's memory
 * and the kernel OOM killer picks the victim — by `oom_score`, not by your
 * priorities — so an unrelated, healthy pod on the same node is the one that
 * dies. Without a CPU limit a hot loop starves every other container's
 * scheduling share. Limits are also what put a pod in the Guaranteed/Burstable
 * QoS classes that eviction ordering is based on.
 *
 * It ships opt-in because absence of a field is not proof of absence of a
 * limit: a Kustomize base legitimately omits limits that an overlay patches in,
 * a strategic-merge patch fragment carries the same `apiVersion`/`kind`/
 * `containers` shape while listing only the fields it changes, and a namespace
 * `LimitRange` supplies defaults the manifest never mentions. Enable it in a
 * repo where the manifests are the whole truth.
 *
 * ❌ containers: [{ name: api, image: api:1 }]
 * ✅ containers: [{ name: api, image: api:1,
 *      resources: { requests: {...}, limits: { cpu: "1", memory: 512Mi } } }]
 */

/** Only long-lived containers; an ephemeral debug container has no limits by design. */
const LIMITED_CONTAINER_KEYS: ReadonlySet<string> = new Set(
  [...CONTAINER_KEYS].filter((key) => key !== "ephemeralContainers"),
);

/** A merge key or alias anywhere in the container means the spec is not all here. */
const usesMergeOrAlias = (node: ManifestNode): boolean => {
  const pending: ManifestNode[] = [node];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.key === "<<") return true;
    if (current.value.startsWith("*")) return true;
    for (const child of current.children) pending.push(child);
  }
  return false;
};

export const k8sMissingResourceLimits = defineTextDiagnostic({
  id: "k8s-missing-resource-limits",
  title: "Container declares no resource limits",
  severity: "warn",
  category: "Reliability",
  confidence: "medium",
  defaultEnabled: false,
  tags: ["iac", "k8s"],
  files: ["**/*.yml", "**/*.yaml"],
  maxBytes: 256 * 1024,
  recommendation:
    "Give the container `resources.limits.memory` (and `limits.cpu` where it is CPU-bound) alongside `resources.requests`, so the scheduler can place it and the kubelet evicts the workload that actually misbehaved. If limits are set centrally, enforce them with a namespace `LimitRange` rather than leaving them implicit.",
  scan: (ctx) => {
    for (const document of kubernetesDocuments(ctx.content)) {
      for (const container of containerItems(document.root, LIMITED_CONTAINER_KEYS)) {
        const image = childByKey(container, "image");
        // A container entry without an image is a patch fragment naming an
        // existing container, not a definition — its limits live elsewhere.
        if (!image || unquote(image.value).length === 0) continue;
        if (usesMergeOrAlias(container)) continue;

        const resources = childByKey(container, "resources");
        if (resources) {
          // A flow mapping or anything else we did not decompose: unresolved,
          // so say nothing rather than guess it lacks limits.
          if (resources.value.length > 0) continue;
          if (childByKey(resources, "limits")) continue;
        }

        const anchor = childByKey(container, "name") ?? container;
        const name = unquote(childByKey(container, "name")?.value ?? "");
        ctx.report({
          line: anchor.line + 1,
          column: anchor.column,
          message: `${name ? `Container "${name}"` : "A container"} declares no \`resources.limits\` — it can consume the whole node, and the OOM killer then evicts by heuristic rather than by your policy.`,
        });
      }
    }
  },
});
