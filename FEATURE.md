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
**Status: Detected** (`dockerfile-runs-as-root`, `dockerfile-mutable-base-tag`, `dockerfile-secret-in-build-stage`)

**Shipped:** the engine reads Dockerfiles as a first-class input — a final stage running as root, a mutable base tag (`:latest`/a floating major) that makes the build irreproducible, and a secret baked into a build layer (where it survives in the image history even if a later stage deletes it). Each rule demands positive evidence the file IS a Dockerfile, so a docker-compose file or a shell script is never mis-analyzed. Layer-size/cache-order and multi-stage-optimization advice remain Planned.

Dockerfile optimization, multi-stage builds, root-user detection, image size, layer optimization, healthcheck presence, image security scanning.

## 25. Kubernetes Analysis
**Status: Detected** (`k8s-privileged-container`, `k8s-host-namespace`, `k8s-missing-resource-limits`)

**Shipped:** Kubernetes manifests are parsed and checked for the container-escape and noisy-neighbour classes — a `privileged: true` container, a pod sharing a host namespace (`hostNetwork`/`hostPID`/`hostIPC`), and a container with no resource limits. Detection requires positive manifest evidence (`apiVersion` + `kind`), so a docker-compose file with a `privileged:` key is never reported as a Kubernetes finding. Probe/affinity/PDB-level advice remains Planned.

Missing resource limits, missing requests, health probes, secret handling, ConfigMaps, autoscaling config, ingress validation.

## 26. CI/CD Analysis
**Status: Detected** (`ci-script-injection`, `ci-pull-request-target-checkout`, `ci-unpinned-action`)

**Shipped:** GitHub Actions workflows are analyzed for the pipeline-compromise classes — script injection through `${{ github.event.* }}` interpolated into a `run:` block, a `pull_request_target` workflow checking out untrusted PR code (which then runs with write-scoped secrets), and an action pinned to a mutable tag rather than a commit SHA. Other CI providers remain Planned.

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
**Status: Core** (`node-doctor queues`) — see §157 for the topology map.

**Shipped:** `node-doctor queues` maps the publish/consume graph across kafkajs, amqplib, BullMQ/bull, NATS, MQTT and Redis pub/sub, reporting orphan topics (published, never consumed) and dead consumers (subscribed, nothing publishes). Per-consumer correctness checks (ack/nack discipline, DLQ configuration, prefetch tuning) remain Planned.

### Supported
RabbitMQ, Kafka, SQS, BullMQ, Redis Queue.

### Checks
Retry strategy, dead-letter queue presence, duplicate processing, idempotency, consumer health.

## 30. Cron Job Analysis
**Status: Detected** (`no-invalid-cron-expression`, opt-in)

Duplicate jobs, missing locks (no distributed lock on scheduled work), long-running jobs, retry policies, schedule conflicts.

**Shipped, the provable slice:** `no-invalid-cron-expression` (Bugs/error/high) catches a scheduled job whose cron expression can never fire — the nightly rollup that silently never runs, or the malformed string that throws at startup and takes the process down on deploy. Nothing else catches it: it is a string, so neither review nor the type checker sees it. It parses the expression at recognized scheduler call sites only (node-cron `schedule`, node-schedule `scheduleJob` incl. the `(name, expr, fn)` form, `new CronJob(expr)` / `{ cronTime }`, croner `Cron(expr)`, BullMQ/Bull `{ repeat: { pattern | cron } }`), behind an import gate, and claims invalid **only** for what a parse proves: a field count that is neither 5 nor 6, a value outside its field's range, a reversed range, or a zero/non-numeric step. Everything it does not fully model stays silent — `@daily` macros, month/day names, and the Quartz extensions (`L`, `W`, `#`, `?`) — as does any expression that is not a readable static string. Overlap/lock/duration analysis remains Planned.

## 31. WebSocket Analysis
**Status: Detected** (`no-missing-websocket-error-handler`, opt-in)

Socket leaks, authentication on connect, event/payload validation, room management, connection cleanup.

**Shipped, the crash-class slice:** `no-missing-websocket-error-handler` (Reliability/warn/high) flags a `ws` connection handler that wires up `message`/`close` but never `error`. A socket is an EventEmitter, and an `error` event with no listener is re-thrown as an uncaught exception — so one client vanishing mid-frame, one ECONNRESET on a flaky mobile network, takes down the process and every *other* connected socket with it. It survives every test because the happy path never emits `error`. Precision: it fires only when the socket parameter is a plain binding that already has at least one statically-named listener registration here, has no `error` registration, and never escapes — if the socket is passed to a helper, stored in a set, returned, or used with a dynamic event name or `addEventListener`, the handler may live out of sight and the rule stays silent. Authentication-on-connect, payload validation and room-lifecycle checks remain Planned.

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
**Status:** JSON, **SARIF** (`--sarif-out`, for GitHub code scanning), **Markdown** (PR comments) and **HTML** (`--html-out`) are all **Core**; PDF/CSV and historical trend reports remain **Vision** (they need persisted state).

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
**Status: Core** (`node-doctor lsp`)

**Shipped:** a language server over the same engine as the CLI — inline diagnostics, hover explanations and quick fixes computed on the *unsaved* buffer, so a finding appears as you type rather than on save. Editor-specific surfaces beyond the LSP (CodeLens, an inline history gutter) remain Planned.

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
**Status: Core** (opt-in `--typed`)

**Shipped:** an optional pass that reads the project's own TypeScript types, catching what a syntactic check structurally cannot — most importantly a **discarded promise** where the callee is typed `(): Promise<T>` rather than written `async`, the majority case in a real TypeScript codebase. `typescript@^5` is an optional peer: without it a normal scan is unchanged and `--typed` fails loudly rather than silently finding nothing.

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
**Status: Core** (`node-doctor sbom`)

**Shipped:** a CycloneDX or SPDX (`--framework spdx`) bill of materials generated from the dependency tree, entirely offline and deterministic — the same bytes for the same input, so it can be committed and diffed. Vulnerability enrichment is deliberately excluded (it requires network access; see §60).

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
**Status: Core** (`node-doctor surface`, `node-doctor paths`)

**Shipped:** `surface` enumerates every route with its middleware chain and authentication posture — the "which endpoints are unauthenticated?" question answered from source — and `paths` proves exploitability by printing the source→sink chain for each injection sink fed by request data, `file:line` at every hop. Together they map the attack surface and which of it is reachable. Per-route authorization *correctness* (does this route check the right permission?) needs per-model scope knowledge and remains Planned (see §114).

