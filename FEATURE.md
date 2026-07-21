# node.doctor — Features

The complete capability catalog for **node.doctor**: a deterministic static-analysis platform for Node.js backends, built on the thesis that coding agents write bad server code — code that compiles, passes tests, and fails under real load — and that a fast, curated, offline analyzer plus an agent skill can catch it and prevent it at the source.

This document is the **north-star feature catalog**. It describes the product in full. Because the scope is large, every domain carries a **maturity tier** so it is clear what exists today versus what is committed roadmap versus long-term platform ambition.

---

## Maturity legend

| Tier | Meaning |
| --- | --- |
| **Core** | Implemented in the current engine. Where a domain is only partly built, the specific implemented checks are called out. |
| **Planned** | Committed roadmap. Deterministic static analysis that fits the existing engine and the build plan; realistic to ship incrementally. |
| **Vision** | Longer-term platform scope. Requires additional infrastructure (runtime instrumentation, hosted services, an AI layer, or enterprise back-end) beyond the static-analysis core. |

**Design invariants that never change across tiers:** the analysis core is deterministic and offline (no code leaves the machine during a scan), the health score is computed locally from a published formula, precision is prioritized over recall (a false positive is a release blocker), and any AI layer is strictly optional and separated from the deterministic core so reproducibility is never compromised.

**Naming:** the product/brand is `node.doctor`; the npm package and CLI binary are `node-doctor`.

---

## Table of contents

