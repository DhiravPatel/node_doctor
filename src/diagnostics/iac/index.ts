/**
 * IaC security text diagnostics. Like the secrets bucket, these read whole
 * non-source files rather than an AST, so they live outside the codegen registry
 * and are collected here by hand.
 */

import type { TextDiagnostic } from "../../core/text-scan.ts";
import { noOpenSecurityGroup } from "./no-open-security-group.ts";
import { noPublicCloudStorage } from "./no-public-cloud-storage.ts";
import { noOverbroadIamPolicy } from "./no-overbroad-iam-policy.ts";

export const IAC_DIAGNOSTICS: TextDiagnostic[] = [
  noOpenSecurityGroup,
  noOverbroadIamPolicy,
  noPublicCloudStorage,
];

export { noOpenSecurityGroup, noOverbroadIamPolicy, noPublicCloudStorage };