- **Attack-surface map** — enumerate every externally reachable entry point (routes, webhooks, queue consumers, GraphQL fields) with its auth posture.
- **Authorization matrix** — auto-generate a route → required-permission table and flag inconsistencies and gaps. Enormously useful for security review and impossible to maintain by hand.

## 71. Compliance Packs
**Status: Vision**

Curated rule bundles mapped to **SOC 2, PCI-DSS, HIPAA, GDPR, ISO 27001** controls, with per-control pass/fail and evidence export for auditors.

## 72. IaC & Cloud-Config Security
**Status: Detected** (`no-open-security-group`, `no-overbroad-iam-policy`, `no-public-cloud-storage`)

**Shipped:** Terraform and CloudFormation configs are read by the same engine — a security group open to `0.0.0.0/0`, an IAM policy granting `*` action or resource, and a publicly-readable storage bucket. Each requires positive evidence of the file type before firing. Drift detection against a live account stays out of scope (it needs network access).

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
**Status: Core** (`node-doctor surface --baseline <f>`)

**Shipped:** the route surface is snapshotted to a baseline file and diffed on every run — a removed route, a changed method, or a route that lost its authentication middleware is reported as a breaking change and exits non-zero in CI. The package-export equivalent ships as §155 (`node-doctor semver`). Request/response *shape* diffing (a narrowed field, a newly-required body property) remains Planned.

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
**Status: Core** (`node-doctor modernize`)

**Shipped:** a second number, separate from the health score, that goes *up* as deprecated APIs and unsupported Node majors are retired — so modernization work shows measurable progress instead of competing with feature work for attention. Deterministic and offline.

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
**Status: Core** (`--owners`)

**Shipped:** findings are grouped by the team that owns the file, resolved from `CODEOWNERS` — so a 200-finding monorepo report becomes each team's own short list instead of a wall nobody triages.

Use CODEOWNERS / directory ownership to route each finding to the responsible team and scope PR comments accordingly.

## 90. PR Risk Scoring & Effort Estimates
**Status: Core** (`--risk`)

**Shipped:** one explainable number per change for triage, alongside the PR summary and inline review comments (§42). Effort *estimates* (how long a fix will take) remain Vision — they need historical data this tool does not collect.

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

---

# node.doctor — Features (Frontier / §131–§158)

A fourth extension. Everything here is **net-new** against §1–§130 — bug classes and capabilities the catalog has not touched, chosen for novelty over breadth. Same maturity legend (**Core** / **Detected** / **Planned** / **Vision**) and the same invariants (deterministic + offline core, local score, precision-first, AI-as-optional-layer).

> **Buildability tag.** Because "new" is cheap and "shippable" is not, each feature carries a build signal:
> **⚙️ Now** — implementable on the engine that exists today (import graph, request-path detection, cross-file taint, capability tokens). No new infrastructure.
> **🔧 Needs depth** — requires analysis the engine does not yet have (schema parsing, type source, cross-service graph).
> **🛰 Needs infra** — requires something outside the offline core (runtime data, hosted state, an AI layer).
>
> **★ Differentiator** / **★★ Flagship** carry their existing meaning. The eleven **⚙️ Now** items are the ones that could ship this quarter.

**New parts:** XXXII Cost, Latency & Efficiency (§131–§134) · XXXIII Distributed Failure Reasoning (§135–§139) · XXXIV Data Correctness & Lineage (§140–§145) · XXXV Protocol & Input Semantics (§146–§150) · XXXVI Observability & Debuggability (§151–§153) · XXXVII Supply Chain, Packages & Topology (§154–§158).

---

# Part XXXII — Cost, Latency & Efficiency

*Static analysis that reasons about **consequences in units engineers are measured on** — milliseconds and dollars — rather than pattern presence. §12 flags that an N+1 exists; this part says what it costs.*

## 131. Cloud Cost Attribution (Code-Level FinOps) ★★ Flagship
**Status: Planned** · 🔧 Needs depth

Estimate the **cloud cost of a code path**, not of infrastructure. Infracost prices your Terraform; nobody prices your handler. Attach a cost model to the operations the call graph already sees: DB round trips per request, S3/API calls in a loop, cross-AZ egress, Lambda duration × memory, per-token LLM spend (§109).

Output is a per-route cost profile — *"`GET /orders` costs ~$0.004/req; 87% of that is the N+1 at `repository.ts:88`"* — which converts a Performance finding into a budget line. Distinct from §103 (fix-impact simulation): §103 estimates the payoff of *fixing*; this prices the code as it stands.

## 132. Static Latency Budget & Critical-Path Analysis ★★ Flagship
**Status: Detected** (`no-sequential-independent-awaits`, opt-in) · ⚙️ Now

Compute each route's **serial critical path** from the call graph: count sequential `await`s that cross a network or disk boundary, identify awaits that are independent and could be parallel, and produce an estimated floor latency. Then check it against a declared SLO.

**Shipped, precision-first (opt-in):** `no-sequential-independent-awaits` (Performance/warn/high) is the highest-value, false-positive-free slice — "identify awaits that are independent and could run in parallel". It flags ≥2 consecutive independent network **GET** reads (`fetch`/`axios.get`/`got`/…) awaited serially in one block, where no later await reads an earlier-bound name, and recommends `Promise.all` (serial cost = sum of latencies → parallel cost = max). It is **network-reads-only** by deliberate design: writes (POST/PUT/…) and **DB queries** are never flagged, because parallelizing them is unsafe on a single connection or inside an interactive transaction, and pooled-vs-single cannot be told apart from a receiver name — unsafe advice is a false positive. The full cross-file critical-path arithmetic and SLO check remain Planned (needs the call-graph latency model).

*"This handler has 7 serial round trips; at a 20ms p50 per hop it cannot meet a 100ms SLO. Hops 3–5 are independent and parallelizable."* Genuinely novel, needs nothing the engine lacks, and it turns "slow API" from a vibe into arithmetic.

## 133. Resource-Shape Right-Sizing ★
**Status: Planned** · 🔧 Needs depth

