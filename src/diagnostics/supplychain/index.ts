/**
 * Supply-chain text diagnostics. Like the other text buckets, these read whole
 * non-source files (here, `package.json`) rather than an AST, so they live
 * outside the codegen registry and are collected here by hand.
 */

import type { TextDiagnostic } from "../../core/text-scan.ts";
import { noUnpinnedDependency } from "./no-unpinned-dependency.ts";
import { noConflictingDependencyDeclaration } from "./no-conflicting-dependency-declaration.ts";

export const SUPPLYCHAIN_DIAGNOSTICS: TextDiagnostic[] = [
  noUnpinnedDependency,
  noConflictingDependencyDeclaration,
];

export { noUnpinnedDependency, noConflictingDependencyDeclaration };
