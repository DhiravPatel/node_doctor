/**
 * Migration text diagnostics (FEATURE.md §14/§15). Like the IaC and secrets
 * buckets these read whole non-source files rather than an ESTree AST, so they
 * are outside the codegen registry and are collected here by hand.
 */

import type { TextDiagnostic } from "../../core/text-scan.ts";
import { migrationAddNotNullWithoutDefault } from "./migration-add-not-null-without-default.ts";
import { migrationDestructiveWithoutGuard } from "./migration-destructive-without-guard.ts";
import { migrationMissingIndexOnForeignKey } from "./migration-missing-index-on-foreign-key.ts";
import { migrationIndexWithoutConcurrently } from "./migration-index-without-concurrently.ts";
import { migrationColumnTypeRewrite } from "./migration-column-type-rewrite.ts";
import { migrationVolatileColumnDefault } from "./migration-volatile-column-default.ts";
import { migrationForeignKeyWithoutNotValid } from "./migration-foreign-key-without-not-valid.ts";

export const MIGRATION_DIAGNOSTICS: TextDiagnostic[] = [
  migrationAddNotNullWithoutDefault,
  migrationDestructiveWithoutGuard,
  migrationMissingIndexOnForeignKey,
  migrationIndexWithoutConcurrently,
  migrationForeignKeyWithoutNotValid,
  migrationVolatileColumnDefault,
  migrationColumnTypeRewrite,
];

export { migrationAddNotNullWithoutDefault, migrationDestructiveWithoutGuard, migrationMissingIndexOnForeignKey, migrationIndexWithoutConcurrently, migrationForeignKeyWithoutNotValid, migrationVolatileColumnDefault, migrationColumnTypeRewrite };
