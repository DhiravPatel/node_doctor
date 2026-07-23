/**
 * Kubernetes manifest text diagnostics. Every rule here first demands positive
 * evidence that the document really is a Kubernetes workload (see `context.ts`) —
 * a repo's YAML is mostly CI config, compose files and Helm values, and several of
 * those use the very words these rules look for.
 */

import type { TextDiagnostic } from "../../core/text-scan.ts";
import { k8sPrivilegedContainer } from "./k8s-privileged-container.ts";
import { k8sHostNamespace } from "./k8s-host-namespace.ts";
import { k8sMissingResourceLimits } from "./k8s-missing-resource-limits.ts";

export const K8S_DIAGNOSTICS: TextDiagnostic[] = [
  k8sHostNamespace,
  k8sMissingResourceLimits,
  k8sPrivilegedContainer,
];

export { k8sPrivilegedContainer, k8sHostNamespace, k8sMissingResourceLimits };
