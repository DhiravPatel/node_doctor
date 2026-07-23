# node.doctor — Features

The complete capability catalog for **node.doctor**: a deterministic static-analysis platform for Node.js backends, built on the thesis that coding agents write bad server code — code that compiles, passes tests, and fails under real load — and that a fast, curated, offline analyzer plus an agent skill can catch it and prevent it at the source.

This document is the **north-star feature catalog**. It describes the product in full. Because the scope is large, every domain carries a **maturity tier** so it is clear what exists today versus what is committed roadmap versus long-term platform ambition.

The catalog spans **104 domains** across two halves: **Parts I–XV** (§1–§48) are the analysis and platform base; **Parts XVI–XXV** (§49–§104) extend it into agent-native workflow, deep semantic analysis, runtime correlation, compliance, API lifecycle, and governance.

> **The moat vs. the breadth.** The genuine, defensible differentiator is **[Part XVI — Agent-Native & AI Coding Workflow](#part-xvi--agent-native--ai-coding-workflow)** sitting on top of a precision-first core — that is the thesis, and the thing competitors do not have. Most other domains are either table-stakes or things existing tools (SonarQube, Snyk, Clinic.js, Dependency-Cruiser) already do. The highest-leverage items are tagged **★ Differentiator**: build those first and treat the rest as a menu, not a mandate. A tool that does 104 things adequately loses to one that does 20 exceptionally.

---

## Maturity legend

| Tier | Meaning |
| --- | --- |
| **Core** | Implemented in the current engine. Where a domain is only partly built, the specific implemented checks are called out. |
| **Detected** | The engine recognizes the technology and sets its capability token — which gates rule selection, route extraction and the `detected:` line — but no diagnostics specific to it exist yet. Shared diagnostics still apply. |
| **Planned** | Committed roadmap. Deterministic static analysis that fits the existing engine and the build plan; realistic to ship incrementally. |
| **Vision** | Longer-term platform scope. Requires additional infrastructure (runtime instrumentation, hosted services, an AI layer, or enterprise back-end) beyond the static-analysis core. |
| **★ Differentiator** | Not a tier — a marker on the domains where node.doctor is *unlike* the incumbents, rather than merely at parity. |

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

**Extended catalog (§49–§104)**

- [Part XVI — Agent-Native & AI Coding Workflow](#part-xvi--agent-native--ai-coding-workflow) — §49–§55 ★
- [Part XVII — Deep Semantic Analysis](#part-xvii--deep-semantic-analysis) — §56–§61
- [Part XVIII — Runtime & Dynamic Analysis](#part-xviii--runtime--dynamic-analysis) — §62–§66
- [Part XIX — Security & Compliance Depth](#part-xix--security--compliance-depth) — §67–§72
- [Part XX — Data & Privacy](#part-xx--data--privacy) — §73–§76
- [Part XXI — API Lifecycle](#part-xxi--api-lifecycle) — §77–§81
- [Part XXII — Migration & Modernization](#part-xxii--migration--modernization) — §82–§86
- [Part XXIII — Workflow, Governance & Collaboration](#part-xxiii--workflow-governance--collaboration) — §87–§93
- [Part XXIV — Ecosystem & Runtime Breadth](#part-xxiv--ecosystem--runtime-breadth) — §94–§98
- [Part XXV — Novel & Differentiating](#part-xxv--novel--differentiating) — §99–§104
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
- **Runtime detection** — Node vs Bun vs Deno vs edge runtimes (`bun.lockb`/`bunfig.toml`, `deno.json(c)`, `wrangler.toml`, `@vercel/edge`), surfaced as capability tokens that gate runtime-specific diagnostics.

## 2. Framework Detection
**Status: Core** for Express, Fastify, NestJS, AdonisJS, Koa (detection + dedicated diagnostics). The rest are **Detected** — the capability token is set and gates rule selection and route extraction, but no framework-specific diagnostics exist for them yet.

Capability tokens are derived per framework and gate framework-specific rules.

| Framework | Tier |
| --- | --- |
| Express (4 and 5, version-aware) | Core |
| Fastify | Core |
| NestJS | Core |
| AdonisJS | Core |
| Koa | Core |
| Hapi | Detected |
| Restify | Detected |
| Sails.js | Detected |
| Feathers | Detected |
| LoopBack | Detected |
| Meteor | Planned |
| Next.js API routes / Route Handlers | Detected |
| Remix API / actions & loaders | Detected |
| Serverless Framework | Detected |

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
**Status: Core (partial)** — route registration + `node-doctor surface` mapping are Core; `no-duplicate-route-definition` (opt-in) and `no-shadowed-route` (a static route made unreachable by an earlier parameter route on the same Express router, order-based-matching only) ship today. The rest below build on registration detection.

- Unused routes (registered, never reachable/referenced) *(Planned)*.
- Duplicate routes — `no-duplicate-route-definition` (opt-in). **Core**.
- Route shadowing / precedence — `no-shadowed-route` (a parameter route swallowing a later static route). **Core**.
- Missing middleware (auth/validation/body-limit on routes that need it).
- Public sensitive routes (admin/internal exposed without a guard).
- Route conflicts and precedence (wildcard before specific) — partially covered by `no-shadowed-route`.
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
- **NoSQL Injection** — operator/`$where` object injection (`no-nosql-object-injection`).
- **Command Injection** — caller input into shell commands.
- **XSS** *(Planned)* — reflected/stored sinks in templating/HTML responses.
- **CSRF** *(Planned)* — state-changing GET, missing CSRF protection.
- **SSRF** — unvalidated outbound URL from request input (`no-ssrf-unvalidated-url`).
- **Path Traversal** — filesystem path built from caller input without containment.
- **Prototype Pollution** — caller-controlled computed key writes and literal `__proto__`/`constructor` writes (`no-prototype-pollution`).
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
- Circular imports — runtime import cycles, anchored at the import that closes the cycle (`no-circular-imports`); type-only imports are excluded because they are erased.
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
**Status:** unused/duplicate/circular detection is **Core** (via the import graph and `deslop`); vulnerability/license/supply-chain scoring is **Planned** (optional network integration, off by default to preserve offline-first).

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
**Status:** dead code, long functions, deep nesting and complexity are **Core** (the size/complexity checks are opt-in by default); duplicate-code detection is **Planned (near-term)**; some overlap with the dead-code scanner (`node-deslop`).

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

> Config-file linting (Dockerfiles, K8s manifests, CI YAML, serverless configs) is statically analyzable and in progress — Terraform/CloudFormation security checks ship today (`no-open-security-group`, `no-overbroad-iam-policy`, `no-public-cloud-storage`) via the whole-tree text scan. **Planned**. Runtime/cloud-account analysis (live AWS resources) is **Vision**.

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

# Part XVI — Agent-Native & AI Coding Workflow

*The core reason node.doctor exists is that agents write the code. These features make it the analyzer agents actually run and obey. This is the moat.*

## 49. MCP Server ★ Differentiator
**Status: Core** — the stdio MCP server ships (`node-doctor mcp`) exposing `node_doctor_scan`, `node_doctor_diagnostics`, `node_doctor_explain`, and `node_doctor_deslop`. `scan_diff` and `check_snippet` are **Planned**.

node.doctor runs as a **Model Context Protocol server**, so any MCP-capable agent (Claude, Cursor, Windsurf, Cline, custom) can call it as a first-class tool mid-task.

- Returns structured, token-efficient findings the model can act on directly.
- Lets the agent *self-correct in the loop* rather than being told after the fact.
- Read-only and capability-scoped; no shell/exec exposure.
- **`check_snippet`** *(Planned)* — lint a code fragment **before** the agent writes it to disk (the highest-leverage remaining piece).
- **`scan_diff`** *(Planned)* — baseline-delta as a tool call.

## 50. Agent Skill & Rules Distribution ★ Differentiator
**Status: Core** for client install + native hooks; **Planned** for the conventions generator.

- **One-command install** of the skill into Claude Code, Cursor, Windsurf, Codex, Cline, and GitHub Copilot (extensible client→path map), defaulting to the clients actually detected on the machine. *(Core)*
- **Two bundled skills** — the main `node-doctor` skill, and `improve-node`, a read-only audit-then-plan advisor. *(Core)*
- **Native post-edit hooks** for Claude Code and Cursor, so a scan runs automatically as the agent edits. *(Core)*
- Thin, locally-bundled skill — no runtime remote fetch (offline-first). *(Core)*
- **Conventions generator** *(Planned)* — emit a `CLAUDE.md` / `.cursorrules` / `AGENTS.md` from the project's *own* patterns (detected frameworks, ORM, auth model, naming) so the agent writes correct code the first time, not corrected code afterward.
- Aider and other clients *(Planned)*.

## 51. Agent Fix Loop & Handoff ★ Differentiator
**Status: Core** for prompt generation, session review, and batching; **Planned** for the enforced verification loop.

Turns a scan into an executable remediation plan for an agent.

- **Handoff prompt generation** (`node-doctor fix`) — one structured prompt with every finding, its exact location, and its concrete fix, ranked by severity and category weight and sized to a context window. *(Core)*
- **Fix batching** — findings grouped by diagnostic and root cause so the agent edits efficiently rather than per-site. *(Core)*
- **Session review** — `--diff` / `--staged` / `--scope lines` scan only what changed and hand back just the regressions introduced. *(Core)*
- **Agent auto-launch** — detects installed agent CLIs and hands off directly. *(Core)*
- **Verification loop** *(Planned)* — today the prompt *instructs* the agent to re-scan and confirm; making it an enforced, machine-checked pass/fail gate is the remaining work.

## 52. Node Bench ★ Differentiator
**Status: Vision**

The Node equivalent of React Bench: a public benchmark measuring **which models write the best Node.js backend code**, scored by node.doctor on a fixed suite of realistic tasks (build an API, add auth, write a queue consumer). Drives adoption, gives the project a data moat, and creates a feedback loop that improves the ruleset.

## 53. Real-Time In-Editor Guardrails
**Status: Planned** (rides on the LSP — see §41)

- As the agent (or human) writes, surface findings inline with zero config.
- "Would-block-CI" indicator on the exact line before commit.
- Debounced incremental analysis of the open buffer only.

## 54. Machine-Optimized Output & Confidence ★ Differentiator
**Status: Core** for token-efficient output; **Planned** for confidence and fix-as-diff.

- **Token-efficient JSON** (`--json-compact`) with deterministic key order, tuned for LLM consumption. *(Core)*
- **Per-finding confidence score** *(Planned)* — how certain the analyzer is, so an agent can auto-fix high-confidence findings and escalate low-confidence ones to a human.
- **Fix-as-diff** *(Planned)* — emit the recommended change as a unified diff the agent can apply directly, where the fix is mechanical and safe.

## 55. Learning & Feedback Loop
**Status: Vision**

- Track which findings get accepted vs. dismissed (with reasons) and feed that into rule tuning.
- Per-repo suppression memory so the same false positive isn't re-surfaced.
- Aggregate (opt-in, anonymized) signal to improve rule precision across the ecosystem.

---

# Part XVII — Deep Semantic Analysis

*The real version of what the current heuristic engine gestures at — the analysis depth that separates a linter from a program analyzer.*

## 56. Interprocedural Taint & Dataflow ★ Differentiator
**Status: Planned** — the foundation (cross-file call graph + reachability from request handlers) is **Core**; sound source→sink taint across that graph is the remaining work.

Full source→sink tracking **across files and function boundaries**: request input flowing through helpers, services, and utilities into an injection sink, a log, a response, or a client bundle. This is the sound version of today's intra-file taint, and it is what makes the security and privacy rules trustworthy rather than heuristic.

## 57. Type-Aware Analysis
**Status: Planned** (opt-in `--typed`, via a TypeScript type source)

- **Floating-promise detection via types** (`Promise<T>` return, not just the `async` keyword).
- Nullability / undefined-access analysis.
- Exhaustiveness checks on unions and switch statements.
- Type-driven DB-client and framework identification (removes receiver-name heuristics).

## 58. Control-Flow & Reachability
**Status: Planned**

- Unreachable code and dead branches.
- Always-true / always-false conditions.
- Missing returns on some paths.
- Guaranteed-throw paths and error propagation gaps.

## 59. Cross-Request State Analysis ★ Differentiator
**Status: Planned** — module-scope unbounded state detection is **Core**; the concurrency/race dimension is the remaining work.

A signature Node footgun: module-scope mutable state (`let`/`var`, shared objects) that leaks or races **across concurrent requests**. Detects shared mutable state written on the request path — the cause of subtle data-bleed-between-users bugs that no per-file linter catches.

## 60. CVE Reachability Analysis ★ Differentiator
**Status: Planned**

When a dependency has a known CVE, determine whether the **vulnerable function is actually called** from your code (directly or transitively). Collapses the "1,400 advisories, 3 that matter" noise problem that makes `npm audit` unusable, and prioritizes the reachable ones.

## 61. Invariant & Contract Checking
**Status: Vision**

- User-declared pre/post-conditions on functions and route handlers.
- Assertion-density and defensive-check analysis.
- Idempotency-contract verification for handlers that must be idempotent.

---

# Part XVIII — Runtime & Dynamic Analysis

*Bridging static findings with runtime truth — the Clinic.js layer that confirms and prioritizes what static analysis suspects. Every domain here needs instrumentation beyond the offline core, so all are Vision.*

## 62. Runtime Profiling Correlation
**Status: Vision**

Optional integration that runs the app/tests under a profiler and **confirms static findings with real numbers**: prove the N+1 actually fires, measure event-loop lag from a suspected blocking call, quantify a hotspot. Static flags the suspects; runtime confirms the guilty.

## 63. Production Telemetry Correlation ★ Differentiator
**Status: Vision**

Ingest OpenTelemetry traces / APM data and **map slow or error-prone spans back to the exact code**, then attach the relevant static finding and fix. Turns "this endpoint is slow in prod" into "this line is the N+1, here's the fix."

## 64. Load-Test-Informed Prioritization
**Status: Vision**

Feed k6 / Artillery / autocannon results back in to rank findings by the endpoints that actually break under load, so remediation effort goes where traffic hurts.

## 65. Memory-Snapshot Leak Confirmation
**Status: Vision**

Diff heap snapshots across a workload to confirm suspected leaks (the timer/listener/cache-growth findings) with evidence rather than heuristics.

## 66. Traffic-Weighted Reachability
**Status: Vision**

Use production route-hit data to weight findings: a critical issue on a hot path outranks the same issue on a never-called admin route.

---

# Part XIX — Security & Compliance Depth

## 67. SBOM Generation
**Status: Planned**

Emit a Software Bill of Materials in **CycloneDX** and **SPDX** formats for the full dependency tree — increasingly a procurement and compliance requirement.

## 68. Advanced Secret Scanning
**Status: Core** for provider-signature matching and committed-secret scanning; **Planned** for git-history scanning and pre-commit blocking.

- **Known-provider signature matching** (Stripe, AWS, GitHub, Google, Slack, GitLab) plus entropy/shape heuristics with placeholder and env-reference guards. *(Core)*
- **Whole-tree scan** of non-source files — `.env*`, `*.pem`/`*.key`, YAML/CI configs, Dockerfiles, `*.tfvars`, JSON — with per-bucket size caps. *(Core)*
- **Committed-files-only gate** — leaked key material is only flagged in git-tracked files, so a gitignored local `.env` is never a false positive. *(Core)*
- **Git-history scanning** *(Planned)* — secrets committed and later "removed" are still in history and must be rotated.
- **Pre-commit secret blocking** *(Planned)* — the pre-commit hook ships and is advisory today; making secrets a hard block is the remaining step.

## 69. Malicious & Risky Dependency Detection
**Status: Planned → Vision**

- Typosquatting / dependency-confusion detection.
- Install-script and lifecycle-hook risk analysis.
- Obfuscation / suspicious-behavior heuristics.
- Newly-published / low-maturity package flags (release-age policy).

## 70. Attack-Surface & Authorization Mapping ★ Differentiator
**Status: Planned**

- **Attack-surface map** — enumerate every externally reachable entry point (routes, webhooks, queue consumers, GraphQL fields) with its auth posture.
- **Authorization matrix** — auto-generate a route → required-permission table and flag inconsistencies and gaps. Enormously useful for security review and impossible to maintain by hand.

## 71. Compliance Packs
**Status: Vision**

Curated rule bundles mapped to **SOC 2, PCI-DSS, HIPAA, GDPR, ISO 27001** controls, with per-control pass/fail and evidence export for auditors.

## 72. IaC & Cloud-Config Security
**Status: Planned** (static config analysis)

Extend infra analysis (Docker/K8s already cataloged in Part IX) with Terraform/Pulumi/CloudFormation static checks: public buckets, over-broad IAM, unencrypted resources, open security groups.

---

# Part XX — Data & Privacy

## 73. PII / PHI Flow Tracking ★ Differentiator
**Status: Vision** (built on interprocedural dataflow, §56)

Track where personal/health data **enters** the system and where it **goes** — flag it reaching logs, third parties, client bundles, or unencrypted storage. A genuine gap in the market and a compliance goldmine.

## 74. Data-Residency & Retention Checks
**Status: Vision**

- Cross-region data-movement flags.
- Retention-policy presence on stored personal data.
- Right-to-erasure implementation checks.

## 75. Encryption Posture
**Status: Core** for weak-cipher, weak password hashing, and disabled TLS verification; **Planned** for at-rest and key management.

- **Encryption-in-transit** — disabled TLS verification (`rejectUnauthorized: false`) detection. *(Core)*
- **Weak-cipher / weak-hash detection** — deprecated ciphers and MD5/SHA-1 for password storage. *(Core)*
- **Encryption at rest** *(Planned)*.
- **Key-management anti-patterns** *(Planned)*.

## 76. Consent & Tracking Hygiene
**Status: Vision**

Flag analytics/tracking calls that fire before consent, and PII sent to analytics.

---

# Part XXI — API Lifecycle

## 77. OpenAPI Generation From Code ★ Differentiator
**Status: Planned**

Generate an OpenAPI/Swagger spec **from the actual routes, DTOs, and validators** — the inverse of the "missing spec" detection in §22. Keeps docs honest because they're derived, not hand-written.

## 78. API Breaking-Change Detection ★ Differentiator
**Status: Planned**

Diff the API surface between two revisions and flag **breaking changes** (removed endpoints, changed shapes, tightened validation) — semver for your API, enforceable in CI. High value, low competition, and it reuses the baseline-delta machinery that already ships.

## 79. Contract Testing & Drift
**Status: Vision**

Detect drift between a declared spec and the implementation; optionally verify against consumer contracts (Pact-style).

## 80. Client SDK Generation
**Status: Vision**

Emit typed client SDKs from the derived spec.

## 81. GraphQL & RPC Lifecycle
**Status: Planned**

Schema linting, persisted-query enforcement, deprecation tracking, and resolver-cost limits for GraphQL; proto-compatibility checks for gRPC.

---

# Part XXII — Migration & Modernization

## 82. Framework & Runtime Migration Assistants
**Status: Vision** (deterministic codemods + agent-assisted)

Guided, codemod-backed migrations: Express→Fastify, callback→async, CJS→ESM, JS→TS, legacy→modern ORM. Especially valuable for teams modernizing legacy backends.

## 83. Node Version Upgrade Checker
**Status: Planned**

Flag APIs deprecated or removed across Node major versions, and surface new-version opportunities (native `fetch`, `AbortSignal.timeout`, the built-in test runner). The version-gating machinery this needs is already **Core** (§1).

## 84. Dependency Major-Upgrade Codemods
**Status: Vision**

Apply known migration codemods for major-version bumps of common libraries.

## 85. Modernization Score
**Status: Planned**

A dedicated score for "how far from current best practices" (deprecated APIs, legacy patterns, outdated deps), tracked over time to show modernization progress.

## 86. Golden-Path Scaffolding
**Status: Vision**

Generate new routes/services/consumers from templates that are **pre-verified clean** by node.doctor's own diagnostics — correct-by-construction scaffolding.

---

# Part XXIII — Workflow, Governance & Collaboration

## 87. Baseline / Ratchet & Quality Gates
**Status: Core** for baseline delta and CI gating; **Planned** for the ratchet.

- **Baseline delta** — scan base and head, report only what the change *introduced*. *(Core)*
- **Evidence-based identity** — findings are matched on the diagnostic + message + the code that triggered them, so moving a function or shifting lines does **not** resurface it as "new". *(Core)*
- **Blocking levels** — `error` / `warning` / `none` exit policy for CI. *(Core)*
- **Ratchet** *(Planned)* — lock current debt as a committed baseline and let the threshold only improve, preventing backsliding without demanding a big-bang cleanup.

## 88. Triage Workflow
**Status: Vision** (persisted state)

Accept / dismiss / snooze findings with a required reason, persisted across scans, with an audit trail — so the same debate isn't re-litigated every run.

## 89. Ownership-Aware Routing
**Status: Planned**

Use CODEOWNERS / directory ownership to route each finding to the responsible team and scope PR comments accordingly.

## 90. PR Risk Scoring & Effort Estimates
**Status: Planned** — PR summary comments and inline review comments already ship (§42); the scoring layer is the remaining work.

- A **risk score** per pull request (how dangerous is this change), from touched surface + finding severity.
- Time-to-fix estimates per finding to help planning.

## 91. Notifications & Ticketing
**Status: Vision**

Slack / Teams / Discord notifications; one-click issue creation in Jira / Linear / GitHub Issues from a finding.

## 92. Rule-Effectiveness Analytics & Auto-Tuning
**Status: Vision**

Dashboards on which diagnostics fire, which get dismissed, and false-positive rates — feeding automatic severity/enablement tuning per team.

## 93. Policy-as-Code Governance
**Status: Vision** (enterprise)

Org-level policies (required diagnostics, minimum score, blocked licenses) enforced across all repos, versioned and reviewable.

---

# Part XXIV — Ecosystem & Runtime Breadth

## 94. Bun & Deno First-Class Support
**Status: Planned** — package-manager detection (including Bun) is **Core**; runtime-specific diagnostics are not.

Runtime-specific detection and rules for Bun (`Bun.serve`, `bun:sqlite`) and Deno (permissions, `Deno.serve`, std imports), not just Node.

## 95. Edge Runtime Analysis
**Status: Planned**

Cloudflare Workers / Vercel Edge / Deno Deploy constraints: no Node built-ins, size limits, no long-lived state, streaming requirements.

## 96. Cross-Package Monorepo Analysis ★ Differentiator
**Status: Core** for workspace discovery and per-project scoring; **Planned** for analysis *across* package boundaries.

- **Workspace discovery** (npm/yarn/bun `workspaces`, `pnpm-workspace.yaml`), per-project scoring, worst-of aggregation, `--project` selection, and additive root→member config merge. *(Core)*
- **Cross-package graph** *(Planned)* — the import graph is per-project today; extending it across packages unlocks: a handler in `apps/api` calling a helper in `packages/db` that blocks the event loop, internal-package boundary and layering violations, and unused internal exports across packages.

## 97. WASM & Native Boundary Checks
**Status: Vision**

Flag risky patterns at WASM/native-addon boundaries (blocking calls, memory handling).

## 98. Air-Gapped & Self-Hosted Deployment
**Status: Core** for offline operation; **Vision** for the self-hosted mirror.

- **Fully offline** — the analysis core makes **no network calls** and sends no telemetry; it already runs air-gapped today. *(Core)*
- **Self-hosted advisory/SBOM mirror** *(Vision)* — required once the optional advisory/supply-chain integrations (§19, §67, §69) exist, for regulated environments.

---

# Part XXV — Novel & Differentiating

## 99. Codebase Q&A Over the Analysis Graph ★ Differentiator
**Status: Vision**

Natural-language questions answered from the built graph + findings: "which endpoints touch the payments table without auth?", "where does user email flow?", "what's our slowest handler and why?". The analysis graph becomes a queryable knowledge base — a capability no linter has.

## 100. Auto-Generated Regression Tests
**Status: Vision**

For each fixed finding, generate a test that fails on the anti-pattern and passes on the fix, so the class of bug can't silently return.

## 101. Confidence & Explainability Everywhere
**Status: Core** for explainability; **Planned** for confidence.

- **Plain-language explanation** — every finding ships a concrete message, a named-mechanism fix, and `node-doctor explain <id> | <file>:<line>` for the "why here". Source code frames and a prefilled false-positive issue URL are included. *(Core)*
- **Confidence level per finding** *(Planned)* — powering agent auto-fix decisions (see §54) and human trust.

## 102. Ecosystem Percentile Benchmarking
**Status: Vision**

Show how a codebase's health score ranks against anonymized ecosystem percentiles ("healthier than 78% of scanned Node services"), and track the trend.

## 103. Fix Impact Simulation
**Status: Vision**

Estimate the payoff of fixing a finding (latency saved, attack surface closed, memory reclaimed) so teams fix what matters most first.

## 104. Deterministic Replay & Provenance
**Status: Core** for determinism; **Planned** for the provenance record.

- **Byte-identical, reproducible scans** — stable finding ids, deterministic sort order, and a content-hash cache probe keyed on the diagnostic set + config + capabilities. *(Core)*
- **Provenance record** *(Planned)* — stamp each report with tool version + rule-set hash + config hash so "why did this pass yesterday and fail today" is answerable from the artifact alone. Critical for CI trust and audits.

---

## Scope philosophy

Built to its fullest, node.doctor would combine, in one Node-focused platform: a curated linter (ESLint), a code-quality gate (SonarQube), dependency and supply-chain security (Snyk / npm audit), dead-code and dependency-graph analysis (Dependency Cruiser / Madge), runtime performance insight (Clinic.js), API-contract validation (OpenAPI validators), an architecture linter, and an AI-assisted reviewer — spanning not just code quality, but backend architecture, APIs, security, performance, infrastructure, and operations.

That is the destination. The path there is deliberately staged:

1. **Win the core first.** A fast, deterministic, offline analyzer with a curated, precision-first ruleset, a local health score, an agent skill, and CI baseline-delta. This is where the product earns trust — and where a false positive, not a missing feature, is the real risk.
2. **Deepen with the import graph.** Cross-file reachability unlocks the architecture, dead-code, dependency, and request-path-through-helpers analyses that a per-file linter cannot do.
3. **Own the agent loop** ([Part XVI](#part-xvi--agent-native--ai-coding-workflow)). The MCP server, skill distribution, and fix handoff are what make node.doctor the analyzer agents *run and obey* — the one thing the incumbents don't have.
4. **Earn the depth the agent loop depends on** ([Part XVII](#part-xvii--deep-semantic-analysis)) — especially §56 interprocedural taint and §59 cross-request state. An agent acting on a heuristic finding is worse than no finding; trust is the prerequisite for automation.
5. **Extend into infrastructure and operations** via static config analysis (Docker, K8s, CI, serverless, IaC).
6. **Layer intelligence and platform** last — runtime correlation, AI assist, dashboards, trends, and team/enterprise surfaces — on top of a core that is already reliable, reproducible, and offline.

**The trap to avoid.** Every domain here is real and valuable, but a tool that does 104 things adequately loses to one that does 20 exceptionally. Precision and the agent loop are the product; the **★ Differentiator** items are where node.doctor is *unlike* everything else, and the rest is where it merely *matches* the incumbents. Treat this as a roadmap you pull from, not a checklist you must clear.

**Consistency across the catalog.** Nothing in the extended domains weakens the invariants — the deterministic offline core, the locally computed score, precision-first, and AI-as-optional-layer hold across all 104.

Everything in this catalog is real intent. The maturity tiers keep it honest about sequence, so the product is credible at every step rather than impressive only on paper.
---

# node.doctor — Features (Next / Out-of-the-Box)

A third extension, covering **net-new, differentiated** capabilities beyond the existing 104 domains — feature classes that essentially **no linter or SAST tool ships today**. Same maturity legend (**Core** / **Detected** / **Planned** / **Vision**) and the same invariants (deterministic + offline core, local score, precision-first, AI-as-optional-layer).

> **Why these are here.** The base catalog reaches parity-plus-moat with the incumbents. This set is about *category creation*: bug classes specific to Node backends and to the agent era that the market has not addressed. Almost everything below is **Planned** or **Vision** by definition — it is new ground. The strongest, most on-thesis bets are tagged **★ Differentiator**; the four flagged **★★ Flagship** are where node.doctor could define a category rather than compete in one.

**New parts:** XXVI Building-AI-Features Security (§105–§109) · XXVII AI-Native Code Governance (§110–§113) · XXVIII Domain Correctness Packs (§114–§119) · XXIX Impact, Proof & Reasoning (§120–§123) · XXX Consistency, Drift & Fleet (§124–§128) · XXXI Knowledge & Targeting (§129–§130).

---

# Part XXVI — Building-AI-Features Security

*Node/TypeScript is where most LLM apps, RAG pipelines, and MCP servers are actually built. The code that builds AI features has its own, largely unaddressed, vulnerability class.* An `ai` capability token is set from an LLM SDK dependency (openai, `@anthropic-ai/sdk`, the Vercel `ai` SDK, LangChain, …) and an `mcp` token from `@modelcontextprotocol/sdk`; the whole pack is silent on projects that never call a model.

## 105. Prompt-Injection Sink Detection ★★ Flagship
**Status: Core** — `no-prompt-injection`. Caller-controlled input mixed into a `system` prompt or concatenated into prompt text is flagged, built on the same interprocedural-taint engine as SQL injection (§56). The isolated `messages: [{ role: "user", content: req.body.q }]` pattern — the correct shape — is deliberately silent.

## 106. Agent Tool & Capability Exposure ★ Differentiator
**Status: Core** — `mcp-tool-unrestricted-capability` (`requires: mcp`). An MCP tool handler that runs a high-blast-radius operation (shell, filesystem write, raw SQL, `eval`) on model-controlled arguments.

## 107. LLM Output-Trust Violations ★ Differentiator
**Status: Core** — `no-llm-output-in-sink`. Model output reaching an executor, a SQL string, an HTML response, or an outbound fetch without validation — the mirror of §105, where the model is the untrusted source.

## 108. System-Prompt & Secret Leakage
**Status: Core** — `no-system-prompt-leak`. A system-prompt binding echoed back to the caller, logged, or reflected in an error.

## 109. AI Cost & Runaway-Loop Guards
**Status: Core** — `ai-call-in-loop`. An LLM call inside a loop: a latency, cost, and rate-limit blowup. (Unbounded-agent-loop and missing-token-limit checks remain **Planned**.)

---

# Part XXVII — AI-Native Code Governance

*If agents write the code, the codebase needs governance built for that fact.* Deliberately **not shipped** in the current engine: every item here needs infrastructure the deterministic-offline core does not have — git-metadata attribution, the original ticket/PRD, an AI rule-generation layer, or a signing/audit chain. Flagged honestly rather than faked.

## 110. AI-Authored-Code Trust Boundary ★★ Flagship
**Status: Vision** (git metadata + agent-hook attribution).

## 111. Spec / Intent Conformance ★★ Flagship
**Status: Vision** (needs the task spec + an optional AI layer).

## 112. Incident-to-Rule Guardrails ★★ Flagship
**Status: Vision** (AI-assisted custom-rule generation from a postmortem).

## 113. Agent-Change Attestation
**Status: Vision** (extends provenance, §104, into a signed audit trail).

---

# Part XXVIII — Domain Correctness Packs

*Opt-in bundles for correctness classes invisible to generic linters.*

## 114. Multi-Tenancy Isolation ★ Differentiator
**Status: Planned** — precise only with per-model tenant-scope knowledge; a same-file heuristic is too noisy to ship default-on.

## 115. Money & Numeric Safety ★ Differentiator
**Status: Planned** — **held back on precision:** statically proving a value is monetary is unreliable, and the doc's own rule applies (a false positive here is worse than not shipping).

## 116. Time & Timezone Correctness ★ Differentiator
**Status: Planned** — same precision problem: naive `Date` is not distinguishable from timezone-sensitive `Date` without dataflow this engine lacks.

## 117. Idempotency & Retry Safety ★ Differentiator
**Status: Planned** — needs cross-handler reasoning about dedup keys.

## 118. Deploy & Migration Safety ★ Differentiator
**Status: Core (partial)** — `migration-add-not-null-without-default`, `migration-destructive-without-guard`, and `migration-missing-index-on-foreign-key` (§14/§15) cover the SQL-migration cases. The rolling-deploy column-still-read case remains **Planned** (needs the previous version's reads).

## 119. Distributed-Systems Correctness
**Status: Vision** (cross-service reachability).

---

# Part XXIX — Impact, Proof & Reasoning

## 120. Blast-Radius & Change-Impact Graph ★ Differentiator
**Status: Core** — `node-doctor impact <files> | --diff`. Walks the import graph backward from the changed files to every transitive dependent, marks the route-bearing ones, and reports the blast radius (human + `--json`). Deterministic reachability, cross-package in a workspace.

## 121. Exploitability Proof & Attack-Path Visualization ★ Differentiator
**Status: Core** — `node-doctor paths`. For every injection sink fed by request data, renders the exact source→sink chain the taint engine resolved — request handler → each helper hop → the `eval`/shell/SQL sink — with `file:line` at every step (human + `--json`). Deterministic proof that a finding is reachable, not a heuristic; exits 1 on a proven path so CI can gate on it.

## 122. Semantic Duplicate & Divergence Detection ★ Differentiator
**Status: Vision** (AST + dataflow fingerprinting).

## 123. Contract Inference From Usage
**Status: Vision** (whole-codebase usage inference).

---

# Part XXX — Consistency, Drift & Fleet

## 124. Config ↔ Code Consistency & Env Drift ★ Differentiator
**Status: Core (partial)** — `no-unchecked-required-env` flags a `process.env.FOO` used as if defined (non-null assertion or immediate member access) with no default or guard — the "works locally, `undefined` in prod" crash. Full `.env.example` cross-checking remains **Planned** (project-scope).

## 125. Dependency Behavior-Diff on Upgrade ★ Differentiator
**Status: Vision** (needs two dependency versions).

## 126. Fleet Pattern Propagation ★ Differentiator
**Status: Vision** (multi-repo).

## 127. Feature-Flag Hygiene
**Status: Planned** (needs the flag service's state).

## 128. Backpressure & Streaming Correctness
**Status: Planned** (extends the stream-leak rule, §13, into flow-control reasoning).

---

# Part XXXI — Knowledge & Targeting

## 129. Codebase Onboarding Tour ★ Differentiator
**Status: Vision** (generation layer over the analysis graph).

## 130. Test-Gap Risk Targeting ★ Differentiator
**Status: Vision** (needs coverage data).

---

## How this set was approached

The discipline the catalog asks for is the one applied: **place bets one at a time, on precision.** Of §105–§130, the coherent, on-thesis, *precisely-implementable* subset shipped — the AI-feature security pack (§105–§109) plus `no-unchecked-required-env` (§124) — while the governance, correctness-pack, and fleet items that need attribution, an AI layer, cross-service reachability, or coverage data are marked **Planned/Vision** and left unbuilt rather than shipped noisy. A false positive in a "money safety" or "timezone" rule is worse than its absence; those stay **Planned** until they can be made precise. The invariants — deterministic offline core, local score, precision-first, AI-as-optional-layer — hold across §105–§130.
