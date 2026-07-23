/**
 * Migration text diagnostics (FEATURE.md §14/§15). Like the IaC and secrets
 * buckets these read whole non-source files rather than an ESTree AST, so they
 * are outside the codegen registry and are collected here by hand.
 */

import type { TextDiagnostic } from "../../core/text-scan.ts";
import { migrationAddNotNullWithoutDefault } from "./migration-add-not-null-without-default.ts";
import { migrationDestructiveWithoutGuard } from "./migration-destructive-without-guard.ts";
import { migrationMissingIndexOnForeignKey } from "./migration-missing-index-on-foreign-key.ts";

export const MIGRATION_DIAGNOSTICS: TextDiagnostic[] = [
  migrationAddNotNullWithoutDefault,
  migrationDestructiveWithoutGuard,
  migrationMissingIndexOnForeignKey,
];

export { migrationAddNotNullWithoutDefault, migrationDestructiveWithoutGuard, migrationMissingIndexOnForeignKey };
