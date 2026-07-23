/**
 * The canonical list of text (Phase C) diagnostics.
 *
 * Text diagnostics read whole non-source files rather than an ESTree AST, so
 * unlike the file/project buckets they are not discovered by the registry
 * codegen and have to be listed by hand. That list lives here, in exactly one
 * place, because it has three consumers — the scanner, the `diagnostics` CLI
 * catalog, and the config-schema generator — and when each composed its own,
 * adding a bucket silently left the new diagnostics out of the catalog and the
 * schema while the scanner ran them.
 */

import type { TextDiagnostic } from "../core/text-scan.ts";
import { TEXT_DIAGNOSTICS } from "./secrets/index.ts";
import { IAC_DIAGNOSTICS } from "./iac/index.ts";
import { CONTAINER_DIAGNOSTICS } from "./container/index.ts";
import { K8S_DIAGNOSTICS } from "./k8s/index.ts";
import { CICD_DIAGNOSTICS } from "./cicd/index.ts";
import { MIGRATION_DIAGNOSTICS } from "./migrations/index.ts";

export const ALL_TEXT_DIAGNOSTICS: TextDiagnostic[] = [
  ...TEXT_DIAGNOSTICS,
  ...IAC_DIAGNOSTICS,
  ...CONTAINER_DIAGNOSTICS,
  ...K8S_DIAGNOSTICS,
  ...CICD_DIAGNOSTICS,
  ...MIGRATION_DIAGNOSTICS,
];
