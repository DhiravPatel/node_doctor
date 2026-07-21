/**
 * Text-scan (Phase C) diagnostics: they read whole non-source files rather than
 * an ESTree AST, so they live outside the codegen registry and are collected
 * here by hand.
 */

import type { TextDiagnostic } from "../../core/text-scan.ts";
import { noCommittedEnvSecret } from "./no-committed-env-secret.ts";
import { noCommittedPrivateKey } from "./no-committed-private-key.ts";
import { noSecretInConfigFile } from "./no-secret-in-config-file.ts";

export const TEXT_DIAGNOSTICS: TextDiagnostic[] = [
  noCommittedEnvSecret,
  noCommittedPrivateKey,
  noSecretInConfigFile,
];

export { noCommittedEnvSecret, noCommittedPrivateKey, noSecretInConfigFile };