- [Part I — Project Intelligence](#part-i--project-intelligence)
  - [1. Project Analysis](#1-project-analysis) · [2. Framework Detection](#2-framework-detection) · [46. Language Support](#46-language-support)
- [Part II — API, Routes & Documentation](#part-ii--api-routes--documentation)
  - [3. API Analysis](#3-api-analysis) · [4. Route Analysis](#4-route-analysis) · [22. API Documentation](#22-api-documentation)
- [Part III — Authentication, Authorization & Security](#part-iii--authentication-authorization--security)
  - [5. Authentication](#5-authentication-analysis) · [6. Authorization](#6-authorization) · [7. Security Scanner](#7-security-scanner) · [8. Input Validation](#8-input-validation) · [18. Environment & Secrets](#18-environment-analysis)
- [Part IV — Runtime Correctness & Performance](#part-iv--runtime-correctness--performance)
  - [9. Error Handling](#9-error-handling) · [10. Async](#10-async-analysis) · [11. Event Loop](#11-event-loop-analysis) · [12. Performance](#12-performance-analysis) · [13. Memory](#13-memory-analysis)
- [Part V — Data Layer](#part-v--data-layer)
  - [14. Database](#14-database-analysis) · [15. ORM](#15-orm-analysis) · [16. Caching](#16-caching-analysis) · [17. File System](#17-file-system-analysis)
- [Part VI — Dependencies & Supply Chain](#part-vi--dependencies--supply-chain)
  - [19. Dependency Analysis](#19-dependency-analysis)
- [Part VII — Code Quality & Architecture](#part-vii--code-quality--architecture)
  - [20. Code Quality](#20-code-quality) · [33. Architecture](#33-architecture-analysis) · [34. Design Patterns](#34-design-pattern-detection) · [35. Code Metrics](#35-code-metrics)
- [Part VIII — Observability & Testing](#part-viii--observability--testing)
  - [21. Logging](#21-logging-analysis) · [23. Testing](#23-testing-analysis)
- [Part IX — Infrastructure & Deployment](#part-ix--infrastructure--deployment)
  - [24. Docker](#24-docker-analysis) · [25. Kubernetes](#25-kubernetes-analysis) · [26. CI/CD](#26-cicd-analysis) · [27. AWS](#27-aws-analysis) · [28. Serverless](#28-serverless-analysis)
- [Part X — Messaging, Jobs & Realtime](#part-x--messaging-jobs--realtime)
  - [29. Message Queues](#29-message-queue-analysis) · [30. Cron Jobs](#30-cron-job-analysis) · [31. WebSockets](#31-websocket-analysis) · [32. Microservices](#32-microservice-analysis)
- [Part XI — Intelligence & Automation](#part-xi--intelligence--automation)
  - [36. AI Features](#36-ai-features) · [37. Auto Fix](#37-auto-fix)
- [Part XII — Reporting & Dashboards](#part-xii--reporting--dashboards)
  - [38. Visual Dashboard](#38-visual-dashboard) · [39. Reports](#39-reports)
- [Part XIII — Interfaces & Integrations](#part-xiii--interfaces--integrations)
  - [40. CLI](#40-cli) · [41. IDE Integration](#41-ide-integration) · [42. Git Integration](#42-git-integration) · [47. Integrations](#47-integrations)
- [Part XIV — Rule Engine & Extensibility](#part-xiv--rule-engine--extensibility)
  - [45. Rule Engine](#45-rule-engine)
- [Part XV — Teams, Enterprise & DX](#part-xv--teams-enterprise--dx)
  - [43. Team Features](#43-team-features) · [44. Enterprise Features](#44-enterprise-features) · [48. Developer Experience](#48-advanced-developer-experience)
- [Scope philosophy](#scope-philosophy)

---

# Part I — Project Intelligence

## 1. Project Analysis
**Status: Core** (score, framework/package-manager/Node/TypeScript/JavaScript/monorepo/workspace detection implemented; microservice/runtime detection Planned)

Understands what a codebase *is* before analyzing it, so rules activate correctly.

- **Project health score** — a single 0–100 number computed locally from finding density and severity/category weights.
- **Project overview** — file count, lines analyzed, detected capabilities, active rule count.
- **Framework detection** — identifies the HTTP framework(s) in use (see §2).
- **Package manager detection** — npm / pnpm / yarn / bun from lockfiles and config.
- **Node.js version detection** — from `engines`, `.nvmrc`, and toolchain files; drives version-gated rules.
- **TypeScript detection** — from a `tsconfig` or the `typescript` dependency.
- **JavaScript detection** — plain JS vs TS project shape.
- **Monorepo detection** — pnpm/yarn/npm workspaces, Nx, Turborepo, Lerna roots.
- **Workspace detection** — enumerates member packages for per-project scoring.
- **Microservice detection** *(Planned)* — recognizes multi-service repos and service boundaries.
- **Environment detection** *(Planned)* — dev/test/prod config surfaces and `.env` layering.
- **Runtime detection** *(Planned)* — Node vs Bun vs Deno vs edge runtimes.

## 2. Framework Detection
**Status: Core** for Express, Fastify, NestJS, AdonisJS, Koa; **Planned** for the rest.

Capability tokens are derived per framework and gate framework-specific rules.

| Framework | Tier |
| --- | --- |
| Express (4 and 5, version-aware) | Core |
| Fastify | Core |
| NestJS | Core |
| AdonisJS | Core |
| Koa | Core |
| Hapi | Planned |
| Restify | Planned |
| Sails.js | Planned |
| Feathers | Planned |
| LoopBack | Planned |
| Meteor | Planned |
| Next.js API routes / Route Handlers | Planned |
| Remix API / actions & loaders | Planned |
| Serverless Framework | Planned |

## 46. Language Support
**Status: Core** (JS/TS/ESM/CJS/hybrid); type-aware analysis Planned.

- **JavaScript** — `.js`, `.mjs`, `.cjs`.
- **TypeScript** — `.ts`, `.mts`, `.cts` (parsed structurally today; full type-aware rules Planned via a TypeScript type source).
- **ESM** and **CommonJS** — module-system detection and module-appropriate rules.
- **Hybrid projects** — mixed ESM/CJS, and mixed JS/TS trees.

---

# Part II — API, Routes & Documentation

## 3. API Analysis
**Status:** REST partial-**Core** (missing validation, missing error handling, wrong HTTP methods, N+1 via the query rules); rest **Planned**. GraphQL/gRPC **Planned**.

### REST APIs
- Missing validation on request input.
- Missing error handling on handlers.
- Duplicate endpoints (same method + path).
- Route conflicts (overlapping/shadowing patterns).
- Large controllers (size/complexity thresholds).
- Wrong HTTP methods (e.g. state mutation behind GET).
- Missing status codes / inconsistent response codes.
- Invalid REST practices (verbs in paths, non-idempotent GET, etc.).

### GraphQL *(Planned)*
- N+1 detection across resolvers.
- Resolver complexity / depth limits.
- Schema validation and drift.
- Resolver duplication.

### gRPC *(Planned)*
- Proto validation.
- Service definition validation.

## 4. Route Analysis
**Status: Planned** (registration detection is Core; the checks below build on it)

- Unused routes (registered, never reachable/referenced).
- Duplicate routes.
- Missing middleware (auth/validation/body-limit on routes that need it).
- Public sensitive routes (admin/internal exposed without a guard).
- Route conflicts and precedence (wildcard before specific).
- Route hierarchy and mount-tree mapping.
- Route documentation coverage.
- Route complexity (handler size, branching).

## 22. API Documentation
**Status: Planned**

- Missing Swagger / missing OpenAPI spec.
- Endpoint documentation coverage.
- DTO / schema documentation.
- Response documentation.
- Request examples presence.

---

# Part III — Authentication, Authorization & Security

## 5. Authentication Analysis
**Status: Core** for JWT verification/decode misuse and weak-secret fallback; **Planned** for the rest.

- **JWT validation** — `verify` vs `decode` misuse (unsigned claims steering authz).
- **JWT expiration** — missing/!checked `exp`.
- **Missing refresh tokens** — long-lived access tokens with no rotation.
- **Weak JWT secret** — short/hardcoded/fallback signing keys.
- **Session validation** — session fixation / missing invalidation.
- **Cookie security** — `HttpOnly` / `Secure` / `SameSite` flags on auth cookies.
- **OAuth configuration** — redirect/scope/state misconfiguration.
- **Passport configuration** — strategy misconfiguration.
- **Missing authentication** — sensitive routes with no auth on the path.
- **Insecure authentication** — plaintext credentials, weak comparison.
- **API key validation** — missing/weak key checks.

## 6. Authorization
**Status: Planned**

- Missing RBAC (role checks absent on protected actions).
- Missing ABAC (attribute/ownership checks absent).
- Route authorization gaps.
- Admin route exposure.
- Permission validation (client-forgeable authz fields).
- Role conflicts / privilege escalation paths.

## 7. Security Scanner
**Status: Core** for SQL injection, command injection, path/directory traversal, unsafe `eval`/`Function`/`child_process`/shell; **Planned** for the remainder of OWASP coverage.

Deterministic detection of injection and unsafe-primitive sinks, taint-aware where possible.

- **OWASP Top 10** coverage (progressive).
- **SQL Injection** — interpolated/concatenated queries; allows parameterized and tagged-template forms.
- **NoSQL Injection** *(Planned)* — operator/`$where` object injection.
- **Command Injection** — caller input into shell commands.
- **XSS** *(Planned)* — reflected/stored sinks in templating/HTML responses.
- **CSRF** *(Planned)* — state-changing GET, missing CSRF protection.
- **SSRF** *(Planned)* — unvalidated outbound URL from request input; redirect-following.
- **Path Traversal** — filesystem path built from caller input without containment.
- **Prototype Pollution** *(Planned)* — unsafe recursive merge / `__proto__` writes.
- **Directory Traversal** — see path traversal; static-asset and upload paths.
- **Remote Code Execution** — dynamic code execution from untrusted data.
- **Unsafe `eval()`** — dynamic evaluation of input.
- **Unsafe `Function()`** — dynamic function construction from input.
- **Unsafe `child_process`** — `exec`/`spawn` with interpolation.
- **Unsafe shell execution** — shell-invoking calls with metacharacter exposure.

## 8. Input Validation
**Status: Planned** (validator-library awareness); missing-validation detection is Core-adjacent.

- Missing validation on request boundaries.
- **Joi**, **Zod**, **Yup**, **express-validator**, **AdonisJS Validator** schema awareness.
- DTO validation (NestJS/class-validator).
- Sanitization presence.
- Escaping presence.
- File-upload validation (type/size/name).

## 18. Environment Analysis
**Status: Core** for secret-in-env fallback and hardcoded-secret detection; **Planned** for the rest.

- Missing `.env` / required-var validation at boot.
- Secret exposure in code or logs.
- Hardcoded passwords.
- Hardcoded API keys.
- Environment mismatch (dev config in prod).
- Missing config surfaces.

---

# Part IV — Runtime Correctness & Performance

## 9. Error Handling
**Status: Core** for missing try/catch on async handlers, unhandled rejections, missing await, empty catch; **Planned** for consistency/global-handler checks.

- Missing try/catch on error-prone paths.
- Unhandled promise rejection.
- Missing `async`/`await` where a promise is used synchronously.
- Empty catch blocks (silent failure).
- Wrong status code on error responses.
- Sensitive error leaks (stack traces / internals to clients).
- Global error handler presence (framework error middleware).
- Error-response consistency across handlers.

## 10. Async Analysis
**Status: Core** for floating promises (heuristic), missing await, blocking operations, infinite retries, async-array-callback; **Planned** for race/deadlock detection.

- Promise leaks / floating promises (unawaited work).
- Callback hell (deep nesting, mixed callback/promise).
- Missing await.
- Race conditions *(Planned; deepened with the call graph)*.
- Async deadlocks *(Planned)*.
- Infinite retries without backoff.
- Blocking operations on hot paths.

## 11. Event Loop Analysis
**Status: Core** (request-path-aware)

The load-bearing differentiator: the same call is fine at module scope and catastrophic on a request path.

- Blocking synchronous code on the request path.
- Heavy CPU work in a request handler.
- Infinite loops / unbounded loops *(Planned)*.
- Large `JSON.parse` on the request path.
- Regex DoS (ReDoS) from user-controlled patterns.
- Synchronous FS usage (`*Sync`) on the request path.
- Synchronous crypto usage (KDFs, sync hashing) on the request path.

## 12. Performance Analysis
**Status: Core** for N+1 queries, missing pagination, duplicate queries; **Planned** for the payload/memory/hotspot items.

- Slow APIs (blocking patterns, waterfalls).
- Large payloads / large responses.
- Memory leaks *(see §13)*.
- CPU hotspots *(Planned; deepened with runtime data)*.
- Duplicate queries within a request.
- Duplicate outbound API calls.
- Expensive loops (O(n²) over request data).
- N+1 queries.
- Missing pagination (`findMany` without a limit).
- Missing compression.

## 13. Memory Analysis
**Status: Core** for module-scope cache leaks, event-listener leaks, timer leaks; **Planned** for heap/circular/stream analysis.

- Heap leaks *(Planned; strengthened with runtime profiling)*.
- Circular references *(Planned)*.
- Global/module-scope unbounded state.
- Cache leaks (module-scope map with no eviction).
- Event-listener leaks (listeners added per request, never removed).
- Timer leaks (`setInterval` never cleared).
- Stream leaks (unclosed streams, missing error handlers).

---

# Part V — Data Layer

## 14. Database Analysis
**Status:** N+1 / query-in-loop is **Core**; the schema/index/pool checks are **Planned**. Engine detection **Planned**.

### Supported engines *(detection Planned)*
PostgreSQL, MySQL, MariaDB, MongoDB, Redis, DynamoDB, Cassandra, ClickHouse, SQLite.

### Checks
- Missing indexes on filtered/joined columns.
- Slow queries (anti-pattern detection).
- N+1 queries.
- Transactions (multi-write without a transaction).
- Connection pooling (pool/client created per request).
- Duplicate indexes.
- Missing foreign keys.
- ORM misuse (see §15).
- Raw SQL misuse (unparameterized, unsafe raw helpers).

## 15. ORM Analysis
**Status:** receiver-aware query detection is **Core** across ORMs; deep schema/migration checks **Planned**.

### Supported ORMs
Prisma, Sequelize, TypeORM, Mongoose, Knex, MikroORM, Objection.js, Drizzle ORM.

### Checks
- Model validation.
- Migration validation.
- Schema drift (models vs migrations vs DB).
- Unsafe queries (raw/interpolated).
- Missing indexes declared on models.

## 16. Caching Analysis
**Status: Planned**

- Redis usage patterns.
- Missing cache on hot read paths.
- Cache invalidation (mutation without invalidation).
- TTL validation (unbounded / never-expiring entries).
- Cache stampede (no request coalescing).
- Cache penetration (unbounded miss amplification).
- In-memory cache bounds.
- CDN opportunities.

## 17. File System Analysis
**Status: Core** for unsafe file access, sync file operations, directory traversal; **Planned** for upload/temp/large-file handling.

- Unsafe file access (path from input).
- Sync file operations on the request path.
- Upload validation.
- Directory traversal.
- Temp-file cleanup.
- Large-file handling (buffer whole file vs stream).

---

# Part VI — Dependencies & Supply Chain

## 19. Dependency Analysis
**Status:** unused/duplicate/circular detection is **Planned (near-term, via the import graph)**; vulnerability/license/supply-chain scoring is **Planned** (optional network integration, off by default to preserve offline-first).

- Unused packages (declared, never imported).
- Duplicate packages / duplicate versions.
- Circular dependencies (module import cycles).
- Vulnerable packages (advisory feed / Socket.dev-style scoring, opt-in).
- Deprecated packages.
- Large dependencies (bundle/footprint flags).
- License analysis.
- Version conflicts across the workspace.

---

# Part VII — Code Quality & Architecture

## 20. Code Quality
**Status:** dead code, duplicate code, long functions, large files, deep nesting, complexity are **Planned (near-term)**; some overlap with the dead-code scanner (`node-deslop`).

- Dead code (unreachable / unused files, exports, members).
- Duplicate code (copy-paste blocks, duplicate constants/types).
- Long functions.
- God classes.
- Large files.
- Deep nesting.
- Cyclomatic complexity thresholds.
- Code smells (curated set).
- Magic numbers.
- TODO/FIXME detection (optionally tied to issue references).

## 33. Architecture Analysis
**Status: Planned** (built on the project import graph)

- Layer violations (e.g. controller importing a repository directly).
- Dependency graph construction.
- Circular modules.
- Clean Architecture compliance.
- DDD boundary analysis.
- SOLID principle checks.
- Hexagonal Architecture (ports/adapters) conformance.
- Repository pattern conformance.

## 34. Design Pattern Detection
**Status: Vision** (informational pattern recognition)

Singleton, Factory, Repository, Strategy, Observer, Decorator, Builder, Adapter — detection and (where relevant) misuse flags.

## 35. Code Metrics
**Status: Planned** for the numeric metrics; **Vision** for the graph/technical-debt aggregations feeding dashboards.

- Lines of code (LOC).
- Complexity (cyclomatic/cognitive).
- Maintainability Index.
- Technical-debt estimate.
- Duplicate percentage.
- Dependency graph metrics.
- Per-module score.

---

# Part VIII — Observability & Testing

## 21. Logging Analysis
**Status: Planned** (console detection is Core-adjacent)

- Missing logs on critical paths.
- Sensitive logging / PII exposure in logs.
- `console.log` detection in committed code.
- Structured-logging adoption.
- Correlation-ID propagation.
- Log-level hygiene.

## 23. Testing Analysis
**Status: Vision** (coverage requires running the test suite / instrumentation; static test-quality heuristics are Planned)

- Unit coverage.
- Integration coverage.
- E2E coverage.
- Mock quality.
- Snapshot usage hygiene.
- Test duplication.
- Missing edge cases.

---

# Part IX — Infrastructure & Deployment

> Config-file linting (Dockerfiles, K8s manifests, CI YAML, serverless configs) is statically analyzable and **Planned**. Runtime/cloud-account analysis (live AWS resources) is **Vision**.

## 24. Docker Analysis
**Status: Planned** (Dockerfile static analysis)

Dockerfile optimization, multi-stage builds, root-user detection, image size, layer optimization, healthcheck presence, image security scanning.

## 25. Kubernetes Analysis
**Status: Planned** (manifest static analysis)

Missing resource limits, missing requests, health probes, secret handling, ConfigMaps, autoscaling config, ingress validation.

## 26. CI/CD Analysis
**Status: Planned** (pipeline-config static analysis)

### Providers
GitHub Actions, GitLab CI, Jenkins, CircleCI, Azure DevOps.

### Checks
Missing tests step, missing lint step, missing security scan, missing build step, missing deployment validation.

## 27. AWS Analysis
**Status: Vision** (spans IaC static analysis and live-account inspection; large separate surface)

Lambda optimization, ECS, EC2, SQS, SNS, EventBridge, DynamoDB, Aurora, RDS, IAM validation, S3 security, CloudFront, Secrets Manager, Parameter Store.

## 28. Serverless Analysis
**Status: Planned** (config/bundle static analysis) → **Vision** (cold-start runtime data)

Cold starts, bundle size, timeout validation, memory optimization, event-schema validation.

---

# Part X — Messaging, Jobs & Realtime

## 29. Message Queue Analysis
**Status: Planned**

### Supported
RabbitMQ, Kafka, SQS, BullMQ, Redis Queue.

### Checks
Retry strategy, dead-letter queue presence, duplicate processing, idempotency, consumer health.

## 30. Cron Job Analysis
**Status: Planned**

Duplicate jobs, missing locks (no distributed lock on scheduled work), long-running jobs, retry policies, schedule conflicts.

## 31. WebSocket Analysis
**Status: Planned**

Socket leaks, authentication on connect, event/payload validation, room management, connection cleanup.

## 32. Microservice Analysis
**Status: Vision** (cross-service reachability and topology)

Service communication patterns, circuit breaker presence, retry policy, timeout configuration, service discovery, API-gateway compatibility.

---

# Part XI — Intelligence & Automation

## 36. AI Features
**Status: Vision** — an **optional** layer, strictly separated from the deterministic core so scans stay reproducible and offline by default.

- AI bug explanation (plain-English root cause for a finding).
- AI code review (holistic review beyond rules).
- AI optimization suggestions.
- AI security review.
- AI refactoring proposals.
- AI documentation generation.
- AI migration assistance (framework/version upgrades).

> Note: these never gate CI and never feed the health score. The deterministic engine is the product's foundation; AI is an assistive layer on top.

## 37. Auto Fix
**Status: Vision, with a deliberate constraint.**

node.doctor follows React Doctor's model: it is primarily a **detector**, and fixes are applied by the coding agent using the installed skill, because auto-rewriting security and concurrency code demands more certainty than a heuristic tool can guarantee. Within that model:

- **Safe mechanical fixes (Planned):** auto-format, import cleanup, node-protocol import rewrites, trivial lint fixes.
- **Agent-applied fixes (Core thesis):** the skill drives the agent to apply the recommended fix for each finding.
- **Higher-risk categories (Vision, gated):** remove dead code, fix async issues, security fixes, dependency upgrades — offered as suggestions/agent tasks, not silent rewrites.

## Auto-fix items mapped
Auto format · Auto lint fix · Import cleanup · Remove dead code · Fix async issues · Security fixes · Dependency upgrades — each per the constraint above.

---

# Part XII — Reporting & Dashboards

## 38. Visual Dashboard
**Status: Vision** (hosted/web surface)

Health score, dependency graph, API graph, architecture graph, database graph, route map, performance dashboard, security dashboard, technical-debt dashboard.

## 39. Reports
**Status:** JSON is **Core**; SARIF/Markdown are **Planned**; HTML/PDF/CSV/trend reports are **Vision**.

- **JSON report** — full structured output (stable schema). *(Core)*
- **SARIF report** — for code-scanning ingestion. *(Planned)*
- **Markdown report** — human-readable summary. *(Planned)*
- **HTML report** — standalone visual report. *(Vision)*
- **PDF report** — shareable export. *(Vision)*
- **CSV export** — findings for spreadsheets/BI. *(Vision)*
- **Trend reports** — score/finding history over time. *(Vision)*

---

# Part XIII — Interfaces & Integrations

## 40. CLI
**Status: Core** for project scan, diff/incremental scan, rule filtering, JSON output, verbose mode, CI mode; **Planned** for watch mode, HTML output, and the auto-fix command.

- Project scan (full).
- Watch mode *(Planned)*.
- Diff scan (only findings introduced vs a base).
- Incremental scan (changed files / changed lines).
- Rule filtering (by rule, tag, category, framework).
- JSON output.
- HTML output *(Planned)*.
- Verbose mode.
- Auto fix command *(Planned; see §37 constraints)*.
- CI mode (blocking levels, baseline delta, machine output).

## 41. IDE Integration
**Status: Planned** (LSP-first, VS Code first)

- VS Code extension.
- JetBrains plugin *(Vision)*.
- Inline diagnostics.
- Quick fixes (safe, mechanical).
- Hover explanations (rule + recommendation).

## 42. Git Integration
**Status:** PR/commit/diff analysis and pre-commit/pre-push hooks are **Planned**; blame analysis is **Vision**.

- PR scanning (inline comments on introduced findings).
- Commit scanning.
- Diff analysis (baseline delta).
- Blame analysis *(Vision)*.
- Pre-commit hooks (staged-file scan).
- Pre-push hooks.

## 47. Integrations
**Status:** ecosystem interop varies; toolchain awareness is **Planned**, deep third-party platform interop is **Vision**.

| Integration | Tier |
| --- | --- |
| ESLint (adopt config + standalone plugin/adapter) | Planned |
| Prettier (coexistence) | Planned |
| oxlint (shared parser/plugins) | Planned |
| pnpm / Yarn / Bun / npm | Planned |
| Turborepo / Nx | Planned |
| Dependabot (advisory interop) | Planned |
| npm audit (advisory interop) | Planned |
| SonarQube (report/format interop) | Vision |
| Snyk (findings interop) | Vision |
| CodeQL (SARIF interop) | Vision |

---

# Part XIV — Rule Engine & Extensibility

## 45. Rule Engine
**Status:** the core engine (rule contract, severity, gating, suppression, framework-specific rules) is **Core**; a large rule library and custom-rule SDK are **Planned**; the marketplace and org rule packs are **Vision**.

- **Built-in rules** — curated, precision-first. Current target is ~120 high-value rules; a "1000+" library is the long-horizon ambition, not a v1 claim.
- **Custom rule SDK** *(Planned)* — author project/team rules against the same pure rule contract; runs with the same CLI/score/CI surfaces.
- **Rule marketplace** *(Vision)* — share/discover community rule packs.
- **Rule severity** — per-rule `error`/`warn`/`off`. *(Core)*
- **Rule suppression** — inline (with mandatory reason) and config-level. *(Planned; config gating is Core)*
- **Organization-wide rule packs** *(Vision)*.
- **Framework-specific rules** — gated by capability tokens. *(Core)*

---

# Part XV — Teams, Enterprise & DX

## 43. Team Features
**Status: Vision** (requires a hosted back-end)

Team dashboard, project comparison, quality trends, developer insights, technical-debt tracking, team scoring.

## 44. Enterprise Features
**Status: Vision** (requires a hosted/enterprise back-end)

Multi-repository scanning, organization dashboard, policy enforcement, custom rules at org scope, compliance reporting, SSO, RBAC, audit logs.

## 48. Advanced Developer Experience
**Status:** interactive CLI, rule explanations, code-snippet fixes, and migration guides are **Planned**; the dashboard/CodeLens/history items are **Vision**.

- Interactive CLI (guided setup, `install`, `why`/`explain`).
- Interactive HTML dashboard *(Vision)*.
- Live watch mode *(Planned)*.
- VS Code CodeLens *(Vision)*.
- One-click fixes (safe subset) *(Planned)*.
- Rule explanations (`why <file>:<line>`, `rules explain <id>`) *(Planned)*.
- Code snippets for fixes (each finding ships a concrete recommendation) *(Core)*.
- Migration guides (framework/version upgrades) *(Planned)*.
- Framework upgrade assistant *(Vision)*.
- Health history over time *(Vision)*.

---

## Scope philosophy

Built to its fullest, node.doctor would combine, in one Node-focused platform: a curated linter (ESLint), a code-quality gate (SonarQube), dependency and supply-chain security (Snyk / npm audit), dead-code and dependency-graph analysis (Dependency Cruiser / Madge), runtime performance insight (Clinic.js), API-contract validation (OpenAPI validators), an architecture linter, and an AI-assisted reviewer — spanning not just code quality, but backend architecture, APIs, security, performance, infrastructure, and operations.

That is the destination. The path there is deliberately staged:

1. **Win the core first.** A fast, deterministic, offline analyzer with a curated, precision-first ruleset, a local health score, an agent skill, and CI baseline-delta. This is where the product earns trust — and where a false positive, not a missing feature, is the real risk.
2. **Deepen with the import graph.** Cross-file reachability unlocks the architecture, dead-code, dependency, and request-path-through-helpers analyses that a per-file linter cannot do.
3. **Extend into infrastructure and operations** via static config analysis (Docker, K8s, CI, serverless configs).
4. **Layer intelligence and platform** last — the AI assist, dashboards, trends, and team/enterprise surfaces — on top of a core that is already reliable, reproducible, and offline.

Everything in this catalog is real intent. The maturity tiers keep it honest about sequence, so the product is credible at every step rather than impressive only on paper.