Cross-check configured resource shapes against what the code actually does: a DB pool of 100 behind a service that never exceeds 4 concurrent queries, a Lambda at 128MB doing image processing, `UV_THREADPOOL_SIZE` defaults under heavy `fs`/crypto load, worker counts vs. actual CPU-bound work. Config and code, judged against each other.

## 134. Energy & Carbon Footprint Estimation
**Status: Vision** · 🛰 Needs infra

The sustainability sibling of §131: translate the same operation counts into estimated energy and CO₂e per request. Increasingly a reporting requirement in the EU, and no code-level tool offers it. Lower conviction than §131 — included for completeness, and it rides the same cost model.

---

# Part XXXIII — Distributed Failure Reasoning

*How the system behaves when something downstream is slow or broken. §10 catches a single retry with no backoff; this part reasons about failure **across** the graph.*

## 135. Retry Amplification & Thundering-Herd Analysis ★★ Flagship
**Status: Detected** (`no-retry-amplification`, opt-in) · ⚙️ Now

**Multiplicative retries are a famous outage cause and no linter models them.** Service A retries 3×, calling B which retries 3×, calling C which retries 3× — one user request becomes 27 hits on a struggling database, and the retry storm *is* the outage.

**Shipped, precision-first (opt-in):** `no-retry-amplification` (Reliability/warn/high) catches the file-local, unambiguous slice: a retry wrapper (`pRetry`/`retry`/`asyncRetry`/`backOff`/…) whose operation ITSELF retries — either a **nested retry wrapper**, or an **auto-retrying SDK client**. Client detection is gated on the SDK actually being **imported** (`@aws-sdk` `.send()`, `got`, `stripe`, `axios`+`axios-retry`), so a receiver merely named like a client (`emailClient.send`, a local `got`/`stripe` binding) never fires — hardened against an adversarial FP hunt that found the naïve `endsWith("Client")` heuristic fired on nodemailer/gRPC/Redis/Kafka clients. The cross-file multiplication (walking retry factors along the call graph) remains Planned.

Walk the call graph, multiply the retry factors along each path, and flag paths whose amplification exceeds a threshold. Also flags retries without jitter (synchronized herds) and retries wrapped around already-retrying clients (SDKs that retry internally). Pure graph arithmetic on data the engine already has.

## 136. Timeout Budget Consistency ★ Differentiator
**Status: Detected** (`no-inverted-timeout-budget`, opt-in) · ⚙️ Now

Timeouts must *decrease* down a call chain. When a caller's timeout is shorter than its callee's, the caller gives up while the callee keeps working — orphaned work, wasted connections, and a leak that only appears under load. When it's longer, failures surface far later than they should.

**Shipped (opt-in), the provable file-local slice:** `no-inverted-timeout-budget` (Reliability/warn/high) fires when an outer budget B provably governs an operation whose outbound call is configured to keep trying for T > B — the caller gives up at B while the HTTP request runs to T (orphaned work, a held socket). **Every semantic is proven, never assumed from a name** (an adversarial hunt showed name-matching flags retry counts, lock-hold durations, and tracing shims as "budgets"): the wrapper must be the **`p-timeout` package by binding** (ESM import or `require`, any import name — a same-file `withTimeout(fn, retries)` retry helper never fires); a `Promise.race` timer must **provably reject** (an inline `new Promise((_, reject) => setTimeout(…, B))` with an UNCONDITIONAL timer, or a same-file module-level helper whose body is exactly that shape — a resolve-only sleep, a `.timeout(n)` query method, an `if (offline)`-guarded reject, and an imported helper of unknown semantics never count); and each HTTP client is **verified by its import** (`axios`/`got`/`ky` bindings, global or node-fetch/undici `fetch`, `node:http(s)`) with verb-aware axios config positions so a `timeout` field in a POST **body** is payload, not config. The operation is followed one bounded hop into module-level `const`/`function` bindings only (a `let` may be reassigned), uninvoked nested functions are pruned, `timeout: 0` sentinels are skipped, and the correct direction (inner ≤ outer) is never flagged. Round-2 hardening (32 adversarially-confirmed FPs pinned across two hunts): a name declared more than once in the file is ambiguous and never proven (block-scope shadowing hoists in the resolver); only immutable bindings prove a package; a race-timer helper must *return* an unconditionally-rejecting, never-self-cleared timer whose delay is its untouched first parameter; and constructed-but-not-invoked closures (factory thunks, lazy stream `.map`, thenable-lookalike `.then`) never count — array callbacks are followed only in the `Promise.all(ids.map(cb))` shape. Cross-file budget propagation through the call graph remains Planned.

## 137. Cancellation & AbortSignal Propagation ★ Differentiator
**Status: Detected** (`no-dropped-abort-signal`, opt-in) · ⚙️ Now

**Shipped (opt-in), the file-local slice:** `no-dropped-abort-signal` (Reliability/warn/high) fires when a function that directly receives an `AbortSignal` (a `signal`/`abortSignal` param, or a destructured `{ signal }`) makes a cancellable outbound call — `fetch`/`axios`/`got` — in its own body without forwarding the signal, so an abort by the caller leaves the request running (orphaned work, a held connection). It only fires when the config slot is demonstrably present-without-`signal` or absent (a spread or opaque config → silent), and it excludes a `signal` param that is actually a **unix signal** (string-compared, switched, or interpolated as `${signal}` — a shutdown handler, not a cancellation token). Cross-file signal propagation through the call graph remains Planned.

A client disconnects, the handler is aborted — and the three downstream calls it started keep running, holding connections and burning budget. Track whether an `AbortSignal` **propagates** from the request boundary through helpers to every outbound call, and flag the hop where it's dropped. Distinct from "has a timeout": this is about the signal surviving the call chain.

## 138. Health-Check Correctness & Cascading-Failure Risk ★
**Status: Detected** (`no-liveness-check-with-dependency`, opt-in) · ⚙️ Now

**Shipped (opt-in), the high-value "too deep liveness" slice:** `no-liveness-check-with-dependency` (Reliability/warn/high) flags a route on a LIVENESS path (`/healthz`, `/livez`, `/ping`, `/healthcheck`, …) whose handler makes a downstream dependency call — a DB query, an outbound `fetch`/`axios`, or a networked Redis/memcached call — because when that dependency is slow or down, every pod reports unhealthy and the orchestrator restarts the whole fleet: one dependency failure becomes a total outage. Path matching is SEGMENT-based (so `/health-tips` and `/healthy-recipes` are content routes, not probes, and `/healthcheck`/`/health_check` are correctly caught), READINESS paths take precedence (they SHOULD check deps), and an in-memory cache read is NOT treated as a network dependency. The "too shallow always-200" case is deliberately not attempted (too noisy).

