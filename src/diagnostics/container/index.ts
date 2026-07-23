/**
 * Container (Dockerfile) text diagnostics. Like the secrets and IaC buckets these
 * read whole non-source files rather than an AST, so they live outside the
 * codegen registry and are collected here by hand.
 */

import type { TextDiagnostic } from "../../core/text-scan.ts";
import { dockerfileRunsAsRoot } from "./dockerfile-runs-as-root.ts";
import { dockerfileMutableBaseTag } from "./dockerfile-mutable-base-tag.ts";
import { dockerfileSecretInBuildStage } from "./dockerfile-secret-in-build-stage.ts";

export const CONTAINER_DIAGNOSTICS: TextDiagnostic[] = [
  dockerfileMutableBaseTag,
  dockerfileRunsAsRoot,
  dockerfileSecretInBuildStage,
];

export { dockerfileRunsAsRoot, dockerfileMutableBaseTag, dockerfileSecretInBuildStage };
