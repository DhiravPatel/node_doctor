/**
 * The public API surface of node.doctor.
 *
 * Import it to build custom integrations, dashboards, editor plugins, or bespoke
 * CI logic. Everything here is stable and versioned; the JSON `schemaVersion`
 * pins the report shape.
 */

// Programmatic API
export { diagnose } from "./api.ts";
export type {
  DiagnoseOptions,
  BatchDiagnoseInput,
  BatchDiagnoseResult,
  DiagnoseOutcome,
} from "./api.ts";

// Scanning
export {
  scanProject,
  lintSource,
  sortFindings,
  SCHEMA_VERSION,
} from "./core/scan.ts";
export type {
  ScanReport,
  ScanProjectOptions,
  LintSourceOptions,
  LintSourceResult,
  ParseFailure,
} from "./core/scan.ts";

// Delta
export { computeDelta, deltaHasBlocking } from "./core/delta.ts";
export type { DeltaResult } from "./core/delta.ts";

// Workspaces / monorepo
export {
  scanWorkspaces,
  discoverWorkspaces,
  isWorkspaceRoot,
  workspaceFindings,
} from "./core/workspaces.ts";
export type { WorkspaceReport, WorkspaceProjectReport, ScanWorkspacesOptions } from "./core/workspaces.ts";

// Scoring
export {
  calculateScore,
  findingWeight,
  SEVERITY_WEIGHTS,
  CATEGORY_WEIGHTS,
  DENSITY_AT_ZERO,
} from "./core/score.ts";
export type { ScoreResult, ScoreLabel } from "./core/score.ts";

// Reporting
export { renderReport, renderDelta } from "./report/terminal.ts";
export { renderReportMarkdown, renderDeltaMarkdown, SUMMARY_MARKER } from "./report/markdown.ts";
export { toJson } from "./report/json.ts";
export { toSarif } from "./report/sarif.ts";
export { toAnnotations } from "./report/annotations.ts";
export { toHtml } from "./report/html.ts";
export { renderDeslop } from "./report/deslop.ts";

// Autofix & MCP
export { fixSource, FIXABLE_DIAGNOSTICS } from "./fix/index.ts";
export { handleMessage as mcpHandleMessage, startMcpServer } from "./mcp/server.ts";

// Agent fix (hand findings to a coding agent)
export { runAgentFix, buildAgentPrompt, detectAgents, AGENTS, copyToClipboard } from "./agent/fix.ts";
export type { AgentDef, RunAgentFixOptions, FixAction } from "./agent/fix.ts";

// Registry
export { DIAGNOSTICS, DIAGNOSTICS_BY_ID } from "./core/registry.ts";

// Project / capabilities
export {
  discoverProject,
  shouldEnableDiagnostic,
  detectCapabilities,
  capabilitiesSatisfied,
  majorVersion,
} from "./core/project.ts";
export type { ProjectInfo, PackageManifest } from "./core/project.ts";

// Dead-code scanner
export { runDeslop } from "./deslop/index.ts";
export type { DeslopResult } from "./deslop/index.ts";

// Whole-tree text scan (secrets / config files)
export { runTextScan, selectTextDiagnostics, defineTextDiagnostic } from "./core/text-scan.ts";
export type { TextDiagnostic, TextScanContext, RunTextScanOptions } from "./core/text-scan.ts";
export { TEXT_DIAGNOSTICS } from "./diagnostics/secrets/index.ts";
// The full text-diagnostic catalog (secrets + IaC + container + k8s + CI +
// migrations). A consumer enumerating the whole ruleset needs
// `DIAGNOSTICS.concat(ALL_TEXT_DIAGNOSTICS)`; `TEXT_DIAGNOSTICS` alone is only the
// secrets subset and left the count 15 short.
export { ALL_TEXT_DIAGNOSTICS } from "./diagnostics/text-diagnostics.ts";
// §120 — blast-radius / change-impact over the import graph.
export { buildImpactGraph, computeImpact } from "./core/impact.ts";
export type { ImpactReport, Dependent } from "./core/impact.ts";
// §151 — Observability Coverage Score: per-route "could you debug this at 3am?".
export { buildObservabilityReport } from "./core/observability.ts";
export type { ObservabilityReport, RouteObservability } from "./core/observability.ts";
// §143 — Data Access Map & Route → Entity Lineage: which routes touch which DB
// entities (tables/models) and how (read/write/delete), from the call graph.
export { buildDataAccessMap, queryTarget } from "./core/data-map.ts";
export type { DataAccessMap, RouteAccess, EntityAccess, DataOp } from "./core/data-map.ts";
// §142 — Dead Schema & Schema Drift: the Prisma schema crossed against every
// statically-visible model access — unknown-field drift + provably-dead models.
export { buildSchemaDriftReport } from "./core/schema-drift.ts";
export type { SchemaDriftReport, DriftFinding, DeadModelEntry } from "./core/schema-drift.ts";
export { parsePrismaSchema } from "./core/prisma-schema.ts";
export type { PrismaSchema, PrismaModel, PrismaField, PrismaEnum } from "./core/prisma-schema.ts";
// §157 — Queue & Topic Topology: who publishes to each topic/queue, who consumes
// it, orphan topics, dead consumers — the event-driven import graph.
export { buildQueueTopology } from "./core/queue-topology.ts";
export type { QueueTopologyReport, TopicEntry, TopologySite, QueueSystem } from "./core/queue-topology.ts";
// §155 — Internal Package API Semver Linting: the export surface of every
// workspace package, diffed against a baseline; a removed export without the
// version bump to match is the finding.
export { buildApiSemverReport } from "./core/api-semver.ts";
export type { ApiSemverReport, PackageSurface, SemverChange, SemverVerdict } from "./core/api-semver.ts";
// §33 — Architecture Analysis: import cycles (a runtime hazard), layer
// violations, and hub modules, all from the project import graph.
export { buildArchitectureReport } from "./core/architecture.ts";
export type { ArchitectureReport, ImportCycle, LayerViolation, HubModule } from "./core/architecture.ts";
// §77 — OpenAPI Generation From Code: a spec derived from the actual routes, so
// it cannot drift from the code that serves it.
export { buildOpenApiDocument } from "./core/openapi.ts";
export type { OpenApiDocument, OpenApiResult, OpenApiOperation, OpenApiParameter } from "./core/openapi.ts";
// §158 — agent context hygiene: detect secrets/keys an AI agent can read and
// generate the ignore artifacts (.aiignore/.cursorignore/Claude deny) to fence them off.
export { scanAgentContext, applyContextHygiene, buildIgnoreEntries } from "./core/agent-context.ts";
export type { ContextHygieneReport, SensitiveFile, SensitiveCategory } from "./core/agent-context.ts";

// Config
export { loadConfig, BUILTIN_IGNORES } from "./core/config.ts";
export type { NodeDoctorConfig, DiagnosticSetting, BlockingLevel } from "./core/config.ts";

// Diagnostic authoring contract
export { defineDiagnostic, CATEGORIES, SEVERITIES, PLUGIN } from "./core/types.ts";
export type {
  Diagnostic,
  DiagnosticContext,
  Finding,
  Category,
  Severity,
  Scope,
  AstNode,
  Visitors,
  ReportOverrides,
} from "./core/types.ts";