Both failure modes of a health endpoint, statically:

- **Too shallow** — returns `200` unconditionally, so the orchestrator keeps routing traffic to a pod whose DB connection is dead.
- **Too deep** — checks every downstream dependency, so one slow non-critical service makes every pod report unhealthy and the whole fleet gets restarted. A liveness probe that checks dependencies is a self-inflicted cascading outage.

Also flags health checks that share a connection pool with request traffic (the pool starves, the probe fails, the pod is killed mid-incident).

## 139. Static Chaos Scenario Generation ★ Differentiator
**Status: Vision** · 🛰 Needs infra

Derive a fault-injection plan from the code: enumerate every external call site the graph knows about and generate the concrete scenarios worth testing — *"what happens when the payment API returns 503 here?"*, *"when this Redis call hangs?"* — ranked by blast radius (§120). Static analysis that authors your chaos experiments instead of guessing at them.

---

# Part XXXIV — Data Correctness & Lineage

## 140. Cache-Key Correctness & Cross-Tenant Poisoning ★★ Flagship
**Status: Detected** (`no-cross-tenant-cache-key`, opt-in) · ⚙️ Now

**Shipped, precision-first (opt-in) — the highest-severity item in this catalog.** `no-cross-tenant-cache-key` (Security/warn/high) flags a cache write `<cache>.set(key, value)` whose VALUE carries a user/tenant identity (`req.user.id`, `req.tenantId`, `ctx.state.user`, a bare `userId`/`tenantId`/…) that the KEY omits — the silent cross-tenant leak where user A's cached data is served to user B. It reasons only on what it can prove: the key must be a fully-readable inline expression (a template/string/concat, or a variable resolving to one) shown to omit the id — an OPAQUE key (a bare variable, a param, a key-building call) stays silent, since it may carry the id where it was built. Corpus-hardened against three FP classes: an id in an **audit stamp** (`createdBy: req.user.id`) of an otherwise-shared value, a **per-session key** (`sess:${sid}`, already per-user), and generic non-cache receivers (`store`). Cross-file value taint (an id injected one hop up) is a deliberate recall gap.

**A cache key that omits a variable the cached value depends on is a data-leak bug, and §16 doesn't cover it.** If the response varies by `userId` or `tenantId` but the key is `` `orders:${status}` ``, one customer is served another's data — from cache, intermittently, and almost impossible to reproduce.

Compare the variables that flow into the cached *value* against those that flow into the *key*; flag the difference. The same analysis catches keys built from object iteration order or `JSON.stringify` of an unordered object (non-deterministic keys → silent cache misses). This is the highest-severity item in this document and it is reachable with today's taint engine.

## 141. Pagination Correctness ★
**Status: Detected** (`no-unstable-offset-pagination`, opt-in) · ⚙️ Now

**Shipped (opt-in):** `no-unstable-offset-pagination` (Bugs/warn/high) flags offset/`skip` pagination with no stable sort — the "the report is missing three orders" bug, where inserts/deletes between page fetches shift the window and pages silently drop and duplicate rows. Three shapes: Prisma `.findMany({ skip })` (with a genuine numeric/dynamic offset, on a DB-shaped receiver, no `orderBy`), a query-builder `.offset().limit()` chain with no order method on either side, and a raw SQL literal that offsets (`OFFSET`, or MySQL's `LIMIT offset, count`) without `ORDER BY`. A DB-receiver gate keeps a look-alike `.findMany`/`.aggregate`/`.groupBy` on a non-database object (an array/stream helper) from firing. Uniqueness of the sort key and the inconsistent-count-vs-page sub-case are deliberate recall gaps.

Offset pagination over mutable data silently drops and duplicates rows as records are inserted between page fetches — the classic "the report is missing three orders and nobody knows why." Flags: `OFFSET`/`skip` without a stable, unique sort key; pagination over a table with active writes where a cursor is the correct pattern; and inconsistent sort keys between the count query and the page query.

## 142. Dead Schema & Unused Column Detection ★★ Flagship
**Status: Core** (`node-doctor schema-drift`, alias `dead-schema`) · ⚙️ Now

§20 finds dead *code*; nothing finds dead *data*. Cross the ORM schema against every read and write the codebase performs, and report columns, tables, indexes, and enum values that no code path touches. Also the inverse — code referencing fields the schema no longer has (drift that only fails at runtime).

**Shipped as a command** (`schema-drift`, alias `dead-schema`), Prisma-first: a dependency-free `schema.prisma` parser (models, `@@map`/`@map`, relations, compound `@@unique`/`@@id` aliases, enums, multi-file schemas) crossed against every statically-visible Prisma call. Both directions: (1) **drift** — a `where`/`select`/`data`/`orderBy`/`distinct`/`by`/aggregate key that names a field the schema does not define (`prisma.user.findMany({ where: { emial } })` — a runtime `PrismaClientValidationError` found at build time, with a did-you-mean suggestion; exit 1); and (2) **dead models** — schema models no code path touches (migration debt, backup cost, compliance surface — an unused `ssn` column is pure liability). Precision: a drift finding requires a confident Prisma call (db-hint receiver + schema client property + known method) and a fully-static argument (any spread/computed key silences the object); operators (`AND`/`some`/`equals`/`set`/…), relation traversals (validated against the RELATED model), compound where-unique aliases, and `_count`/`_sum` outputs are understood, not flagged. Dead-model claims are made only when nothing could hide a use — no dynamic `client[expr]` access and no unresolved raw SQL anywhere (otherwise the report says detection was degraded and claims nothing); resolved raw-SQL tables credit their models (matching `@@map` names too). Unused *columns* and dead enum values remain Planned (a bare `findMany()` reads every column, so column-level death is only provable under exhaustive `select`s).

## 143. Data Access Map & Route → Entity Lineage ★★ Flagship
**Status: Core** (`node-doctor data-map`, alias `lineage`) · ⚙️ Now

**Shipped as a command** (`data-map`, alias `lineage`): the matrix of **which routes touch which tables, and how** (read/write/delete). It falls straight out of two things the engine already computes — the project call graph and per-route request handlers — plus one pure question, `queryTarget(call)`: is this a database query, and if so against which entity and with what operation. For each registered route it walks the call graph FORWARD from the handler (cross-file, depth-bounded, mirroring the interprocedural-taint walk), classifies every query call it reaches, and unions the resolved `(entity, op)` pairs; inverting the index yields the entity → routes view. It answers, from source alone:

- Security review: *which unauthenticated endpoints write to `payments`?*
- Blast radius on the data side: *if I change this table, which endpoints care?*
- Service extraction: which routes cluster around which entities.

**Extraction (conservative by design — a resolved entity is emitted only when it can be proven, never guessed):** Prisma model calls (`client.model.method()`, op by verb), TypeORM `getRepository(Entity)`, ORM `Model.method()` on a PascalCase/`Repository`/`Repo`/`Model` receiver, Knex builder chains (`db("table").insert()` / `.from()` / `.into()`), and **raw SQL** — `db.query(...)`, `prisma.$queryRawUnsafe(...)`, and Prisma's typed tagged-template `` $queryRaw`…` `` / `` $executeRaw`…` `` — parsing the table from `DELETE FROM` / `INSERT INTO` / `UPDATE` / `FROM` (delete > write > read priority). Raw-SQL **template literals** with interpolations are read from their static quasis (`` `SELECT * FROM users WHERE id = ${x}` `` → `users:read`), with each `${…}` hole replaced by a `?` placeholder so an interpolated **table position** (`` FROM ${t} ``) stays deliberately unresolved rather than guessed. A dynamically-built SQL string, a non-`$` bare `` sql`…` `` tag, and a cross-file value that can't be proven are all under-reported (counted as an unresolved query) rather than mis-attributed. The SQL reader is hardened against the shapes that make a naive parser invent phantom tables: it strips comments (`-- …`, `/* … */`, `#…`) and single-quoted string literals before parsing (so a `FROM` inside a comment or a value never leaks a table), drops row-locking clauses (`FOR UPDATE OF …`, `SKIP LOCKED`, `NOWAIT`, `FOR SHARE`) so a locking read is never misread as a write of the keyword after `UPDATE`, and resolves quoted/schema-qualified identifiers to the bare table (`"public"."Users"` / `` `shop`.`items` `` / `[dbo].[Orders]` → `Users` / `items` / `Orders`). The Knex/ORM side is gated symmetrically — a builder chain is classified only when it roots at a db-hint receiver and its method is a known query op (so `Buffer.from(…)`, `Array.from(…)`, `Object.create(…)`, and a stray `db("x").removeListener(…)` are never mistaken for table access). Deterministic, offline; entities sorted, ops in fixed `read < write < delete` order.

## 144. Query Plan Simulation ★
**Status: Vision** · 🔧 Needs depth

Statically extract every query the code can issue, reconstruct it against the parsed schema, and reason about the plan without a live database: full scans on unindexed predicates, joins missing an index, `SELECT *` on wide tables, sorts that will spill. Turns §14's "missing index" heuristic into an evidence-backed claim.

## 145. Serialization & Precision Safety ★
**Status: Detected** (`no-bigint-precision-loss`) · ⚙️ Now

The quiet data-corruption class at the JSON boundary: `BigInt` (or a 64-bit DB id) serialized into a JS number and silently losing precision above 2^53, `Date` objects crossing a boundary and becoming strings that are then compared as dates, `undefined` vs `null` asymmetry through `JSON.stringify`, circular references that throw only on a rare code path, and `Decimal`/`NUMERIC` columns coerced to float on the way out.

**Shipped:** `no-bigint-precision-loss` (Bugs/warn/high) flags `Number(x)`/`+x`/`parseInt(x)` where `x` is a provably-BigInt value (a `123n` literal, a `BigInt(...)` call, or a binding to either) — the exact `2^53` precision-loss coercion. It stays silent on `String(bigint)`/`.toString()` and any operand it cannot prove is a BigInt (including a catch-parameter that shadows an outer BigInt const — the scope resolver now models `catch` bindings). The remaining sub-classes (Date/undefined/Decimal boundaries) are still Planned.

---

# Part XXXV — Protocol & Input Semantics

## 146. Validation Regex Correctness ★★ Flagship
**Status: Detected** (`no-unanchored-security-regex`, `no-stateful-global-regex-test`) · ⚙️ Now

**A validation regex missing its anchors is an auth bypass, and it is everywhere.** `/https:\/\/trusted\.com/.test(url)` matches `https://evil.com/?x=https://trusted.com`. `/admin/` matches `superadmin`. §11 covers ReDoS (performance); this covers *correctness*, which is the security half.

**Shipped, precision-first:**
- `no-unanchored-security-regex` (Security/error/high) fires only when an unanchored regex is used as a boolean allow/deny **gate** (`.test()`/`.exec()`/non-global `.match()`), the tested operand is named like an untrusted URL/host (`redirectUrl`, `origin`, `referer`, …) but **not** the current page's own `window.location` (self-detection), and the pattern names a **concrete host** (`trusted\.com`, an IP, `localhost`) — a bare `://` scheme is deliberately not enough, since `/https?:\/\//` is absolute-URL detection with no host to bypass. It is silent on any start-anchored pattern and on extraction (`const host = url.match(/…\/([^/]+)/)[1]`). Verified against a 30k-file real-world corpus: **zero false positives** after this gating.
- `no-stateful-global-regex-test` (Bugs/error/high) flags a stored `g`/`y`-flagged regex literal reused via `.test()`/`.exec()` across calls (the `lastIndex` flip-flop bug), while exempting the in-loop match-iteration idiom (`while (RE.exec(s))` / `while (RE.test(s))`). It found genuine latent instances of this bug in `mongoose` and `websocket-extensions` during corpus testing.

The recall half (`/admin/` matching `superadmin` on privilege checks) is a deliberate silence — too noisy for `error` — and remains Planned.

Flags: unanchored regexes used in a security decision (origin, redirect, role, path allowlist), `.` matching unintended characters in a domain check, missing `u` flag where it matters, and `test()` on a `/g` regex (stateful `lastIndex` — alternating true/false across calls, a genuinely evil bug).

## 147. HTTP Caching & Privacy Semantics ★★ Flagship
**Status: Detected** (`no-shared-cache-authenticated-response`, opt-in) · ⚙️ Now

An authenticated response served without `Cache-Control: private, no-store` can be cached by a CDN or shared proxy and handed to the next user. Same class of leak as §140, one layer up the stack, and equally uncovered.

**Shipped, precision-first (opt-in):** `no-shared-cache-authenticated-response` (Security/warn/high) fires when a request handler serializes user-identity data into the response *body* AND sets a shared-cacheable `Cache-Control` (`public` or a positive `s-maxage`, not `private`/`no-store`). The body-reaching requirement is the precision crux — an identity read used only to gate access (`if (!req.user) return res.sendStatus(401)`) or to validate a CSRF token does not personalize the payload, so those stay silent. It is also silent when the response is correctly keyed with `Vary: Authorization`/`Cookie` (the rule's own remedy) or overridden to `private`/`no-store`, and covers express, koa (`ctx.state.user`, `ctx.body`), and fastify. Hardened against an adversarial FP hunt (Vary-keying, override, auth-gate, CSRF-only, `s-maxage=0` all confirmed silent). The `Vary`/`ETag`/`s-maxage`-on-personalized sub-cases remain Planned.

Flags: authenticated routes with public/absent cache directives, `Vary` omitting `Authorization` or `Cookie`, `ETag` computed over user-specific data on a shared-cacheable response, and `s-maxage` on personalized content.

## 148. Unicode Normalization & Homoglyph Safety ★
**Status: Detected** (`no-unnormalized-identity-comparison`, opt-in) · ⚙️ Now

Identity comparisons on un-normalized strings: two different byte sequences render identically, so `admin` and `аdmin` (Cyrillic а) are distinct keys but visually identical — account spoofing. Flags missing `.normalize()` before comparing or storing identity strings (usernames, emails, tenant slugs), case-folding with `toLowerCase()` where locale-aware folding is required (the Turkish dotless-ı bug), and length checks in code units on user-supplied text.

**Shipped, narrow-by-design (opt-in):** `no-unnormalized-identity-comparison` (Security/warn/high) fires on an equality comparison where one operand is identity-named (username/email/login/handle/slug/tenant/…), one shows canonicalization intent (`.toLowerCase()`/`.toLocaleLowerCase()`/`.trim()`), and neither calls `.normalize()`. The demonstrated-intent-plus-omission shape is what makes the omission a real bug rather than an incidental compare. Both operands must be DYNAMIC — a comparison to a constant (`slug.toLowerCase() === "admin"`, `=== Roles.ADMIN`, `=== ""`) is a reserved-name/emptiness check a homoglyph can't collide with, so it stays silent. The `toLocaleLowerCase` Turkish-ı and code-unit-length sub-cases are deliberately not attempted (too noisy).

## 149. Content-Type & Encoding Confusion ★
**Status: Detected** (`no-wildcard-body-parser`, opt-in) · ⚙️ Now

**Shipped (opt-in), the precise high-confidence slice:** `no-wildcard-body-parser` (Security/warn/high) flags a body parser configured to parse EVERY request regardless of Content-Type — `express.json({ type: "*/*" })`, `bodyParser.urlencoded({ type: "*/*" })`, `express.raw/text({ type: "*/*" })`, or `type: () => true`. That defeats content-type negotiation (a form/text/binary body is JSON-parsed, and a client can mislabel a body to slip past content-type-based validation/WAF rules). Fires only on a POSITIVELY-universal `type` (the literal `*/*`, or a function whose body is exactly `return true`), and only on the immediate `express.`/`bodyParser.` receiver (so the `express.response.json` serializer, a scoped subtype like `application/*`, a real type-predicate function, and a non-body-parser `.json` all stay silent). The other §149 sub-cases (parser selection driven by the client Content-Type, charset mismatch, upload-extension-over-magic-bytes) remain Planned.

Parser confusion at the request boundary: trusting a client-declared `Content-Type` to select a parser, accepting `application/json` bodies on endpoints that assume form encoding (or vice versa), charset mismatches that defeat downstream sanitization, and uploads whose extension is trusted over their magic bytes.

## 150. Nondeterminism in Keys, Signatures & Idempotency ★
**Status: Detected** (`no-nondeterministic-stable-key`) · ⚙️ Now

`Date.now()`, `Math.random()`, `process.pid`, `Object.keys` order, or `Set`/`Map` iteration flowing into something that **must be stable**: a cache key, an HMAC payload, an idempotency key, an ETag, a deduplication hash. The value differs per call, so the cache never hits, the signature never verifies, or the "idempotent" retry creates a duplicate charge. A precise, narrow, taint-shaped rule — and a bug that is brutal to debug by hand.

**Shipped, precision-first:** `no-nondeterministic-stable-key` (Bugs/warn/high) flags a **random** source (`Math.random()`, `crypto.randomUUID()`) flowing into an HMAC/hash `.update()`, a `cache.set`/`redis.set` key, or an `idempotencyKey`/`cacheKey`/`dedupeKey`/`etag` property — the flagship being `idempotencyKey: crypto.randomUUID()` (a retried request charges twice). It deliberately excludes **time** sources (`Date.now()`, `hrtime`, `performance.now()`): a timestamp in a stable-key sink is far more often correct than not — a *signed request* transmits the timestamp alongside the signature, and a *time-bucketed* cache/rate-limit key (`` `rl:${u}:${Math.floor(Date.now()/1000)}` ``) is intentionally stable for its window — and the two cannot be told apart from a single file, so a random draw (which has no legitimate stable-key use) is the only unambiguous signal. Corpus-verified false-positive-free.

---

# Part XXXVI — Observability & Debuggability

## 151. Observability Coverage Score ★ Differentiator
**Status: Core** (`node-doctor observability`) · ⚙️ Now

**Shipped as a command** (`observability`, alias `observe`): the observability equivalent of test coverage — "could you debug this route at 3am from the logs alone?". For each route's registered handler it answers four pass/fail/**na** questions: (1) error-handling — does an async path that can reject have a try/catch, an async-error wrapper, or a `.catch`; (2) logs-on-failure — does an error path actually emit something (a log, `next(err)`, `captureException`), so a swallowing `catch`/`.catch(() => {})` FAILS; (3) timed-external-calls — do outbound `fetch`/`axios`/`got` calls carry a timeout/signal; (4) correlation-id — do logs carry a request/correlation id. "na" (a risk the handler cannot have — e.g. a sync route, no outbound call) never counts against the score. It reports a per-route score (passed/applicable) and a codebase mean, worst routes first, plus a per-check pass-rate. Precision: only `(req,res)`/`(request,reply)`/`ctx`-shaped handlers are scored, so a `cache.get(key, loader)` / `config.get(x, default)` look-alike is never mistaken for a route; cross-file handlers are under-reported rather than guessed; deterministic and offline.

§21 asks "are there logs?"; this asks **"could you actually debug this route at 3am?"** Score each route on whether its failure paths emit anything, whether errors carry a correlation ID, whether external calls are timed, and whether the catch blocks that swallow errors do so silently. Report per-route coverage and a codebase-level score — the observability equivalent of test coverage, which does not currently exist.

## 152. Async Context Propagation Integrity ★★ Flagship
**Status: Detected** (`no-lost-async-context`, opt-in) · ⚙️ Now

`AsyncLocalStorage` — the mechanism behind request IDs, tenant context, and distributed tracing in modern Node — **breaks silently**.

**Shipped, narrow-by-design (opt-in, medium confidence):** `no-lost-async-context` (Reliability/warn) flags the clearest loss: `AsyncLocalStorage.getStore()` called lexically inside an **EventEmitter** listener (`.on`/`.once`/`.addListener`/…), where the callback runs in the emit-time context, not the registration-time context, so the request/tenant/trace context is silently lost. The receiver must resolve to an `AsyncLocalStorage` instance (a `new AsyncLocalStorage()` binding, or an unmistakably-ALS name in an ALS-importing file — `context`/`storage` are excluded as too generic), and the read must be the listener's own body (nested timers/callbacks are pruned; `setTimeout`/promises propagate correctly in modern Node and are never flagged). Deliberately does NOT try to prove emit timing, so it is medium-confidence and opt-in. Cross-file/pool-boundary context loss remains Planned. Context is lost across `EventEmitter` callbacks, some pooled-connection boundaries, `setTimeout` chains established outside the run scope, and worker threads. The symptom is a request ID that vanishes halfway through a trace, or worse, a *tenant* context that vanishes.

Track the context boundary through the call graph and flag the exact hop where it is dropped. Nothing detects this today, and it is painful enough that people give up on tracing over it.

## 153. Error Taxonomy & Response Consistency ★
**Status: Detected** (`no-throw-literal`) · ⚙️ Now

Whether the service speaks one error language: the same failure mapped to different status codes in different handlers, error shapes that vary across routes (`{error}` vs `{message}` vs `{errors:[]}`), thrown strings and bare objects instead of `Error` instances (losing stack traces), `instanceof` checks against error classes that cross a module boundary, and internal error codes with no catalog. Extends §9 from "is there handling" to "is the handling coherent."

**Shipped:** `no-throw-literal` (Bugs/warn/high) flags `throw` of a string/object/template/array literal (or an identifier resolving to one) — the stack-trace-losing anti-pattern that ESLint's own `no-throw-literal` targets (corpus hits in `react-dom`, `@reduxjs/toolkit`, `react-native`, several carrying `// eslint-disable-line no-throw-literal`). It is silent on `throw new X()`, `throw err` (a caught/param binding — the scope resolver now models `catch` params so an outer const of the same name never leaks in), and `throw factory()`. The broader consistency checks (status-code and error-shape coherence across routes) remain Planned.

---

# Part XXXVII — Supply Chain, Packages & Topology

## 154. Phantom & Undeclared Dependency Detection ★
**Status: Core** (`node-doctor deslop`) · ⚙️ Now

**Shipped in `deslop`:** the inverse of §19's unused-package check — a package **imported but not declared** in `package.json` (any dep list), which works locally only because a hoisted transitive dependency happens to provide it and breaks the moment the tree changes or a `--production` install runs. `deslop` now returns `undeclaredDependencies` (and renders them). Precision: Node builtins (with/without the `node:` prefix), the package's own name, and same-scope workspace siblings (`@org/api` importing `@org/shared`) are excluded, subpath imports resolve to their bare package name, and each import is checked against the **nearest-ancestor** `package.json` — so a sample app under `tests/fixtures/<app>/` (with its own manifest) is never attributed to the root. The `devDependencies-imported-by-production-code` sub-case remains a follow-up (needs per-file production classification).

The exact inverse of §19's unused-package check, and a nastier failure: a package **imported but not declared**, working locally only because a hoisted transitive dependency happens to provide it. It breaks the moment the tree changes, the package manager switches, or a Docker build installs with `--production`. Also flags imports of transitive dependencies (using a package you never declared) and `devDependencies` imported by production code.

## 155. Internal Package API Semver Linting ★
**Status: Core** (`node-doctor semver`, aliases `api-semver`/`exports`) · ⚙️ Now

§78 does semver for your **HTTP** API; this does it for your **package exports**. In a monorepo, diff a package's public surface between revisions — removed exports, narrowed parameter types, changed return shapes, newly-required options — and flag breaking changes shipped without a major bump. Reuses the baseline-delta machinery, applied to an export surface instead of a finding set.

**Shipped as a command** (`semver [--baseline <f>]`): for every workspace package (or the single root package) it resolves the entry file (package.json `exports`/`module`/`main`; a `dist/` target with no built artifact falls back to its `src/` twin) and extracts the name-level export surface — ESM named/default/class/type exports, `export * from` followed recursively through relative modules, structure-aware destructuring exports (`{ a: c }` binds `c`, never the key), and CJS `exports.x` / `module.exports = {…}`. `--baseline` snapshots on first run and diffs after: a **removed export is breaking** and errors (exit 1) unless the version bumped major (or minor while still 0.x, per semver); an added export with an unchanged version is a "minor expected" advisory. Precision (12 adversarially-confirmed FPs pinned): a surface is `complete` **only when every way the module writes its exports was understood** — an unfollowable `export *`, an ambiguous name reached through two stars, an opaque/spread `module.exports`, `Object.assign(module.exports, …)`, tsc's `__exportStar`, `Object.defineProperty(exports, …)`, a chained or block-nested `exports.x =` all mark it **partial, which forbids removal claims**. Entry resolution is equally strict: a *declared* entry that cannot be resolved leaves the package **unanalyzed** rather than falling through to a conventional guess (a CLI `bin` script or an internal `src/index.ts` would assert a surface consumers never see), directory-form `main` resolves to its `index.*` like Node's own resolver, and a `types`/`.d.ts` condition never wins over a runtime one. A package that disappeared has no version to lint and is info, never an error. Typed shape-diffs (narrowed params, changed returns) remain Planned. Deterministic; entirely offline.

## 156. Lockfile Integrity & Build Reproducibility ★
**Status: Detected** (`no-unpinned-dependency`, opt-in) · ⚙️ Now

**Shipped (opt-in), the per-manifest slice:** `no-unpinned-dependency` (Security/warn, a whole-tree text-scan on `package.json`) flags a dependency that is not a registry semver range — a git ref (`github:…`, `git+…`, `…#ref`), a tarball URL, or a floating tag/wildcard (`*`, `x`, `latest`, `next`, `beta`, …) — because it makes the build non-reproducible from the registry + lockfile and, for git refs, is a moving-target supply-chain risk. Deliberately silent on normal semver ranges (a `1.x`/`^1` floats only within the lockfile's pin), prerelease *versions* (`1.2.3-beta.1` is not the `beta` tag), and intentional protocols (`workspace:`, `file:`, `link:`, `portal:`, `catalog:`, `npm:`, `jsr:`). The cross-file checks (manifest-vs-lockfile drift, missing/mixed lockfiles, install-time network fetch) remain Planned.

Whether a build is reproducible from the repo alone: `package.json` ranges that drift from the lockfile, dependencies pinned by tag or git ref rather than version, lockfile absent or stale relative to the manifest, mixed package-manager lockfiles in one tree, and install scripts that fetch at build time (unpinned network dependencies inside a "reproducible" build).

## 157. Queue & Topic Topology Mapping ★ Differentiator
**Status: Core** (`node-doctor queues`, aliases `topics`/`topology`) · ⚙️ Now

§29 checks a consumer in isolation; this maps the **graph**: who publishes to each topic/queue, who consumes it, and what falls out of that — orphan topics with a publisher and no consumer (messages into the void), consumers subscribed to topics nothing publishes (dead code that looks alive), payload-shape mismatches between publisher and consumer, and cycles where a consumer publishes back to its own upstream. The event-driven equivalent of the import graph, and just as revealing.

**Shipped as a command** (`queues`): kafkajs (`producer.send`/`sendBatch`, `consumer.subscribe` incl. `topics: […]`), amqplib (`sendToQueue`/`publish(exchange)`/`consume`), BullMQ (`new Queue` publishes, `new Worker` consumes), bull (a bare `new Queue` is producer+consumer-ambiguous and claims **nothing** — only a same-file `.add`/`.process` classifies it), NATS, MQTT, and Redis pub/sub (import + a pub/sub-suggestive receiver, so a cache client never counts). Every fact receiver is **traced to a client binding constructed from the library's own entry point** (`new Kafka(…)` → `.producer()`/`.consumer()`, `amqp.connect(…)` → `.createChannel()`, nats `connect(…)`, `mqtt.connect(…)`, `new Redis()`/`createClient()`/`.duplicate()`) — so an EventEmitter's `.publish(…)`, an RxJS `.subscribe(…)`, or a broker-*named* object in the same file yields nothing, no matter what the file imports — and a topic is recorded only from a **static string**. Claims degrade instead of guessing: any dynamic subscribe suppresses orphan-topic claims (it could be consuming anything) and any dynamic publish suppresses dead-consumer claims, while the map itself always renders; a same-file consume+publish of one topic is shown as a loop (info — a retry re-enqueue is legitimate), never judged. Payload-shape mismatch analysis remains Planned. Deterministic; topics and sites sorted.

## 158. Agent Context Hygiene ★★ Flagship
**Status: Core** (`node-doctor context`) · ⚙️ Now

**A new privacy surface that exists only because agents read your repo.** When an agent loads files into context, secrets, customer data fixtures, key material, and internal credentials go with them — to a model, and often to a log.

**Shipped as a command:** `node-doctor context` scans the on-disk working tree (including gitignored files — an agent reads the filesystem, not git) for files that must never enter an LLM context: `.env` files, private keys / key material, credential files (`.netrc`/`.pgpass`/GCP service accounts/an `.npmrc` with an auth token), database dumps, and config/data files carrying an embedded provider key (reusing the §68 detectors). It reports which are exposed (not yet covered by an artifact the agent honors) and, with `--write`, generates them idempotently — `.aiignore`, `.cursorignore`, and Claude Code `Read()` deny rules. Precision-first: **source code is never flagged** (an agent is supposed to read it; a secret in source is the AST scanner's job), benign fixtures and `.env.example` templates are excluded, and the generated fences are verified to actually cover what they flag (scan → write → re-scan reports zero exposed). Deterministic and byte-stable across runs. Hardened against an adversarial FP hunt (overloaded `.key` files, bare `.npmrc`, uppercase extensions, `dump.js`-style code all handled).

Scan for files that should never enter an LLM context (reusing the §68 secret detectors plus data-shaped fixtures and dumps), report which are currently exposed, and **generate the ignore files** — `.aiignore`, `.cursorignore`, Claude Code permission rules — that keep them out. Directly on-thesis, uncovered by anyone, and it fits the engine that already ships.

---

## Honest read: what to actually build

Twenty-eight more features do not make the product better; **three of them, built to the precision bar, might.** My ranking if I were choosing:

1. **§140 Cache-Key Correctness** — the highest-severity bug in this document (silent cross-tenant data leaks), reachable with today's taint engine, and demo-able in one slide. It also strengthens §114 multi-tenancy, which is currently held back on precision.
2. **§146 Validation Regex Correctness** — an auth bypass class that is genuinely everywhere, cheap to detect precisely (anchors are syntactic), and easy to keep false-positive-free by gating on security-decision context.
3. **§158 Agent Context Hygiene** — squarely the thesis, no competitor, reuses the secret detectors that already ship, and it produces an *artifact* (the ignore files), which makes it sticky rather than advisory.

Then, in a second wave: **§135 retry amplification** and **§152 async context propagation**, because both are pure call-graph reasoning on infrastructure you already have, and both catch outages nothing else catches. **§132 latency budgets** and **§143 data access maps** are the two that most change how people *use* the tool — they turn it from a linter into a system-reasoning instrument.

The rest is a menu. The discipline from the base catalog still governs: a false positive in §140 or §146 would be worse than never shipping them, and the invariants — deterministic offline core, local score, precision-first, AI-as-optional-layer — hold across §131–§158 without exception.
