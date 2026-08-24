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

**GraphQL resolvers are now recognized as request handlers.** Before this the engine was close to silent on a GraphQL backend: `collectRequestHandlers` knew method-call registrations, the Fastify object form, HTTP decorators and convention exports, and nothing about a resolver — so `no-query-in-loop`, `no-sync-io-in-request-path`, `no-large-json-parse-in-request-path` and `no-error-leak-to-client` all missed it entirely.

Two shapes are matched: a resolver map's `Query`/`Mutation`/`Subscription` fields, and the `@Query`/`@Mutation`/`@ResolveField` decorators. One extension point covering every request-path rule at once, which is why it was worth more than any single new diagnostic. `@ResolveField` matters most — it runs per PARENT ROW, so an N+1 there is worse than in a REST handler, not better.

Deliberately narrow: only the three root operation types, and only when the value is an object of functions. A type-level resolver map (`{ User: { posts() {} } }`) needs the schema to identify, and treating any capitalized key as a GraphQL type would sweep in every ordinary namespace object in the file.

**`no-body-on-bodiless-status` shipped.** HTTP defines 204, 205 and 304 as carrying no body, and Node enforces it — verified against a live server, the payload is silently discarded and the client receives `""`. Nothing fails on the server, which is why it survives: the breakage lands in the CALLER's codebase, where `await res.json()` throws `Unexpected end of JSON input` or the field being read is `undefined`.

Both halves of the trigger are literal — a numeric status and an actual body argument — so nothing is inferred. A **corpus sweep of 133,123 files** then found the one shape the unit cases had missed: `@adonisjs/cors` ends a preflight with `response.status(204).send(null)`, under a comment saying exactly that. A provably empty argument (`null`, `undefined`, `""`) is how people spell "no body" when the signature wants one, and it sends nothing — so there is nothing to discard and no claim to make.

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

**Mass assignment shipped** — `no-mass-assignment` (Security, error). Handing an ORM the entire request body lets the caller set **every column the model has**, not just the ones the form showed them: `POST {"email":"…","role":"ADMIN"}`. It survives tests, because a test posts the fields the form posts and every one is legitimate; it survives type-checking, because `req.body` is `any` and the ORM's `data` accepts a partial.

The rule asks exactly one question, and it is syntactic: does the request body OBJECT reach a write un-narrowed? It never asks what a FIELD MEANS — "this handler trusts `req.body.isAdmin`" would need to know that `isAdmin` is privileged, which is a claim about a name.

**The first version got the source model wrong, and a corpus sweep caught it: 743 findings across 106,851 files.** It treated any request-DERIVED binding as the body, so `mongoHelper.create(session)` — where `session` was assembled field by field from request fields — was reported. That assembled object is the CORRECT pattern this rule recommends, and a rule that punishes its own fix is worse than no rule. The value must now be the body *syntactically*: `req.body`/`.query`/`.params` written out, a binding whose initializer is exactly that, or a spread of either. No taint involvement at all. Re-swept: 743 → 0, with every true-positive shape still firing.

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

**Zip slip shipped** — `no-unsafe-archive-extraction`. An archive entry carries its own path, and that path is attacker-chosen: `join("/srv/app/uploads", "../../../etc/cron.d/pwn")` resolves to `/etc/cron.d/pwn`, pinned as an executable test rather than asserted. The upload arrives as a legitimate archive, the extraction succeeds, and the file lands outside the directory the application believes it owns.

Two shapes, and they are deliberately not held to the same standard:

- **The `tar` flag**, read out of the installed library's own source rather than its docs: `unpack.js` gates three separate protections on `preservePaths` — stripping `/` from absolute paths, rejecting an entry containing `..`, and refusing to extract through a symbolic link. Setting it re-enables the whole class at once, and it is a literal, so the claim is exact.
- **The hand-rolled join**, which needs all three of: an entry-path property, reaching a filesystem WRITE, with no containment check anywhere in the enclosing function. Any `relative`/`startsWith`/`isAbsolute` is a silence — whether that check is *correct* is not a claim this makes; that one exists is.

Only entry properties verified against a shipped implementation are matched: `fileName` (yauzl's source) and `path` (tar's `read-entry.js`). `adm-zip`'s `entryName` is documented but was not installed here to check, and this analyzer does not assert an API it cannot verify.

**Still absent at the basic tier, with reasons.** *XXE* is library-specific — Node ships no XML parser — and `libxmljs`'s `noent` semantics could not be verified offline. *CSRF protection*, *security headers* and *rate limiting* are all ABSENCE claims at project scope rather than facts at a call site, which is a different design from a per-file diagnostic and a different false-positive profile.

**`no-weak-crypto-parameters` shipped** — two literal options that weaken something already correct by default, neither of which produces an error, a warning, or a failing test.

Both premises were pinned as executable facts rather than asserted, and they rest on **different ground**, which the messages state:

- **A TLS version below Node's own default.** `tls.DEFAULT_MIN_VERSION` is `TLSv1.2`, and Node accepts a downgrade to `TLSv1`/`TLSv1.1` **without throwing** — verified. The same shape as `tar`'s `preservePaths`: an option that switches off a protection you already had. TLS 1.0/1.1 were deprecated by RFC 8996 and dropped by every major browser in 2020, and re-enabling one to accommodate a single legacy client downgrades *every* connection. The legacy `secureProtocol` spelling is matched too.
- **An RSA modulus below 2048.** Verified the other way: Node generates a 512-bit key **without objecting**, which is precisely why the floor has to come from the rule. This is a standards claim (NIST SP 800-57 retired 1024-bit RSA in 2013) rather than a runtime fact, and the message says so rather than letting a standards floor masquerade as an error Node would raise.

Both are literal-only — `minVersion: cfg.tlsMin` and `modulusLength: bits` are the config's business — and only an object passed as an ARGUMENT is judged, so a standalone profile fixture is not a live TLS context. Swept over 111,566 files: 0 findings.

**`no-mass-assignment` had an evasion hole, now closed.** All seven TypeScript assertion spellings bypassed it — `as T`, `as any`, `satisfies`, `!`, `<T>x`, aliased, and spread-of-cast — which left it close to blind on TypeScript, where `create({ data: req.body as UserDto })` is the idiomatic form and the assertion is exactly what makes the author confident the data was validated. The cause was the precision fix that removed 743 false positives: making the match exact let every erased wrapper through. The repair is the underlying fact rather than a patch list — a TypeScript assertion is erased at compile time, so `req.body as UserDto` IS `req.body`. Checked against the other taint-based security rules (SQL, exec, eval, SSRF, open redirect): none shares the hole, because they walk descendants. Re-swept: 133,123 files, 0 findings.

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
- **Wrong status code on error responses** — `no-error-response-with-success-status`. A caught
  exception reported with a 2xx, so `res.ok` is true, axios resolves instead of rejecting, APM
  and uptime checks record a success, and retry/circuit-breaker middleware never fire. The
  `status: false` in the body is read by none of them. Fires only where the status is *provably*
  2xx (a literal `status(200)`/`code(2xx)`, or none at all — Express, Adonis and Fastify all
  default to 200) **and** the payload evidences failure (it carries the caught error, an
  `error`/`errors` key actually holding one, or `success`/`status`/`ok: false`). Both conditions
  are required: a catch that recovers and returns real data on 200 is correct, and stays silent
  because its payload makes no failure claim. Excluded, each for a reason found in the corpus
  rather than imagined — GraphQL's `{ data, errors }` envelope (200 is what the spec requires),
  webhook and OAuth-callback handlers (a 2xx acknowledgement is deliberate), and string/template
  bodies (an HTML page for a browser, not an API error envelope). Measured on a 220,042-file
  sweep: 138 findings, every one in application controllers, **zero in `node_modules`** — the
  profile of a team convention rather than a library mistake.
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
- **Transactions (multi-write without a transaction)** — `no-untransacted-dependent-writes`.
  Outside a transaction every statement commits on its own, so if the second of two dependent
  writes fails, the first is already durable and nothing rolls it back — leaving a row the rest
  of the system believes cannot exist. Demonstrated at the driver level rather than asserted:
  the same two writes left **1 row behind without `BEGIN` and 0 rows with it**.
  Fires only on a pair where W2 **references the value W1 returned**
  (`workflowStep.create({ workflowId: workflow.id })`) — that reference is what proves the two
  are one unit of work; writes sharing no value are silent. The receiver must **prove Prisma**
  (a `prisma`-prefixed path segment, a `new PrismaClient()` binding, or an import from a Prisma
  module), never a name hint: the repo's own `DB_RECEIVER_HINTS` matches `client`/`conn`/`repo`
  and so returns true for all 20 SDK clients tested, including a real
  `retellRepository.createLLM` → `createAgent` pair and jsforce's `conn.sobject().create` →
  `.update`, both correct code. Silent on: a guarded W2 (a conditional refinement whose failure
  leaves a usable record), a destructive W2 (a compensating rollback), the same model twice (a
  status transition), a `tx`/`trx`/`queryRunner` handle or explicit `transaction`/`session`
  option, a nested closure, and test/seed/fixture trees. Disabled outright on projects using
  `cls-hooked`/`typeorm-transactional`/`nestjs-cls`, where a transaction is opened in
  AsyncLocalStorage with no evidence at the call site and lexical analysis is unsound.
  Measured: **3 findings across 2,106 Prisma producing-write sites in 595 files (0.14%)**, all
  three hand-verified in cal.com — a Workflow with zero steps, and an instant booking with no
  join token. *Currently Prisma-only; the Mongo/Mongoose equivalent is deliberately not shipped
  because a `this.someCollection` field cannot yet be proven to be a database.*
- Connection pooling (pool/client created per request).
- Duplicate indexes.
- Missing foreign keys.
- ORM misuse (see §15).
- Raw SQL misuse (unparameterized, unsafe raw helpers).

**Missing-index detection shipped**, as a section of `node-doctor schema-drift`. Both halves are already in the repository — the schema says what is indexed, the query says what it filters on — so the cross-check needed no new infrastructure, only for the Prisma parser to stop discarding index metadata.

**The leftmost-prefix rule is the whole precision story.** `indexedFields` records field-level `@id`/`@unique` plus the **leading** field of each `@@index`/`@@unique`/`@@id`, and nothing else. A composite index on `(tenantId, status)` serves a filter on `tenantId` and does **not** serve one on `status` alone — the rule every major engine follows. Recording every member of the list would have silently licensed exactly the scan this exists to find, and the real-world run proved it matters: `PrReview.status` sits inside an index and is still reported.

**It reports facts, not defects.** Nothing in either file says how many rows the table has, and on a small table a sequential scan is correct and cheaper than an index — so the section is framed as *"a fact, not a defect — worth a look where the table grows"*, the same way `supply-chain` presents copyleft. A **relation key** is a join rather than a single-column filter and is never reported (the nested scalar inside it still is), and `select`/`orderBy` are not filters.

Validated against a real Prisma project rather than only fixtures, since none of the usual corpus uses Prisma: 8 models over 49 files produced **3 findings, each confirmed against the schema by hand** — including a webhook path doing `findFirst({ where: { githubRepoId } })` on a column with no index.

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

**`migration-index-without-concurrently` shipped.** A plain Postgres `CREATE INDEX` holds a lock that blocks **every write** to the table until the build finishes. Measured on Postgres 14 with a 600,000-row table rather than quoted from the manual: a concurrent `INSERT` waited **3,093 ms** against a plain `CREATE INDEX` and **21 ms** against `CONCURRENTLY` — a factor of 147, scaling with the table rather than the migration. The migration succeeds either way, so nothing in CI or the deploy log marks it; the symptom is a write stall at deploy time that gets attributed to almost anything else.

Two guards matter more than the trigger. **A table created in the SAME migration is never reported** — it has no rows to scan and no traffic to block, and `CONCURRENTLY` would only forbid running it in a transaction. And **Postgres must be proven from the file**: `CONCURRENTLY` is Postgres-only syntax, so on MySQL or SQLite the advice would be impossible to follow; without positive in-file evidence of the dialect the rule says nothing, matching the migration module's stated bias toward silence.

Validated against 593 real migration files from cal.com: **20 findings**, and the guard proved itself inside a single file — `create_internal_notes_tables` creates `BookingInternalNote` and indexes both it and the pre-existing `Impersonations`, and only the latter was reported.

**Three more migration lock hazards shipped**, each measured against a live Postgres 14 rather than quoted. Five candidates were evaluated; two were rejected, and the measurements are why.

- **`migration-foreign-key-without-not-valid`** — validating a new foreign key inline holds a write-blocking lock on **both** tables for the whole scan. The parent is the part nobody expects: measured on a 600,000-row child against a 200,000-row parent, an `INSERT` into the *referenced* table — which the statement never names as its target — waited **2,065 ms**. `NOT VALID` makes the `ADD CONSTRAINT` catalog-only, and the later `VALIDATE CONSTRAINT` does the same scan under a lock that does not block writes.
- **`migration-volatile-column-default`** — and here the received wisdom is simply **wrong**. "Adding a column with a default rewrites the table" has been false since Postgres 11, and measurement shows the fast path is *wider* than "constant": it covers every non-VOLATILE default. Measured on 400,000 rows: `DEFAULT 5` did not rewrite and took **18 ms**; `DEFAULT gen_random_uuid()` rewrote and took **244 ms**. So the rule flags only genuinely volatile defaults, and `now()`/`CURRENT_TIMESTAMP` are deliberately absent — they are STABLE, take the fast path, and are the commonest default of all.
- **`migration-column-type-rewrite`** — the heaviest lock in the set, `ACCESS EXCLUSIVE`, which blocks **reads** as well as writes. Measured on 2.4M rows: the lock was held **2,464 ms**, a concurrent indexed `SELECT` waited **2,400 ms** against a 2.08 ms baseline, and the one statement emitted **401 MB** of WAL.

**The type rule's target list is the whole rule, and it is short because the file cannot see the current type.** The decisive experiment: two 400,000-row tables given the byte-identical statement `ALTER COLUMN c TYPE varchar(100)` — free at 19 ms from `varchar(50)`, a rewrite at 144 ms from `text`. Same bytes, opposite cost. So every target carrying a modifier is excluded, which means varchar widening — the commonest `ALTER COLUMN TYPE` in real migrations — is never reported. What remains are modifier-free targets where the only free source is the type itself, minus three near-misses with measured free paths in: `integer` (from `oid`), `inet` (from `cidr`), and `timestamptz` (from `timestamp`, but only under a UTC session — decided by a runtime GUC that is in no file).

**Rejected, with numbers.** `ADD CONSTRAINT … CHECK` and `SET NOT NULL` both take ACCESS EXCLUSIVE and scan the table, and both have real `NOT VALID`-style escape hatches — but `SET NOT NULL` overlaps the shipped `migration-add-not-null-without-default`, and neither cleared the bar once the overlap and the guard requirements were accounted for.

Validated against 593 real migration files from cal.com: **20 findings**, all from the foreign-key rule, spot-checked against the SQL — `BookingReference` referencing `Booking` in a migration that creates neither.

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
**Status:** unused/duplicate/circular detection and **license analysis** are **Core**; vulnerability scoring is **Planned** (optional network integration, off by default to preserve offline-first).

- Unused packages (declared, never imported).
- Duplicate packages / duplicate versions.
- Circular dependencies (module import cycles).
- Vulnerable packages (advisory feed / Socket.dev-style scoring, opt-in).
- Deprecated packages.
- Large dependencies (bundle/footprint flags).
- **License analysis** — a section of `node-doctor supply-chain`.
- **Version conflicts** — `no-conflicting-dependency-declaration` covers the one that is always a mistake; multiple installed versions of the same package are reported as facts by `supply-chain`.

---

# Part VII — Code Quality & Architecture

**License analysis shipped**, and it needed no network: every package's terms are declared in its own manifest, which the supply-chain walk already reads. It reports the license distribution, the packages under a copyleft license, and the packages that declare nothing at all.

Everything here is a DECLARED fact. The report never says you are violating anything — whether an obligation binds you depends on how you distribute, which a manifest cannot say — so copyleft is presented as *an obligation to decide about, not a defect*. Same discipline as §110's "declared AI assistance".

Two precision rules came from running it against real dependency trees rather than fixtures, and both would have produced wrong claims:

- **An SPDX `OR` is a CHOICE.** `jszip` ships `(MIT OR GPL-3.0-or-later)`; you take the MIT branch and owe nothing, so calling it copyleft is simply false. A dual license binds only when EVERY alternative binds; `AND` is the opposite, where one copyleft term is enough.
- **An absent `license` field is not "unlicensed".** The terms may sit in a LICENSE file the field never names, so that is checked before anything is said — and a `private: true` package needs no license at all by npm's own convention, which is usually the workspace's own package rather than a dependency.

**`no-conflicting-dependency-declaration` shipped.** A package declared in both `dependencies` and `devDependencies` reads like a harmless duplicate, and npm prints no warning for it. Measured against real npm rather than assumed, twice: with **different** ranges the devDependencies range wins (`^7` + `^6` resolves `semver@6.3.1`), and with **identical** ranges it still resolves as dev. In both cases the lockfile entry carries `"dev": true`, and after `npm install --omit=dev` the package is **absent from `node_modules` entirely** — verified by looking for the directory afterwards.

So the failure is production-only and total. Locally the package is installed, the tests pass, the types resolve; the deployed image runs `--omit=dev` and the first `require` gets `MODULE_NOT_FOUND`, for a dependency the manifest plainly calls a runtime one.

Scope is stated in the rule rather than left implicit: the text scan excludes `node_modules`, so it only ever reads FIRST-PARTY manifests — which is exactly where the behaviour was measured. A published package's own dual declaration is a different question, since a consumer never installs its devDependencies at all, and the rule makes no claim about it because it never sees one. Across eight projects: 0 findings in 27 first-party manifests, with 14 instances in their dependency trees correctly out of scope.

**Multiple installed VERSIONS of one package is not this rule's business**, and deliberately so — 28 of 482 packages in one real tree carry more than one version, which is ordinary npm behaviour rather than a defect.

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
**Status: Core** (`node-doctor architecture`, aliases `arch`/`layers`)

**Shipped as a command** (`architecture`): three questions answered from the project import graph. **Import cycles** are found exactly (Tarjan's strongly-connected components, iterative so a deep graph cannot blow the stack) — and a cycle is not a style opinion but a live runtime hazard: under ESM one module observes the other mid-initialization, giving an import that is `undefined` at module scope, a class extending `undefined`, or a temporal-dead-zone `ReferenceError` that appears only once the entry point changes and evaluation order flips; it also defeats tree-shaking. Cycles exit non-zero. **Layer violations** catch a service/domain module importing back *up* into routes (welding business logic to the transport, making it un-reusable and un-testable) and a route reaching *past* the service layer straight into a repository. **Hub modules** — files with very high fan-in, where every change is a blast-radius change — are reported as information only.

**Precision.** Cycles are a graph fact and always reported. Layer claims are opinion-shaped so they are gated hard: a file's layer is inferred only from an unambiguous directory segment (`routes/`, `services/`, `repositories/`, `infrastructure/`, …); a file matching none is unlayered and takes part in no claim; a file matching *two different* layers (`src/services/db/pool.ts`) is ambiguous and equally excluded. A project that does not use a layered convention therefore produces zero violations rather than a wall of noise. Deterministic: cycles normalized and sorted, violations and hubs sorted.

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
**Status: Core** for the data; **a `metrics` command was assessed and WILL NOT SHIP.**

Every per-module claim about findings is already derivable from `scan --json`: each finding carries its path, category, severity and tags, and the scoring weights are exported constants. Findings per directory, weighted points per directory, category mix, worst files — all of it is a `jq` away, and cycles and hubs come from `architecture --json`. A command that repackages existing JSON is not a feature.

**The real gap was a data gap, and it is closed.** Two emissions were missing, and without them a per-module view was impossible rather than merely inconvenient:

- **`project.files`** — per-file line counts (schema v3, additive). The scan summed them away, so a consumer could group findings by directory but had no denominator; "which module is worst" was unanswerable from the report.
- **`architecture.modules`** — every module's fan-in *and* fan-out. `hubs` deliberately cuts at a threshold and a top-10 slice, which makes it useless as a data source; both numbers were already in scope when the hubs were computed.

A per-module *score* is deliberately still not offered. `calculateScore` applies to any subset unchanged, but at 100 weighted-points/kLOC one Security error in a 60-line file scores 0/100 and is labelled critical — the same finding in a large project scores 99. Without a minimum-lines floor that is a false positive wearing a number, and choosing the floor needs a measured distribution nobody has.

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
**Status: Detected** (`dockerfile-runs-as-root`, `dockerfile-mutable-base-tag`, `dockerfile-secret-in-build-stage`, `dockerfile-copies-dotenv-into-image`)

**Shipped:** the engine reads Dockerfiles as a first-class input — a final stage running as root, a mutable base tag (`:latest`/a floating major) that makes the build irreproducible, and a secret baked into a build layer (where it survives in the image history even if a later stage deletes it). Each rule demands positive evidence the file IS a Dockerfile, so a docker-compose file or a shell script is never mis-analyzed. Layer-size/cache-order and multi-stage-optimization advice remain Planned.

**A dotenv copied into a layer** (`dockerfile-copies-dotenv-into-image`) is the newest, and it exists because nothing else can see it. A `.env` is gitignored by design, so every check that reasons about committed content passes cleanly — including §68's own `no-committed-env-secret`, which is `committedFilesOnly` — while the live credentials ship inside the image. `dockerfile-secret-in-build-stage` does not reach it either: that fires on an `ENV`/`ARG` whose *value* is key material, and a `COPY` carries no value in the Dockerfile at all. The Dockerfile is the only artifact where the leak is visible, and it is visible as a filename. Found at **17 of 224 `COPY`/`ADD` instructions across 35 corpus Dockerfiles**, naming files containing `OPENAI_API_KEY`, `GOOGLE_CLIENT_SECRET`, `JWT_SECRET` and a ClickHouse password. The source basename must match a positive allowlist (`.env`, `.env.production|prod|staging|stage|live|release`), so `.env.example`/`.env.template`/`.env.test`/`.env.local` never match and an unseen `.env.whatever` stays quiet. **Any stage counts, not just the final one** — restricting to the final stage would miss three real leaks where a builder copies the dotenv, a `RUN cp` launders the path, and the runner copies the directory, so no final-stage `COPY` ever names one. Templated sources and globs are undecidable from the file and stay silent.

Dockerfile optimization, multi-stage builds, root-user detection, image size, layer optimization, healthcheck presence, image security scanning.

## 24b. Date, Timezone & Locale Correctness
**Status: Detected** (`no-local-date-as-iso-datestring`, `no-unclamped-month-shift`)

**Shipped:** the first rule in a previously empty area of the catalog. `new Date(y, m, d)` builds an instant from **local** wall-clock components while `toISOString()` renders **UTC**, so on any host east of Greenwich, truncating to `YYYY-MM-DD` produces the PREVIOUS day. Measured under five timezones rather than argued: `Asia/Kolkata`, `Europe/Berlin` and `Australia/Sydney` all turn the month range `2026-08-01 .. 2026-08-31` into `2026-07-31 .. 2026-08-30`, while `UTC` and `America/Los_Angeles` are correct. The upper bound is the costly half — `new Date(y, m + 1, 0)` is the standard "last day of this month" idiom, and the emitted bound silently **excludes the last day**, so a month-to-date report quietly drops its final day every month.

Both halves must hold: a 2–3 argument construction (pinning 00:00 local) and truncation to exactly the date part (`slice(0, 10)`, `substring(0, 10)`, `split("T")[0]`, `.shift()`, array-destructuring, `replace(/T.*/, "")`). That truncation is the proof of intent — the author discarded the time, so the value is a calendar date. Silent on `Date.UTC(...)` (414 corpus uses, the correct idiom sitting next to a defect in the same codebase), on 4+-argument end-of-day constructions which are correct under a positive offset, on `new Date()`/parsed strings which are deliberate UTC, and on relative `setDate`/`setMonth`/`setFullYear` shifts which preserve the existing offset — 25 of those were flagged by an earlier pass, read, and the entire branch removed. Severity is `warn`, not `error`, because on a `TZ=UTC` or negative-offset host the string is correct and the host is not in the file.

**A month shifted without bounding the day** (`no-unclamped-month-shift`) is the second rule here, and it takes the branch the first one deliberately dropped. `setMonth` writes the month field and leaves the day alone, so a day the target month does not have spills into the month **after** the intended one. Measured by running it rather than argued: `new Date(2024, 0, 31)` plus one month is **Mar 2** (February skipped entirely), `new Date(2024, 2, 31)` **minus** one month is **also Mar 2** — subtraction lands two days later than it started — and `new Date(2024, 4, 31)` plus one month is Jul 1, because June has 30 days. There is no direction in which the idiom is safe, and it is not only a February problem. Unlike §24b's first rule this is timezone-independent, so there is no `tz:` gate.

The corpus population is **32 production sites across 8 codebases**, and the true positives are dates written to a database that then govern money: `credit_payment_service.ts` computes a service-period end and a credit expiry this way at five sites, `renewal_activation_service.ts` computes a new subscription expiry and returns it as `toISOString().split("T")[0]`, and an autopay controller computes the next charge date of a MONTHLY mandate — so a mandate taken out on the 31st charges on the 2nd. It never throws, the value is a well-formed date, and it is right for 27 days of every month.

What makes the rule shippable is that the same corpus contains **two hand-written correct implementations of the fix**, in production code by the same organization, and both must stay silent. `ReconciliationService.addMonths` normalizes the day to 1 before the shift (with a comment naming the trap) and clamps back with `setDate(Math.min(day, lastDayOfMonth))`; `RazorpayWebhookService.addMonths` shifts first and repairs after with `if (date.getDate() !== d) date.setDate(0)` (verified: Jan 31 plus a month, then `setDate(0)`, is Feb 29). So a literal day of 1–28 written **before** the shift, or any day write **after** it, silences the call — as do the two-argument `setMonth(m, 1)` form, a provable day from `new Date(y, m, <1–28>)` or from the literal text of `new Date("2026-03-01")` / `` new Date(`${month}-01`) ``, and one hop of copy propagation for the `monthStart.setDate(1); const monthEnd = new Date(monthStart)` idiom. Clamp checks are keyed by **binding identity**, not name, so a normalized `d` in one function cannot silence an unguarded `d` in another; that costs the rule non-identifier receivers such as `this.date`, which it does not claim.

`setFullYear` has the identical defect on Feb 29 (`new Date(2024, 1, 29)` a year forward is Mar 1 2025) and the identical fix. It was implemented, measured, and **cut**: 23 production sites, of which 16 were year-over-year reporting windows in a single controller where a one-day drift once every four years governs nothing, against 5 that mattered — and three of those five sit within four lines of a month site the rule already reports. The month case triggers on three days of most months; the year case on one day in 1,461. A test pins the exclusion so it is not quietly re-added without re-measuring.

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
**Status: Core** — every item below. The entry previously marked watch mode, HTML output and the auto-fix command as Planned; all three ship (`--watch`, `--html-out`, `node-doctor fix`), and the status was simply stale.

- Project scan (full).
- Watch mode — `--watch`.
- Diff scan (only findings introduced vs a base).
- Incremental scan (changed files / changed lines).
- Rule filtering (by rule, tag, category, framework).
- JSON output.
- HTML output — `--html-out`.
- Verbose mode.
- Auto fix command — `node-doctor fix` (see §37 constraints).
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
**Status: Core** for diff analysis, pre-commit hooks, and blame analysis; **Planned** for PR inline comments and pre-push hooks.

- PR scanning (inline comments on introduced findings) *(Planned)*.
- Commit scanning — `--diff`, `--staged`, `--changed-files-from`.
- Diff analysis (baseline delta) — `node-doctor delta`.
- **Blame analysis** — `node-doctor blame` (aliases `finding-age`, `age`).
- Pre-commit hooks — `node-doctor install --git-hook`.
- **Pre-push hooks** — `node-doctor install --git-hook pre-push`.

**The two hooks get deliberately different scans**, because they run at different rates. `pre-commit` stays staged-only: a commit happens dozens of times a day, and a full scan there is a tax people uninstall rather than pay. `pre-push` scans the whole project at `--blocking error`, because a push is rare and is the last point before the code becomes somebody else's problem. Both stay advisory and say in a comment how to enforce; a bare `--git-hook` behaves exactly as it always has.

**Blame analysis was filed as Vision and shipped without new infrastructure**, for the second time in this catalog: §159/§160/§163 brought `git-history.ts`, §110 added a porcelain blame parser, and that was the whole dependency. The parser now lives in `git-history.ts` and both consumers share it.

**Why age is the useful axis.** A finding list answers "what is wrong". It does not answer the question triage asks first — **"is this new?"** A hardcoded credential introduced last Tuesday is an incident; the same finding untouched for three years is debt, and they deserve opposite responses. `churn` ranks by where change concentrates and `drift` explains why a report moved; neither dates a specific finding.

**The precision story is one distinction.** `git blame` reports the commit that **last touched** a line, which is not the commit that introduced the finding — a reformat, a rename, or an unrelated edit re-attributes it, and a line moved wholesale by a refactor dates from the refactor. So every surface says "last touched", and an age is a **lower bound**. Claiming "introduced" would invent a precision blame does not have, exactly as §110 says "declared" rather than "written by". `-w` is passed so a whitespace-only reformat does not re-attribute, but that covers only the cheapest case.

A **shallow checkout suppresses the report entirely** rather than dating every finding to the graft commit — `actions/checkout` clones with `--depth 1` by default, so that is the common case in CI, not an exotic one. An uncommitted line is reported as uncommitted rather than dated, and a file git cannot blame yields an unattributed finding rather than a wrong one.

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
**Status: Core** (`node-doctor supply-chain`, aliases `deps` / `install-scripts`) for the offline slice; **Vision** for anything needing a feed

**Shipped: the two facts that need no network and no vulnerability feed.**

**Which dependencies run code when you install.** A `preinstall`/`install`/`postinstall` script executes arbitrary commands on every developer laptop and every CI runner before a single line of your code has run — the delivery mechanism for essentially every npm compromise of the last decade, and `npm ls` will not tell you which packages have one. Read from `node_modules`, because that is the only place the truth lives: the manifest declares ranges, and which version actually got installed (and whether *it* carries a script) is a fact about the installed tree. **When `node_modules` is absent the report says the check did not run** — never "no install scripts found", because those are different answers and only one is safe to act on.

**And only the hooks that actually run are counted.** npm does not execute `prepare` or `prepublish` for a package installed from the registry — those fire on publish, and on installs from git or a local directory. Measured by packing a manifest declaring all five hooks and installing it both ways: a tarball install runs `preinstall`/`install`/`postinstall`; a directory install adds `prepare`; `--ignore-scripts` runs nothing. This is most of the value of the check, because the ratio is brutal — across 14 real projects **705 of 730 declared hooks were dormant against 25 that execute**, and one project declared 178 while executing 3. So `prepare` counts only when the lockfile resolves that package outside the registry, and with no lockfile the source is unknown and unknown does not execute. Dormant hooks are still reported, as one trailing line rather than a wall, because "declares a postinstall-shaped hook" is worth seeing even when it never fires.

**Which dependencies did not come from the registry.** A lockfile entry resolved from a git ref or an http tarball skips the registry's immutability and integrity guarantees: the same lockfile can install different bytes tomorrow, and there is no signed provenance to check.

**Neither is an accusation.** A postinstall script is how `esbuild` fetches its platform binary and how `husky` installs a git hook. The report states what runs and where it came from, and the rendering deliberately avoids the finding vocabulary — no severity, no score — because "this package is malicious" is not a claim static analysis can make.

Typosquatting and dependency-confusion remain unshipped: both are edit-distance guesses against a popularity list, which is exactly the class of statistical claim this project has repeatedly found to be its own worst false-positive source.

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
**Status: Core** (`node-doctor openapi`, aliases `swagger`/`spec`)

Generate an OpenAPI/Swagger spec **from the actual routes, DTOs, and validators** — the inverse of the "missing spec" detection in §22. Keeps docs honest because they're derived, not hand-written.

**Shipped as a command** (`openapi`): emits an OpenAPI **3.1** document built from the route registrations themselves, using the same collector as `data-map` and `surface` so all three agree on what a route is. Per operation it derives **path parameters** (`/users/:id` → `{id}`, required), **query parameters** mined from the handler (`req.query.page`, `req.query["size"]`, and `const { include } = req.query`), **request-body presence** from a `req.body` read on a body-carrying method, **response status codes** from `res.status(N)`/`res.sendStatus(N)` literals, **security** from the middleware chain (an auth-guarded route gets a `bearerAuth` requirement plus the scheme component), plus a tag from the first concrete path segment and a readable `operationId`. With no flags the spec goes to stdout so it can be piped; `--json-out <f>` writes it and prints a coverage summary instead.

**Honesty over coverage.** The spec asserts only what is provable from source: a request body is described as a free-form object rather than an invented schema, a `res.status(variable)` contributes nothing (the operation falls back to a documented 200, and those are *counted* so the gap is visible), and a route whose path is not statically known is skipped and reported rather than guessed at. Duplicate registrations across files union their facts. Deterministic — paths sorted, methods in a fixed order — so the spec can be committed and diffed, which is what makes it impossible for the docs to drift from the code in CI. DTO/validator-derived response *schemas* remain Planned.

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
**Status: Core** (`node-doctor node-upgrade`, aliases `upgrade` / `node-version`) + **Detected** (`no-deprecated-node-api`)

**Shipped as a command, answering the two questions a team actually asks before bumping the runtime.**

**What breaks?** Which APIs this code calls are *gone* at the target major — not deprecated, gone, so the first request after the deploy throws. That half is delegated entirely to `no-deprecated-node-api`, and only its `end-of-life` entries count: a runtime deprecation warns, it does not break, and reporting it as a break is how a team decides not to upgrade for a reason that is not real.

**What can I delete?** Which dependencies the target runtime now ships natively. This is the dangerous half, and every entry carries three gates plus a caveat that always prints. A **version window, never a `>=`** — Node backports stabilizations to the previous LTS, so `--env-file` is stable on 22.21 and 24.10 but *not* on 23.x, and a single lower bound would clear a version where the built-in is experimental. **Call-site evidence** — `uuid` is replaceable only if every import is v4, `rimraf` only if no call passes options or a glob, `dotenv` only if nothing calls `parse`; the dependency alone is never enough, because the package almost always does more than the built-in. And a **direct dependency** — `glob` and `abort-controller` are transitively present in a huge share of tooling, and a transitive package is nobody's to delete. A browser or React Native target suppresses the `fetch`/`AbortController` entries outright.

**An audit of the shipped rule against Node's own `doc/api/deprecations.md` found it overstating four different ways, and every one is fixed.** `new Buffer()` was described as "deprecated and removed" when it has never been removed and is alive on `main`. `crypto.createCipher` was dated Node 10 — its *documentation-only* date — when the removal was Node 22. `util.isFunction` was dated Node 4 and removed in Node 23. And `url.parse` cited DEP0116, which Node later **revoked**. Each entry now carries its status — `end-of-life` / `runtime` / `application` / `documentation-only` — and only an end-of-life entry may say "this breaks when you upgrade". A fact table that overstates is a false positive with a version number on it. The table also grew from 13 entries to 39, and the receiver is now resolved through the *binding* rather than assumed from the local name, so `import nodeUtil from "node:util"` is no longer silently missed.

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
**Status: Core** for detection; **runtime-compatibility diagnostics assessed and WILL NOT SHIP as scoped.**

Package-manager and runtime detection (including Bun and Deno) is Core. The obvious next step — "this Node API does not work on your runtime" — was researched against both vendors' current compatibility pages and **rejected on three grounds**, each sufficient on its own:

1. **The capability token does not prove the runtime.** `bun` turns on from a lockfile or `@types/bun`, and Bun's single largest use is as a drop-in npm client *for apps that ship on Node*. A rule gated on it would tell the majority of Bun users their runtime is broken, when their runtime is Node. `deno.json` is stronger but still fails scoping — Deno supports package.json and npm specifiers, so one file at a monorepo root would poison every Node workspace beneath it.
2. **The fact source decays in the wrong direction.** Both compatibility tables are regenerated continuously by their vendors, and always toward *closing* gaps. A table baked into a released binary keeps saying "broken on Bun" after Bun ships it. Nothing in §83 has this property: Node's deprecation list is append-only history.
3. **The two runtimes differ on the same module in opposite directions.** `trace_events` is fully implemented on Bun and a stub on Deno; `cluster` works on Bun and is a stub on Deno; `v8` heap snapshots work on Bun and throw on Deno. Any merged "does not work on Bun/Deno" message is a false claim roughly half the time.

Shipping it would need a separate `runtime:bun` / `runtime:deno` token proven from code that *cannot* run on Node — a `bun:` import, a `Bun.*`/`Deno.*` global, or a start script running a source path under the runtime — never from a lockfile. That gate is buildable; the decaying fact table underneath it is not, so this stays unshipped rather than shipped stale.

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
**Status: Core** — including the provenance record and, now, the question it exists to answer.

- **Byte-identical, reproducible scans** — stable finding ids, deterministic sort order, and a content-hash cache probe keyed on the diagnostic set + config + capabilities. *(Core)*
- **Provenance record** — every report carries the tool version, the ruleset hash, the config hash, the capability set, and the exact `id:severity` list the hash is computed from. This had in fact shipped some time ago; the catalog entry saying otherwise was simply stale, which is its own small lesson about auditing status rather than trusting it.
- **`node-doctor drift --baseline <f> --current <f>`** (aliases `why-changed`, `explain-drift`) — the part that had genuinely never been built. **Nothing read the record back**, so the question it was recorded for still had to be answered by hand.

That question has one useful shape: **did the code change, or did the tool change?** A finding diff cannot tell you — `delta` reports six new findings identically whether they came from six new bugs or from one new rule, and a CI failure means something very different in each case. `drift` attributes the difference to the tool version, the ruleset (naming the rules added, removed or re-graded, which is why the artifact now records the list and not just its hash), the config, the **capabilities** (adding a Prisma dependency silently switches on every `requires: ["prisma"]` rule, and nothing about that looks like a tooling change), or the coverage. When none of those moved, it says the code changed — the one case where the finding delta means what it appears to mean.

Two honesty rules it keeps. A scan that did not finish is called out as making the comparison **unsound** rather than merely different: a finding absent from an incomplete scan was not necessarily fixed. And an artifact predating the recorded rule list reports that the comparison is **unavailable**, because treating a missing list as "unchanged" would be precisely the wrong answer.

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
**Status: Core** — `no-llm-output-in-sink`, `no-unguarded-llm-json-parse`. Model output reaching an executor, a SQL string, an HTML response, or an outbound fetch without validation — the mirror of §105, where the model is the untrusted source.

**The parse path shipped too, and it is the same untrusted-source argument one layer down.** A model returns TEXT; asking for JSON, even with a schema and a JSON mode, changes the odds and not the type. So `JSON.parse` on model output is parsing untrusted input, and every shape a model emits when it goes wrong throws — each of these measured rather than assumed: a response **truncated at the token cap** (`{"name":"Ada","bio":"a very long bi`), one wrapped in a ```` ```json ```` fence, one prefaced with "Sure! Here is the JSON:", a trailing comma, single quotes. Unhandled, the `SyntaxError` rejects the handler: a 500 at whatever rate the model happens to malform its answer, which is neither zero nor visible in the code. It is the failure mode `require-llm-token-limit` warns about, arriving one layer down.

The claim is "this parse is unguarded", so both halves are proven: the argument must be model output traced to a recognized call or an alias of one — a bare identifier is never assumed to be model text — and there must be no enclosing `try`/`catch`. Whether that handler is *good* is not a claim this makes; that it exists is. A `try` with only a `finally` catches nothing and still fires; a `try` outside the function does not catch a throw from a later invocation of it, and also still fires.

The model-taint model that §105 and §107 share now lives in one place (`collectModelBindings`, `isModelDerivedExpression`), extracted rather than copied — a duplicated taint definition is worse than a shared one that is wrong, because only the shared one gets fixed once.

## 108. System-Prompt & Secret Leakage
**Status: Core** — `no-system-prompt-leak`. A system-prompt binding echoed back to the caller, logged, or reflected in an error.

## 109. AI Cost & Runaway-Loop Guards
**Status: Core** — `ai-call-in-loop`, `no-unbounded-agent-loop`, `require-llm-token-limit`. An LLM call inside a loop: a latency, cost, and rate-limit blowup.

**The two remaining checks shipped.** `no-unbounded-agent-loop` is `ai-call-in-loop`'s sibling: there the loop's size is set by the input, here by nothing at all. A syntactically infinite loop — `while (true)`, `for (;;)`, `do … while (true)` — containing a proven model call, whose only exit is the model deciding to stop. A tool that keeps returning an error the model keeps trying to fix, or a success criterion it never satisfies, runs until the request times out or the spend cap does. The claim is deliberately the narrow syntactic one, *this loop counts nothing*: any counter at all silences it, because whether an existing counter is compared correctly is a different question and one this cannot answer.

`require-llm-token-limit` is **opt-in**, and the reason is worth stating: a token cap is a policy choice, not a language fact, so it does not meet the always-wrong bar the default-enabled rules are held to. Without one the ceiling is the provider's default for the model in use — a number the provider sets, changes, and varies per model, so the same code implicitly capped at 4k today is capped at 64k after a model swap. The claim is about an ABSENT key, so it is made only where every key is visible: an object literal, no spread. One claim was cut for being unverifiable offline — Anthropic's Messages API documents `max_tokens` as *required*, which would make its absence an error rather than a cost risk, but confirming that needs a live API call this analyzer cannot make.

---

# Part XXVII — AI-Native Code Governance

*If agents write the code, the codebase needs governance built for that fact.* Mostly **not shipped**: §111–§113 each need infrastructure the deterministic-offline core does not have — the original ticket/PRD, an AI rule-generation layer, or a signing/audit chain — and are flagged honestly rather than faked. **§110 is the exception, and it is worth recording why.** Its stated blocker was git-metadata attribution, and that arrived as a side effect of §159/§160/§163 three parts later. The lesson generalises: a Vision entry is a statement about what the engine could do *at the time it was written*, and the ones blocked on infrastructure rather than on undecidability are worth re-reading whenever the infrastructure moves.

## 110. AI-Authored-Code Trust Boundary ★★ Flagship
**Status: Core** — `node-doctor ai-attribution` (aliases `ai-trust`, `authored-by`).

**The blocker came off, and it came off without adding any infrastructure.** This was filed as Vision because it needs "git-metadata attribution"; §159/§160/§163 brought `git-history.ts` for their own reasons, and that turned out to be the entire dependency. No model is called, no network is touched, and the output is byte-identical across runs — so a flagship the catalog had written off as needing an AI layer is in fact deterministic and offline.

**What it measures, exactly.** Commits that **declare** AI assistance, through the conventions the agents themselves write: a `Co-Authored-By:` trailer naming a known agent identity — a git convention, not a vendor invention — or a generated-with marker in the body. `git blame` then attributes surviving LINES to those commits, so the report is about code still in the tree rather than about commits that happened.

**What it does not measure, and the distinction is the point.** A trailer is a **claim**, not proof. An agent that is not configured to write one leaves no trace; a human can add one by hand. So every surface says "declared", never "written by", and the number is stated as a floor on AI involvement rather than a measurement of it. Rounding that off to "34% of your code is AI-written" would invent a precision it does not have — the same failure §111 and §112 were rejected for.

**The report leads with the intersection, not the percentage.** "17% of this file was authored with AI assistance" is trivia; "this finding is on a line from a commit that declared AI assistance, and no human has touched it since" is a review decision. Blame therefore runs only over the files that carry findings — blaming a whole tree is minutes of work for a number nobody reads. A shallow checkout suppresses line attribution entirely and says so, because `git blame` would otherwise credit every pre-graft line to the boundary commit; the commit list survives. It exits 0 always: attribution describes provenance, it does not assert a defect.

Two bugs were found by running it against this repository's own history rather than a fixture. A format string whose first byte is a raw NUL makes `git log` fail outright, so the record separator had to move to the end as git's own `%x00`. And porcelain blame emits one header per LINE, with the first of each group carrying an extra `<count>` field — honouring that count double-counts every group, which is how the first version reported 50,195 attributed lines for a 330-line file.

### Scoped and rejected: four AI-security candidates

Recorded so the catalog does not re-litigate them. All four were prototyped and measured, not argued from first principles.

- **Indirect prompt injection** (retrieved content — a vector hit, a fetched page, a file — mixed into prompt instructions). The tempting sibling of §105, and it does not work. Caller-taint has a ROOT: `req`/`ctx` are conventional entry points taint can propagate from. Retrieval has none — it is defined by what a call MEANS, not how it is spelled — so the source set is either too generic (`query`, `search`, `invoke`, `json`, `readFile`: measured 4 false positives on 4 correct files) or too narrow (`similaritySearch` and friends matched 1 of 5 real retrieval spellings). Worse, the decisive fact is not in the file at all: two byte-identical prompts differ only in whether the corpus is user-uploaded or the company's own handbook, and that is fixed in the ingest pipeline. `mixesTaintIntoText` cannot be reused either — its literal-text requirement means "instructions and data got welded together" for caller data, but for retrieved data the surrounding literal text is usually the **delimiter**, so a hardened file fires. And there is no correct shape to steer toward: moving documents from `system` to a `user` turn restores no boundary, because the document's author was never the caller. §105 already covers the common case anyway, since caller taint propagates through the retrieval call.
- **A secret sent to the model provider.** The name regex would BE the finding here, where in `secret-in-env-fallback` it is only a filter on a defect an entropy check has already proven — a structural difference, not one of degree. Measured 7 false positives in 12 negatives with the house's own regex, because prompts are product prose in which "token" and "password" appear constantly and innocently. Decisive on its own: `openai.chat.completions.create` is syntactically identical whether it reaches api.openai.com, an Azure zero-retention tenant, Bedrock inside a VPC, or Ollama on localhost — so the harm is not merely unproven, it is **false** for a real slice of deployments.
- **A model deciding an authorization outcome.** The overlap with §107 is genuinely absent (measured — §107 needs taint in the sink's arguments, and a guard has it only in the condition), so this would have been new coverage. It fails on the second half: "this branch does something privileged" is not a syntactic property. Four oracles were built and measured; the only zero-false-positive configuration fires exclusively on a hardcoded `DELETE FROM` literal, which describes a test fixture.
- **A streamed response with no error path.** Neither half is an always-wrong fact. Verified by running it: `for await` installs its own `error` listener and destroys the stream on failure, so the unhandled-`error`-event argument that justifies `no-missing-stream-error-handler` provably does not apply. What remains is an ordinary promise rejection, handled in the route-registration file — cross-file, and forbidden.

**The pass shipped nothing and was worth running**: it found two false positives in already-shipped default-on rules, both now fixed and recorded in the CHANGELOG.

---

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
**Status: Core** — `node-doctor impact <files> | --diff`. Walks the import graph backward from the changed files to every transitive dependent, marks the ones containing request-handler code, and reports the blast radius (human + `--json`). Deterministic reachability, cross-package in a workspace. The handler marker is a *shape* match (`(req, res)`), so it is labelled as such rather than as a proven route count.

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
**Status: Detected** (`no-unhandled-pipe-error`, opt-in)

**Shipped, the resource-leak slice:** `no-unhandled-pipe-error` (Reliability/warn/high) flags a `.pipe()` whose source has no `error` listener. `.pipe()` does not forward errors and does not destroy the destination, so when the source fails — a disk read, a socket reset, corrupt gzip input — the destination is left open: a leaked file descriptor and a response that never ends, hanging until the client times out. And since the source is an EventEmitter, an `error` with no listener at all is re-thrown as an uncaught exception. It is the canonical "passes every test, falls over in production" defect, because the happy path never emits `error`.

Precision: `.pipe()` is also RxJS's operator-composition method, so the source is never assumed — it must be provably a Node stream (a binding or inline chain rooted at `createReadStream`/`createWriteStream`/`createGzip`/`new PassThrough`/…). The rule stays silent whenever an error path might exist: an `.on("error")`/`.once("error")` on that binding anywhere in the file (registration order does not matter), a handler attached inline in the chain, a `pipeline(...)` wrapper (which handles teardown), a dynamic event name, or the stream escaping into a helper that could attach the listener. Write-side backpressure (ignoring the `false` return of `.write()`) remains Planned.

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
**Status: Detected** (`no-bigint-precision-loss`, `no-tofixed-as-number`) · ⚙️ Now

The quiet data-corruption class at the JSON boundary: `BigInt` (or a 64-bit DB id) serialized into a JS number and silently losing precision above 2^53, `Date` objects crossing a boundary and becoming strings that are then compared as dates, `undefined` vs `null` asymmetry through `JSON.stringify`, circular references that throw only on a rare code path, and `Decimal`/`NUMERIC` columns coerced to float on the way out.

**Shipped:** `no-bigint-precision-loss` (Bugs/warn/high) flags `Number(x)`/`+x`/`parseInt(x)` where `x` is a provably-BigInt value (a `123n` literal, a `BigInt(...)` call, or a binding to either) — the exact `2^53` precision-loss coercion. It stays silent on `String(bigint)`/`.toString()` and any operand it cannot prove is a BigInt (including a catch-parameter that shadows an outer BigInt const — the scope resolver now models `catch` bindings). The remaining sub-classes (Date/undefined/Decimal boundaries) are still Planned.

**Shipped:** `no-tofixed-as-number` (Bugs/**error**/high) takes the coercion from the other direction — a *string* used where a number was meant. `Number.prototype.toFixed` returns a **string**, which is its entire purpose and the half everyone forgets, so `+` concatenates. Verified by running each form: `(100).toFixed(2) + (18).toFixed(2)` is `"100.0018.00"`, `(1.5).toFixed(2) + 5` is `"1.505"`, a `sum` seeded at `0` becomes `"018.00"`, `items.reduce((a, i) => a + i.price.toFixed(2), 0)` is `"01.002.00"`, and `(100).toFixed(2) === 100` is **always false**. Nothing throws; MySQL will coerce `"100.0018.00"` into a DECIMAL column on the way in, so the corruption surfaces later as a total that does not add up rather than as an error anyone can trace. The leading zero is the tell.

The claim at every firing shape is a fact about the language, not an inference about the data: this operand is a string, the other is *provably* a number, and `+` on that pair concatenates. Two clauses only — a `+`/`+=` whose other operand is provably numeric (a numeric literal, an arithmetic expression, a `Number`/`parseInt`/`parseFloat` call, a unary `+`/`-`, a binding initialized to a numeric literal, or a `reduce` accumulator with a numeric seed), and `===`/`!==` against a numeric literal. Two formatted operands also count, since digits jammed together with no separator are meaningless as display. `==`/`!=` and the relational operators are **excluded** because they coerce and therefore work — verified: `(100).toFixed(2) == 100` is `true` and `(100).toFixed(2) > 99` is `true`, so reporting either would be reporting correct code. Silent on display formatting (a string literal or template operand, and template interpolation, which is not a `+` at all), on the standard unwraps (`Number(...)`, `parseFloat`, `parseInt`, unary `+`), and on any operand merely *unknown* — a bare identifier, a member read, an arbitrary call — because it could be a string label, and then the concatenation is correct. `toString()` is deliberately not treated as a formatter: its name says what it returns, so concatenating it is plausibly deliberate. One hop of indirection is followed (`const t = tax.toFixed(2); … subtotal.toFixed(2) + t`), keyed by **binding** rather than name and requiring `const`, because that is how the shape is actually written. `toPrecision` and `toLocaleString` are included, and the latter is worse — it inserts group separators too (`(1234.5).toLocaleString() + 1` is `"1,234.51"`).

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

---

# node.doctor — Features (Horizon / §159–§184)

A fifth extension. Everything here is **net-new** against §1–§158 — checked against all four prior halves so nothing restates an existing rule or command. Same maturity legend (**Core** / **Detected** / **Planned** / **Vision**), the same **⚙️ Now / 🔧 Needs depth / 🛰 Needs infra** buildability tags, and the same invariants (deterministic + offline core, local score, precision-first, AI-as-optional-layer).

> **What "new" means at 158 sections.** The catalog already owns injection, event-loop, the data-access graph, the queue graph, the export/route surfaces, the AI-security pack, and the agent loop. The whitespace left is in **six directions the analysis has not pointed yet**: the *code-review dimension* (git-history and diff-shape reasoning), the *human/process dimension* (what the code implies about how the team operates), the *negative-space dimension* (what is conspicuously **absent** rather than present), the *temporal dimension* (how a property is trending, not just its current value), the *test-and-contract dimension* (analyzing the tests as first-class code), and the *cross-artifact dimension* (code vs. everything around it — docs, comments, types, config, i18n). Each is a lens, not a rule pack.
>
> **New parts:** XXXVIII Review & Change-Shape Intelligence (§159–§163) · XXXIX Negative-Space & Absence Detection (§164–§168) · XL Temporal & Trend Analysis (§169–§172) · XLI Test-Suite & Contract Analysis (§173–§177) · XLII Cross-Artifact Consistency (§178–§181) · XLIII Operational & Human-Factor Signals (§182–§184).

---

# Part XXXVIII — Review & Change-Shape Intelligence

*Every prior part analyzes a snapshot. This part analyzes the **diff** — the shape of a change and the history behind a line — which is the dimension a human reviewer actually operates in and no static snapshot can see. It reuses the baseline-delta machinery (§87) but reasons about the change itself rather than the findings it introduced.*

## 159. Suspicious-Change-Shape Detection ★★ Flagship
**Status: Core** (`node-doctor change-shape`, aliases `diff-shape` / `risky-edits`) · ⚙️ Now

**Shipped as a command.** Some edits deserve a second pair of eyes because of their *shape*, regardless of whether the code is correct — and the reviewer has no way to spot them in a 400-line diff. `change-shape` reads the diff itself and reports four shapes:

- **A `.env.example` key removed.** Every developer who clones tomorrow is missing a variable nobody told them about, and the failure surfaces at runtime rather than at build time. A key *renamed* (removed here, added there) is not a removal and is silent.
- **A dependency un-pinned.** A pinned or ranged spec replaced by `latest`/`*` or a git ref: the build stops being reproducible, and a compromised release lands without a code change. Only a 1:1 hunk on the *same* dependency name counts — adding a floating dependency is a different thing, and `no-unpinned-dependency` already reports it as a finding.
- **A very small edit to the authentication path.** Three lines or fewer, at least one of them real code (blank lines, comment-only lines and pure import moves are stripped *before* counting, or the shape fires on every doc typo). This is the shape most changes to a security boundary actually take, and the one a reviewer skimming a large diff is likeliest to wave through.
- **A migration edited alongside feature work.** The two have different revert semantics: reverting the commit takes the schema change with it, and the schema change is usually the half that cannot simply be undone once it has run.

**It emits no findings and it does not score.** The output vocabulary is deliberately a third one — *review priority*, not severity — because "this edit is unusual" and "this code is wrong" are different claims, and conflating them would make every finding in the tool mean less. It is also distinct from §90's PR risk, which computes one aggregate number from introduced findings and a file count and never sees a path, a line or a diff.

Shapes that cannot be decided from the diff text were **cut rather than approximated**: "this character class got wider" is regex-language containment, which is not decidable by text comparison; "the auth check got weaker" needs both sides parsed and analyzed, which is exactly what §87's baseline delta already does properly; and an N≠M hunk has no sound line pairing, so nothing is reported for one. Generated files, lockfiles and minified bundles are excluded, or a single bundle rebuild would dominate every report. "I could not read the diff" and "nothing suspicious changed" render differently and exit differently.

The original framing of this section: some diffs are risky by their *shape*, independent of the code. A one-line change to an auth middleware. A migration file edited in the same commit as unrelated feature work. A `.env.example` key removed. A security-relevant regex loosened (an anchor deleted, a character class widened). A permission check turned from `===` to `includes`. A dependency version un-pinned.

Match the **diff hunk** against a catalog of shapes that warrant a second look and raise the change's review priority — the human equivalent of "this line is fine but this *edit* deserves eyes." Distinct from §90 (which scores the PR's aggregate risk); this flags the *specific hunk* and says why. Pure diff analysis over data CI already has.

## 160. Line-Age & Churn-Weighted Risk ★ Differentiator
**Status: Core** (`node-doctor churn`, alias `hotspots`) · ⚙️ Now

**Shipped as a command.** Static analysis only ever sees the current snapshot, so a bug in a line written three years ago and never touched reads identically to one in a line rewritten four times last month. Git knows the difference and the log is already on disk. `churn` reads it and adds two things the snapshot cannot: **findings re-ranked by where change concentrates** (churn is where regressions cluster, and where someone is actively working), and **refactor magnets** — source files whose change rate sits far above the project's own baseline.

**The ranking cannot produce a false positive, by construction** — `weightByChurn` returns a *permutation* of its input, so the worst failure mode is a less-useful ordering, never a wrong claim. The **magnet list** needed a fix an adversarial hunt found: in a shallow checkout (`actions/checkout` clones `--depth 1` by default) every file has exactly one commit, so every file tied at score 100 and the whole source tree was named a hotspot. Relative rank is meaningless without absolute evidence beneath it, so a magnet now requires an unshallow repository with real history (≥ 10 commits scanned) *and* real churn in that file (≥ 3 commits). Too thin a history suppresses the claim and says why, while ranking continues to work.

The same hunt found the join silently failing on a subdirectory scan: `git log` prints repository-root-relative paths while findings are scan-root-relative, so `node-doctor churn packages/api` matched nothing and weighted every finding at 0 — while still reporting itself as available, which is the failure mode that looks exactly like "this code never changes". Paths are rebased with `git rev-parse --show-prefix`, and history outside the scanned directory is excluded rather than mis-attributed.

Scoring normalizes volume, author spread and recency against the project's own distribution — an absolute "10 commits is a lot" means nothing across repositories of different ages. Recency is measured in **commits-ago rather than days**, so the same repository at the same commit scores identically forever and the output stays deterministic. Magnets exclude what churns *by design* (docs, lockfiles, generated artifacts like the rule registry or the config schema): "you should split CHANGELOG.md" would be pure noise. With no git, no repository, or no history, every score is 0 and the ranking degrades to the analyzer's own order — refusing to run outside a checkout would be worse than quietly knowing less.

A bug in a line written three years ago and never touched is different from a bug in a line rewritten four times last month. Pull `git blame` and commit frequency per file, and **weight findings by churn**: high-churn code near a finding is where regressions cluster, and a finding in a hotspot that many hands have edited is likelier to be real and likelier to matter. Also surfaces "refactor magnets" — files whose churn is so high they are begging to be split. Needs only the git log, which is on disk.

## 161. Fix-Regression Detection (Boomerang Bugs) ★★ Flagship
**Status: Core** (`node-doctor ratchet check`) · ⚙️ Now

**Shipped.** The infra it was waiting on already existed: the ratchet (§87) persists position-independent finding identities (`evidenceKey`) in a committed sidecar and already detected when accepted debt disappeared. Schema v2 adds `resolvedHistory` — every finding this project has been observed to fix, with the date — so a finding that returns is reported as a **regression**, not merely as new debt:

```
⟲ 1 finding(s) REGRESSED — previously fixed, and back:
    no-sql-template-interpolation · src/a.js:2 (fixed 2026-03-11)
```

**Precision: "absent" is not "fixed."** An adversarial hunt found seven ways a finding vanishes without being fixed, each of which wrote a *permanent* false "previously fixed, and back" claim into the committed file. A resolution is now recorded only when it is proven: the scan must have run the **same ruleset** (the hash is persisted — a `--ignore-tag`, a config change, or a narrower diagnostic set no longer counts as a fix), the scan must have **completed** (a parse failure means the file taught us nothing), **no copy of the key may survive** in the current findings, and the finding must not have been **suppressed** — an inline `node-doctor-disable` directive removes a finding from the report exactly as a repair does, but it is an acknowledgement of debt, not payment of it, so `ScanReport` now carries the suppressed evidence keys and the ratchet excludes them. When the evidence is insufficient the comparison still reports pass/fail but declines to write history, and says so. Identity is evidence-based, so a line shift, a reformat, or moving the code never resurrects a finding; still-accepted debt is absolved by the multiset pool before the regression check; a malformed history rejects the whole file rather than fabricating a claim; the newest resolution is never evicted by the cap that recorded it; and `ratchet init` carries the fix record forward, since re-baselining replaces the accepted set, not the knowledge of what was once repaired. `compareToRatchet` stays a **pure function** — the CLI owns the clock — so the comparison is deterministic and testable. A v1 ratchet loads unchanged (empty history) and is only rewritten when the ratchet genuinely tightens, so upgrading never churns the committed diff. History is capped at 500 entries, newest-first.

The most demoralizing bug is the one you already fixed. Track finding identities (§104) across the project's history and detect when a finding **reappears at a location where it was previously resolved** — the fix was reverted, lost in a merge, or reintroduced by a copy-paste. "You fixed this SQL injection in March; it's back." No tool closes this loop, and it is the single most trust-building signal an analyzer can send.

## 162. Commit-Coupling & Hidden-Dependency Detection ★ Differentiator
**Status: Vision** · 🛰 Needs infra (history mining)

Two files that are *always changed together* have a dependency the import graph cannot see — a shared assumption, a parallel data structure, a config-and-code pair. Mine commit history for files that co-change far more often than chance, then flag a PR that touches one without the other: "94% of changes to `pricing.ts` also touch `pricing.test.ts` — this PR doesn't." Catches the logical coupling that structural analysis misses entirely.

## 163. Blast-Radius-Aware Review Routing ★
**Status: Core** (`node-doctor review`, alias `routing`) · ⚙️ Now

**Shipped as a command.** "Who should review this?" is normally a guess, and the guess errs the same way every time: a one-line change to a leaf draws the same reviewers as a one-line change to the module forty routes depend on. The import graph already knows which is which and CODEOWNERS already knows who owns what — `review` joins them.

For a change set (explicit paths, or `--diff <base>` / `--staged`, resolved exactly as `impact` does) it reports the **blast radius** (§120: transitive dependents and the handler-bearing files among them), the **reviewers** — owners of the changed files *and* of everything downstream, so the people whose code this can break actually see the PR — any **hub module** touched (§33), and a **review level** (light / standard / senior).

**The level is a function of counted facts, never taste**: reach ≥ 5 makes it standard, reach ≥ 25 or any hub module makes it senior. Every threshold that fired is printed alongside the verdict, so an escalation can be audited rather than trusted.

Handler-bearing dependents raise a light review to standard and stop there. They used to force a *senior* escalation at ten of them, and an adversarial hunt showed why that was wrong: request-handler detection matches the `(req, res)` **shape**, which a middleware factory has as surely as a route does, so the escalation could be driven entirely by non-routes. A senior review is a claim on someone's time and is now made only from exact graph facts — reach and hub fan-in. The field is named `handlerBearingFiles` for what it actually counts; `routesAtRisk` remains as a deprecated alias for existing JSON consumers.

Like §160 it emits no findings and suppresses none — it routes attention. And a changed file the graph does not contain is reported as **unknown reach, never zero**: "I could not see this change" and "this change is safe" must never render the same.

Combine the blast-radius graph (§120) with ownership (§89): a change to a low-fan-in leaf gets a light touch; a change to a hub module (§33) that 40 routes depend on gets flagged for senior review and notifies every affected owner. Turns "who should review this?" from a guess into a graph query.

---

# Part XXXIX — Negative-Space & Absence Detection

*Every rule so far fires on something that **is** in the code. This part fires on what is conspicuously **missing** — the far harder and far rarer capability, because absence has no AST node to match. The engine's cross-file reachability makes a specific, precise version possible: "this pattern is present N times and absent once" is a real, low-false-positive signal.*

## 164. Peer-Consistency Anomaly Detection ★★ Flagship
**Status: Detected** (`no-peer-inconsistent-handler`, opt-in) · 🔧 Needs depth for the general form

**Shipped as the one instantiation that can be made precise.** The idea is the most valuable in this document — the codebase states its own convention nineteen times, so the twentieth handler that breaks it is a finding no fixed ruleset could anticipate. It is also the most dangerous, because "19 of 20 siblings do X" is a *statistical* claim, and every statistical claim in this project's history is exactly where its false positives came from.

So it ships as one narrow, fully-fenced rule rather than a general clustering engine. `no-peer-inconsistent-handler` fires when a route handler skips the wrapper (`asyncHandler`, `catchAsync`, …) that its peers on the same router all use — an unwrapped async handler that rejects never reaches the error middleware, and on Express 4 the request hangs until the client times out.

**The gates, and what an adversarial hunt taught about each.** The hunt confirmed **fifteen** ways the first version was wrong, and every one traced to the same root: the population was not actually provable. The corrected model:

- **The receiver must be a proven Express router**, bound from `Router()` or `express()` in the file. Without that the rule fired on Koa, on Fastify, and on anything with a `.get(path, fn)` shape — an HTTP client, a cache — while asserting Express semantics false for every one of them.
- **The group is keyed on the resolved binding, never the name.** This was the worst finding. `router` is the most common identifier in Express code, so grouping by name merged every `const router = Router()` in a multi-factory route file into one population — and in the hunt's sharpest repro, four factories holding 3+3+3+1 routes produced a *fabricated* population of ten in which no individual router had enough routes to qualify at all. The flagged route had zero peers. A member path (`api.v1.get(…)`) is excluded for the same reason: two provably different routers reduce to one root name.
- **Minimum group size 10**, because at 90% conformity a smaller group can never produce a deviant — the documented "5" was arithmetic that could not happen.
- **Conformity ≥ 90%**, so a 6-vs-4 split, which is a codebase mid-migration, says nothing; two competing wrappers are not one convention and are silent.
- **The wrapper must be a wrapper**: a named call taking exactly one argument that is a function. `makeHandler(db, path)` is a handler *factory* — a perfectly good convention that produces the handler rather than wrapping one — and reading it as an error wrapper turned every factory-style router into a wall of findings. A decorator taking options (`cache(60)(fn)`) fails the same test.
- **The outlier must be provably unwrapped and provably able to reject.** A bare identifier may be wrapped where it is defined; a *synchronous* handler cannot reject; and a handler whose whole body is a `try`/`catch` — the webhook receiver that must always answer 200 — cannot reject either. All three are excluded from the population entirely rather than counted as violations.

Reported at `confidence: medium` and opt-in, because it is strong evidence rather than proof — the one rule in the catalog where that distinction is stated in the metadata. Zero findings across this project's own 426 files.

**Deliberately not done: the same reasoning applied to a missing middleware** (`requireAuth` on 19 of 20 routes). That version has legitimate outliers *by design* — the login route, the health probe, the webhook receiver — and "everyone else authenticates" is precisely the wrong thing to say about the login endpoint. A wrapper has no such exception: if nineteen handlers need their rejections routed, so does the twentieth. The general clustering form (any structural pattern, any peer group) still needs the pattern-clustering depth this section was originally filed under.

The most powerful absence signal: **19 of 20 sibling handlers do X; the 20th doesn't.** Nineteen route handlers wrap their body in `asyncHandler`; one is bare. Every repository method filters by `tenantId`; one forgot. Every mutation invalidates its cache; one skips it. Cluster structurally-similar code (same directory, same shape, same role) and flag the **outlier** against its own peers — the codebase becomes its own rule set. This is learned-from-the-project linting with zero configuration, and it catches the exact class of bug that a fixed ruleset never anticipates because the "rule" is local to this codebase.

## 165. Missing-Symmetry Detection ★ Differentiator
**Status: Detected** (`no-unreleased-resource`, opt-in) · ⚙️ Now

**Shipped as a diagnostic — and deliberately NOT as the paired-verb checker this section originally described.** A pooled Postgres client checked out and never returned is the canonical silent outage: the pool has ten clients, ten requests take an error path that skips `release()`, and the eleventh request — and every request after it — waits forever for a connection that is never coming back. Nothing crashes, nothing logs, the service simply stops answering.

The obvious design is a table of verbs (`acquire`/`release`, `open`/`close`, `lock`/`unlock`). That design is a false-positive machine, and this project has paid for that lesson repeatedly: `close` is files, modals, dropdowns and RxJS subjects; `end` is `res.end()` on every Express route ever written; `connect` is React-Redux; `release` is semver. **A verb is a word, not a contract.**

So `no-unreleased-resource` never guesses from a name. Every firing is anchored to a **documented library contract, proven by binding from the import statement down**: the package is imported in this file (under whatever local alias), the receiver is bound from that import (`const pool = new Pool()`), the acquire is the contract's method on that receiver, and the contract's release appears nowhere in the binding's lifetime. v1 covers `pg` (`pool.connect` → `client.release`), `mongodb` (`startSession` → `endSession`), `@opentelemetry/api` (`startSpan` → `end`) and `async-mutex` (`acquire` → the returned releaser). Growing that table is cheap; guessing at it is not.

Three silences complete the model. **Escape**: any use of the binding other than `binding.<prop>` — returned, passed, stored, aliased, spread — means the release may happen out of sight, so the rule says nothing (a whitelist, not a list of known escapes, because an enumeration always misses one). **Lifetime**: only a resource acquired inside a function is judged; a module-scope handle is meant to outlive the module body. **Any mention of the release counts** — in `finally`, in `catch`, in a nested callback, chained inline — because proving the release runs on *every* path needs a control-flow graph this engine does not have, while proving it is *absent* needs nothing but syntax. Zero findings across this project's 410 source and test files.

The original wording of this section, for reference: operations that come in pairs, where one half is present and the other absent: `acquire` without `release`, `subscribe` without `unsubscribe`, `open` without `close`, `lock` without `unlock`, `startSpan` without `end`, `beginTransaction` without a matching commit/rollback on every path, `setInterval` captured but the clear-handle dropped, an event listener added in a constructor with no teardown. Extends the memory-leak family (§13) into a general symmetry checker keyed on known-paired verbs.

## 166. Unreachable-Guarantee Detection ★
**Status: Detected** (`no-floating-promise-in-try`, `no-unreachable-cleanup-after-exit`, both opt-in) · ⚙️ Now

**Shipped as two diagnostics — the two slices of this idea that are provable without a control-flow graph.** The other sub-cases named below were dropped on inspection rather than shipped soft: "a `finally` after a `return`" is semantically backwards (a `finally` after a return in the `try` is exactly what `finally` is for), "a retry after a `throw`" is already `no-unreachable-code`, and "a validation downstream of an early return" and "a default parameter always supplied by callers" both require proofs — every-path reachability and whole-program call-site enumeration — that this engine does not have. Shipping any of them would have meant guessing.

**`no-floating-promise-in-try`** (Bugs/warn/high, opt-in) — a `try`/`catch` that structurally cannot catch what it appears to guard. An `async` function never throws; it returns a promise and signals failure by rejecting it. So `try { sendReceipt(order); } catch (err) { … }` is not error handling: the call returns immediately, the `try` completes normally, and the later rejection finds no handler on the stack — Node raises `unhandledRejection`, which terminates the process by default. It is the worst kind of defect, because it *looks* handled: the reviewer sees a try/catch and moves on.
Precision: the callee must be a plain identifier that resolves **through the scope chain, in this file**, to a declaration marked `async` — a `const` binding or a function declaration, never a parameter, an import, a method call, or a `let` that may hold something else by the time the line runs. The result must be discarded (awaited, returned, assigned, `void`-ed and `.catch`-chained are all deliberate and silent), and the statement must sit in the `try` block with no function boundary in between. The message names the specific call rather than calling the catch dead — the `try` may be protecting its other statements perfectly well.

**`no-unreachable-cleanup-after-exit`** (Bugs/warn/high, opt-in) — statements after `process.exit()`, which never run. `no-unreachable-code`'s terminator table is keyed on statement *type* (`return`/`throw`/`break`/`continue`), so it structurally cannot express a call-shaped terminator, and extending it would shift a default-on rule's findings and evidence keys for every existing user. The dead statements here are almost always the cleanup — `server.close()`, `await db.end()`, `logger.flush()` — so the consequence is truncated responses on every deploy and log lines that stop just before every incident, not untidiness. It reuses `no-unreachable-code`'s hoisting and TypeScript-erasure exemptions verbatim from the same exported helper, so the two can never drift apart. **It found a real one in node.doctor itself on its first run**: the Windows UTF-8 console fix sat below `process.exit()` in `exitAfterFlush` and had never once executed.

Both are silent across this project's 410 source and test files.

The original wording of this section, for reference: protective code that can never run: a `finally` after a `return` in every `try`/`catch` path, a fallback branch made dead by an earlier total match (the sibling of §58), a retry after a `throw`, a default parameter shadowed by a caller that always passes the argument, a validation step downstream of an early `return` that always precedes it. Safety code that gives false comfort because it is structurally unreachable.

## 167. Absent-Boundary Detection ★ Differentiator
**Status: Planned** · 🔧 Needs depth

Trust boundaries that *should* exist and don't: a public route reachable (through the call graph) from a function that reads `req.body` with no validation call anywhere on the path; an external input that reaches a sink with no sanitization boundary crossed; a service method callable from both an authenticated and an unauthenticated route with no internal re-check. The dual of §70's attack-surface map — not "what is exposed" but "what is exposed *without the boundary it needs*", proven over the reachability graph.

## 168. Convention-Absence & Onboarding-Gap Detection ★
**Status: Vision** · 🛰 Needs infra

The project-level absences a new engineer trips on: no error-handling middleware registered anywhere, no graceful-shutdown handler, no request-ID middleware despite structured logging, no health endpoint, no rate limiting on any auth route, no `.env.example` despite 40 `process.env` reads. "Your codebase does X everywhere but never does the Y that X implies."

---

# Part XL — Temporal & Trend Analysis

*Every metric in the catalog is a point-in-time value. This part makes it a **derivative** — the direction and velocity of a property across history, which is often more actionable than the value. A complexity of 40 is a number; a complexity that went 12 → 40 over six weeks is a story. All of these need persisted history, so they are honestly Vision until that state exists.*

## 169. Metric-Velocity & Rot-Rate Tracking ★ Differentiator
**Status: Vision** · 🛰 Needs infra

Track every score and metric over time and report the **rate of change**, not the level: health score trending down 2 points a week, a module whose complexity is climbing steeply, a security-finding count that just inflected upward, test-file count falling behind source-file count. The leading indicator that lets a team intervene before a module becomes unmaintainable rather than after.

## 170. Debt-Interest Accrual ★
**Status: Vision** · 🛰 Needs infra

Technical debt has a carrying cost: a hotspot with high complexity *and* high churn *and* low test coverage is compounding — every change is slower and riskier than the last. Combine the churn (§160), complexity (§35), and coverage (§130) axes over time into a per-module "interest rate," and rank debt by what it is actively costing rather than by raw size. Answers "which debt do we pay down first" with evidence.

## 171. Finding-Half-Life & Fix-Latency Analytics ★
**Status: Vision** · 🛰 Needs infra

How long findings *survive* by rule and severity: security errors fixed in a day, performance warnings that linger for months, a specific rule whose findings are always dismissed (a signal the rule is miscalibrated — feeding §92). The dismiss-rate and fix-latency per rule is also the raw material for auto-tuning severity to how the team actually behaves.

## 172. Seasonal & Release-Correlated Risk ★
**Status: Vision** · 🛰 Needs infra

Correlate finding-introduction with time and process: a spike in risky changes right before releases, quality dips during on-call weeks, modules that degrade fastest under deadline pressure. Process insight drawn from the same history, useful for engineering leadership rather than the individual PR.

---

# Part XLI — Test-Suite & Contract Analysis

*The catalog analyzes production code exhaustively and treats tests only as coverage (§23, §130). But tests are code, and a bad test is worse than no test — it is false confidence that ships. This part turns the analysis inward onto the test suite itself, statically, with no need to run it.*

## 173. Assertion-Free & Vacuous Test Detection ★★ Flagship
**Status: Detected** (`no-assertion-free-test`, opt-in) · ⚙️ Now

**Shipped.** A test with no assertion passes forever and proves only that the code *runs* — while still counting toward coverage, which makes the coverage number actively misleading. `no-assertion-free-test` (Maintainability/warn/high) flags a test case that exercises imported production code and never asserts.

**The precision story is the feature.** The assertion recognizer is deliberately generous across dialects (jest/vitest `expect`, `node:assert`, chai `should` — including on a call result where no static member path exists, ava `t.is`, supertest `.expect(200)`). The hard part is DELEGATION: suites factor assertions into helpers. A first design matched helper *names* and produced **674 false positives on this project's own 99 test files**, because real helpers are named for the domain, not the act (`cron.fires(src)`, `ws.silent(src)`). The shipped design uses **provenance** instead — a callee that is local to the file, reached through a local binding, or imported from a helper-ish module may assert one frame down and buys silence; only imported production code counts as "exercised". That took the same corpus from 674 findings to **zero**, while still catching a genuinely vacuous test. Skipped/todo cases, empty placeholders, `expect.assertions(n)`, and rejection assertions are all silent.

A test with no assertion passes forever and proves nothing — it inflates coverage while verifying that the code merely *runs*. Statically flag: test bodies (`it`/`test`) with zero `expect`/`assert`/`should` calls, an `await` of the code under test with no assertion on the result, an assertion on a mock's return value (testing the mock, not the code), a `try/catch` that swallows the failure the test should surface, and a `.toBeDefined()`-only assertion on a rich object (technically-passing, substantively-empty). The highest-value test-quality signal, entirely syntactic, and it directly undercuts the coverage number's false comfort.

## 174. Flaky-Test Pattern Detection ★ Differentiator
**Status: Detected** (`no-flaky-test-pattern`, opt-in) · ⚙️ Now

**Shipped.** A flaky test teaches the team to re-run CI instead of reading it — and once "just retry" is the reflex, a genuine regression gets retried away too. `no-flaky-test-pattern` (Maintainability/warn/high) catches the mechanically-provable causes inside a proven test case: a **hard-coded sleep** (`setTimeout` with a literal delay used as a delay — a `setTimeout` that schedules real work is not a sleep and stays silent), an **assertion against the live clock** (`Date.now()`/`new Date()` as an assertion operand; reading the clock to *build* a fixture is fine, only comparing against it races), and **`Math.random()`** in the body, which makes any failure unreproducible. A file that puts time under control (`useFakeTimers`, `setSystemTime`, sinon's clock) silences the sleep and clock cases, because both are then deterministic. **Hardened against an adversarial hunt**, which showed the shape alone is never the bug — it needs the shape *plus* proof it is actually racing: a sleep must be the awaited-Promise idiom (`await new Promise((r) => setTimeout(r, 500))`), since a `setTimeout` whose handle is returned or cleared is scheduling and blocks nothing; a clock read must be a **direct operand** of the assertion, because wrapped in a predicate (`expect(isExpired(Date.now())).toBe(false)`) it asserts a property that holds at any instant; and `Math.random()` is silent when the file has taken control of it, by spy or by a hand-rolled `Math.random = () => 0.5`. Iteration-order assumptions, cross-test state coupling, and real network/filesystem calls are deliberately out of scope: they need dataflow this rule does not have, and an integration test is statically indistinguishable from a unit test.

The patterns that make a test non-deterministic, caught before it starts intermittently failing CI: a real `Date.now()`/`new Date()` asserted against a fixed value, a hard-coded `setTimeout` sleep instead of awaiting a condition, a test depending on another test's mutation of shared state, an assertion on iteration order of an unordered collection, a real network/filesystem call in a unit test, `Math.random()` in a fixture. Flaky tests erode trust in the whole suite; this catches the shapes that cause it.

## 175. Test-Reality Drift ★ Differentiator
**Status: Detected** (`no-mock-of-missing-export`, opt-in) · 🔧 Needs depth for the rest

**Shipped: the one piece decidable without running anything.** `no-mock-of-missing-export` fires when a `jest.mock`/`vi.mock` factory stubs a member the real module does not export. A test mocks `./services/user` and stubs `getUser`; someone renames the real export to `fetchUser`; nothing fails, the suite stays green, and the test now exercises a stub of a function that does not exist. The coverage number does not move and the confidence is entirely false.

The claim is "that module does not export this name", which is wrong the moment the export surface cannot be fully enumerated — so the rule abstains for the **whole mock**, not just the doubtful key: on a non-relative specifier, a target not in the graph, an `export * from` (a barrel is nothing but those), a CommonJS surface assembled at runtime, a module with no ESM exports at all, and a factory that spreads (`...vi.importActual(…)`), which is exactly how a partial mock is written. `default` and `__esModule` are interop keys and are never checked; type-only exports count as exports, because claiming a module does not export a name it does export would be false. Silent across this project's own 431 files.

The rest of §175 needs the type source and mock-shape modelling, and stays planned: a mock that has silently diverged from the thing it mocks — a mocked function whose signature no longer matches the real export (via the export surface, §155), a stubbed API response shape that no longer matches the client's actual return type, a hand-rolled fake of a module whose real interface gained a required method. The test passes against a fiction. Reuses the type source (§57) and export analysis to compare the mock against reality.

## 176. Over-Mocking & Tautology Detection ★
**Status: Detected** (`no-tautological-mock-assertion`, opt-in) · ⚙️ Now

**Shipped, the provable sub-case.** The section describes a *ratio* — "the mocked surface dwarfs the real surface" — which is a judgement call and would produce exactly the arguable findings this project refuses to ship. So the rule implements only what can be proven: `no-tautological-mock-assertion` (Maintainability/warn/high) flags an assertion whose subject is a **direct call to a mock this test file configured with a fixed return value**, compared with a value matcher. The test stubs a collaborator to return X, calls it, and asserts X — re-stating its own setup while exercising none of the code under test, and still counting toward coverage. It reads like rigour, which is what makes it durable through review. Silent the moment real code wraps the mock's value (the test is then exercising something), on behavioural assertions (`toHaveBeenCalledWith`, which verify how *our* code used the collaborator and are genuinely valuable), and on unconfigured spies. **Hardened against an adversarial hunt**, which showed the binding itself must be proven: only a **namespaced** factory counts (`vi.fn`, `jest.fn`, `sinon.stub`), because a bare `stub()`/`fn()` is just as likely a fixture builder — or, in a mocking library's own test suite, the production code under test — and only a `const` that is never reassigned counts, since a mock swapped for the real implementation between suites turns the same assertion into a genuine test.

A test that mocks so much of the system that it only exercises the mocks: every collaborator stubbed, the unit under test reduced to glue, the assertions merely re-stating the mock configuration. Flags a test where the mocked surface dwarfs the real surface exercised — the "100% coverage, zero confidence" pattern that looks rigorous and verifies nothing.

## 177. Missing-Negative-Path Coverage ★
**Status: Planned** · 🔧 Needs depth

Every handler has error paths; most test suites test only the happy one. Cross the branches in a function (the error returns, the thrown exceptions, the guard clauses) against what the tests actually invoke, and report handlers whose **failure modes are untested** — weighted by risk, so an untested error path in an auth or payment handler ranks first. The precise, code-aware version of "you have 80% coverage but 0% of it is the parts that break."

---

# Part XLII — Cross-Artifact Consistency

*Every rule so far reasons within the code. This part reasons **between the code and everything around it** — the comments, the docs, the types, the config, the strings — where the two drift apart silently because nothing checks that they agree.*

## 178. Comment-Code Contradiction ★★ Flagship
**Status: Detected** (`jsdoc-param-mismatch`, opt-in) · 🔧 Needs depth

**The one machine-verifiable slice is shipped; the rest were dropped rather than approximated.** `jsdoc-param-mismatch` fires when a JSDoc block documents a `@param` the function does not have — the rename happened, the doc did not. It matters more every year: a coding agent has no way to tell a stale doc from a current one and will generate calls that match the comment rather than the signature.

Precision is almost entirely in the *association* between a comment and the node it documents, which is where this rule could be wrong rather than merely noisy. The block must sit immediately above the declaration, separated by at most one newline (a module header two blank lines up is not the first function's documentation), with no other comment between them, and not on the same line as the previous statement (that is a trailing comment). Beyond that: every parameter must be a plain identifier (destructuring leaves nothing to name-match), every `@param` name must be a bare identifier (`opts.timeout` is a property path and `[opts]` is optional-parameter syntax — neither is a checkable claim), and the function's name must be unique in the file, because a TypeScript overload set puts one JSDoc above several declarations that differ in parameters. A parameter with *no* `@param` is deliberately not reported: that is incomplete documentation, not a contradiction, and reporting it would turn this into a doc-coverage linter and bury the real signal. Silent across this project's own 414 files.

The other four sub-cases were assessed and **dropped**. `@returns {null}` versus "every path throws" needs path-sensitive completion analysis this engine does not have. The magic-number comment (`// 30 second timeout` beside `5000`) is unfalsifiable — parsing the number is trivial, but inferring the *unit* is the rule, and the same comment is correct beside `30_000` under milliseconds and beside `30` under seconds. `// TODO: remove after v2` needs a project version the analysis path does not carry, and "v2" routinely means a dependency's v2 or an API version rather than this package's. `@deprecated` on a symbol still imported is provable via the import graph but is a migration-progress signal rather than a contradiction — held for a later wave.

The original framing of this section: a comment that lies is worse than no comment — it actively misdirects the next reader (and the next agent). Statically catch the checkable subset: a JSDoc `@param`/`@returns` that no longer matches the signature, a `@deprecated` tag on a symbol still imported everywhere, a comment saying "returns null if not found" above a function that throws, a `// TODO: remove after v2` in a v5 codebase, a magic-number comment (`// 30 second timeout`) next to a value that has since changed (`5000`). The subset that is machine-verifiable is a genuine, on-thesis correctness signal — stale comments are exactly what a coding agent reads and trusts.

## 179. Type-Runtime Divergence ★ Differentiator
**Status: Planned** · 🔧 Needs depth (type source, §57)

Where the type system asserts something the runtime contradicts: a function typed to return `User` that can return `undefined` on a branch, an `as` cast that launders an untrusted value into a trusted type with no validation, an `any` from a JSON parse flowing into a strictly-typed sink, an API response typed as a shape the validation never actually checks. The gap between "the types say" and "the code does" — precisely where TypeScript's soundness holes bite in a backend.

## 180. Config-Code Semantic Drift ★
**Status: Planned** · 🔧 Needs depth

Beyond §124's "env var missing": config values whose *meaning* has drifted from their use. A `maxRetries: 3` in config that the code reads as milliseconds, a feature flag referenced in code with a name that no longer exists in the flag definition, a timeout in `config.json` in seconds that the code passes to an API expecting milliseconds (a 1000× bug), a CORS origin list in config that the code overrides with a hardcoded value. Config and code agreeing syntactically but disagreeing semantically.

## 181. i18n & User-String Integrity ★
**Status: Core** (`node-doctor i18n`, aliases `locales` / `l10n`) · ⚙️ Now

**Shipped as a command, with one of the four sub-cases deliberately not shipped.** The localization drift class is invisible in a review of either file alone: the code is fine, the JSON is fine, and the relationship between them is broken. A key referenced with no entry ships a blank string — or the raw key — to a user and nothing in the build fails. A placeholder renamed in the translation but not at the call site renders `Hello {{userName}}` verbatim in production.

Three proof obligations before any key is called missing. **The file must be proven i18n code**: `t("x")` is the most ambiguous call shape in JavaScript — a test tap, a tagged template helper, a Lodash chain — so the calling file must import a recognized i18n package. **The key must be static**: a computed key (`` t(`errors.${code}`) ``) is skipped, and it sets a flag that suppresses unused-key detection for the whole run, because a dynamic key can reach any entry. **The locale file must be proven a locale file**: `**/*.json` would swallow tsconfig, package.json, fixtures and OpenAPI specs, so a file qualifies only with a translation-shaped directory segment, a BCP-47-shaped name, and all-string leaves. Namespaces, plural and context suffixes, and `defaultValue` all resolve before a key is called missing; ICU `plural`/`select` strings, `$t()` nesting and `@:link` references are never compared; and i18next's reserved options (`count`, `ns`, `lng`, `defaultValue`, …) are removed from the *required* set — the first version removed them from the *supplied* set, which is exactly backwards and made `{{count}}`, the commonest i18next placeholder, report as never supplied on every plural string. Only `{{name}}` is compared: single-brace `{name}` is ICU syntax but also ordinary English prose, and there is no way to tell them apart from the string alone. **Dead-translation detection is not shipped**, and the report says so rather than returning an empty list. An adversarial hunt settled it: a key is reachable from `<Trans i18nKey="x">` in JSX, from a `.vue`/`.svelte` template this does not parse, from a `t` prop-drilled through three components, from `$t(other.key)` nested inside another translation, and from a `@:link` reference. All are invisible here, and the action a reader takes on "no code references this translation" is to delete a string a user sees. A claim whose failure mode is deleting production copy has to be right every time.

**"Hardcoded user-facing strings" is dropped, and will not ship.** There is no static property that distinguishes a user-facing string from a log message, an error code, a SQL fragment, an HTTP header, a route path, a test fixture or a developer-facing exception. Every candidate gate — contains a space, starts with a capital, is passed to `res.send` — misfires in both directions, and a mature localized codebase legitimately holds thousands of untranslatable literals. Whether a string is user-facing is a natural-language judgement, and the deterministic core does not guess.

The original framing of this section: the localization drift class: a translation key referenced in code with no entry in the locale files (a blank string shipped to users), a locale entry no code references (dead translation), interpolation placeholders that mismatch between the key's definition and its use (`{name}` vs `{userName}` → a broken message), and hardcoded user-facing strings in a codebase that otherwise uses a translation function (untranslatable text that slipped the process). Cross-references code against the locale artifacts.

---

# Part XLIII — Operational & Human-Factor Signals

*The final lens: what the code reveals about **how it will behave in production and how the team operates** — signals that are neither a security bug nor a correctness bug, but that determine whether a 3am page is survivable. Adjacent to §138/§151 but about operability and process rather than a specific failure.*

## 182. Operational-Readiness Score ★ Differentiator
**Status: Core** (`node-doctor readiness`, aliases `ops` / `launch-review`) · ⚙️ Now

**Shipped as a command.** "Is the code good?" and "can this be run in production?" are different questions, and the health score answers only the first. A 100/100 codebase with no SIGTERM handler drops every in-flight request on every deploy; a service with no correlation id in its logs is undebuggable at 3am however clean its functions are. `readiness` is the number an SRE asks for before a launch review, assembled from evidence rather than from a checklist somebody filled in by hand.

**It adds no new detection.** Nine dimensions — graceful shutdown, health/readiness probes, request correlation, failure logging, outbound timeouts, route error handling, no hard exit on a request path, container resource limits, retry/timeout policy — are rolled up from diagnostics and reports that already ship (§11, §138, §151, §136, §25). What is new is the aggregation, and the honesty model around it.

**The honesty model is the whole design.** The obvious way to build this is a checklist where "no finding" means "pass", and that is a lie: `require-sigterm-handler` only fires in a file that binds a port, so a repository with no server produces zero findings, and reporting that as *graceful shutdown: PASS* tells an SRE the opposite of the truth. So each dimension carries four verdicts, and only two of them touch the score — **ready** (positive evidence exists), **gap** (a rule proved it), **not applicable** (provably does not apply here), **not proven** (applies, but the rule was disabled or the evidence is out of reach). The last two are excluded from the denominator and printed with their reason. Applicability is established independently of any finding, by a pass that looks for the port binding, the signal handler and the manifests directly. A repository where nothing could be assessed scores **`null`, not 100** — "I could not tell" and "you are ready" must never render the same, which is the same principle §160 and §163 are built on.

It deliberately does **not** reuse the health score's arithmetic: `calculateScore` is a *density* model (weighted findings per kLOC), and a five-line service and a 500-kLOC service with no SIGTERM handler are equally unshippable — per-kLOC normalization would score the large one near 100. The arithmetic is passed-over-applicable, with the same 75/50 label thresholds so the number reads coherently next to the other two. Exit code is always 0: this rolls up opt-in heuristics, and a heuristic must never fail somebody's build on its own.

The original wording of this section, for reference: a single composite score for "can this service be run in production" — distinct from code health. Rolls up signals the catalog already computes or can: graceful shutdown present, health/readiness split correct (§138), structured logging with correlation IDs (§151), timeouts on outbound calls (§136), a circuit-breaker or retry policy on inter-service calls, resource limits declared (§25), and no `process.exit` on a request path (§11). The number an SRE would ask for before a launch review, assembled from evidence rather than a checklist someone filled in by hand.

## 183. Debuggability & Incident-Support Analysis ★
**Status: Detected** (`no-error-cause-discarded`, opt-in) · ⚙️ Now

**Shipped, the highest-value slice.** `no-error-cause-discarded` (Reliability/warn/high) flags `catch (err) { throw new Error("failed to load user") }` — a re-throw that destroys the only evidence of what actually went wrong. The stack now starts at the re-throw, so the DNS failure, the connection reset, the parse error is gone; the log says "failed to load user" and the on-call engineer has no thread to pull. `Error` has taken a `cause` option since Node 16.9 for exactly this, and it costs one property.

Precision: the catch must **bind** its error (a bare `catch {}` never had a cause to discard — that is §12's swallowed-error territory), the thrown value must be a **newly constructed** error, and the bound name must appear **nowhere** in the throw expression *or* anywhere else in the block. Passing it as `cause`, as any constructor argument, interpolated into the message, or simply logging it first all count as keeping the thread. That last clause is deliberately generous: a false "you lost the cause" against code that kept it costs more than missing one. Verified silent across this project's 339 source and test files. The other §183 signals — untimed external calls, contextless generic messages, log lines with no request correlation — are already covered by `observability` (§151) and remain Planned as diagnostics.

Whether a future on-call engineer can diagnose this code under pressure: errors that lose their cause (`catch (e) { throw new Error("failed") }` — the original discarded), swallowed rejections with no log, external calls with no timing or identifier to correlate against a trace, generic error messages (`"Something went wrong"`) with no context, and log lines with no way to tie them to a request. Extends §153 from "consistent errors" to "errors a human can actually act on at 3am."

## 184. Bus-Factor & Knowledge-Concentration Mapping ★
**Status: Vision** · 🛰 Needs infra (history)

Where knowledge is dangerously concentrated: modules touched by exactly one author, critical paths (auth, payments, the hub modules of §33) with a single point of human failure, and code whose only expert has gone quiet in the history. Combines blast radius (§120) with `git` authorship to surface the organizational risk — "if this person leaves, these 14 critical modules have no owner" — which is an engineering-leadership signal no code tool provides.

---

## Honest read: what to actually build

The pattern from every prior extension holds harder here — most of this is Vision (it needs persisted history or an AI layer), and the discipline is to ship only the precise slice. Of §159–§184, the three I would build first, all **⚙️ Now** and all genuinely category-defining:

1. **§164 Peer-Consistency Anomaly Detection** — the single most valuable idea in this document. "19 of 20 siblings do X, one doesn't" is *learned-from-the-codebase linting with zero config*, and it catches the tenant-scope-forgotten / auth-wrapper-missing class that a fixed ruleset structurally cannot anticipate. It also strengthens the packs held back on precision (§114 multi-tenancy, §117 idempotency) by deriving the rule from the project instead of guessing it. The engineering is real (structural clustering) but the payoff is a capability no competitor has.
2. **§173 Assertion-Free Test Detection** — entirely syntactic, false-positive-free, and it directly attacks the lie the coverage number tells. A test with no `expect` is provable and common; flagging it is cheap and the trust dividend is large.
3. **§161 Fix-Regression Detection** — needs finding history, so it is Vision, but it is the most trust-building signal an analyzer can send ("you fixed this in March; it's back"), and it is a near-free extension of the stable finding identities (§104) you already compute the moment any history is persisted. Worth building the persistence layer *for*.

Then, in a second wave: **§159 suspicious-change-shape** and **§160 churn-weighting**, because both are pure git-log reasoning on data CI already has and both make the tool sharper on exactly the changes that matter. **§178 comment-code contradiction** is the most on-thesis of the cross-artifact set — stale comments are what agents read and believe — and its machine-verifiable subset is precise enough to ship.

The rest is a menu, and the same rule governs it that has governed all 184: a false positive in §164 or §173 would be worse than not shipping them, and the invariants — deterministic offline core, local score, precision-first, AI-as-optional-layer — hold across §159–§184 without exception.

---

# node.doctor — Features (Frontier / §185–§210)

A sixth extension. Everything here is **net-new** against §1–§184 — verified against all five prior halves so nothing restates an existing rule, command, or deliberately-rejected idea. Same maturity legend (**Core** / **Detected** / **Planned** / **Vision**), the same **⚙️ Now / 🔧 Needs depth / 🛰 Needs infra** buildability tags, and the same invariants (deterministic + offline core, local score, precision-first, AI-as-optional-layer).

> **Where the whitespace actually is at 184 sections.** The catalog now owns injection, the event loop, the data-access and queue graphs, the export/route surfaces, the AI-security pack, the agent loop, diff-shape reasoning, negative-space detection, and cross-artifact consistency. Six directions remain genuinely unexplored: the **build-and-bundle dimension** (what the code becomes, not what it is), the **concurrency-model dimension** (workers, clustering, shared memory), the **process-boundary dimension** (what crosses a spawn, an IPC channel, a signal), the **numerical-and-encoding dimension** (the layer below serialization), the **failure-injection dimension** (what the code does when its own primitives fail), and the **authoring-provenance dimension** (what the shape of the code says about how it was produced).
>
> **New parts:** XLIV Build & Bundle Semantics (§185–§189) · XLV Concurrency & Shared-Memory (§190–§194) · XLVI Process & IPC Boundaries (§195–§199) · XLVII Primitive-Failure Reasoning (§200–§204) · XLVIII Authoring Provenance & Shape (§205–§210).

---

# Part XLIV — Build & Bundle Semantics

*Every rule so far analyzes source. This part analyzes the **gap between source and artifact** — what the bundler, the transpiler and the packager do to the code on the way to production, where a correct source file becomes an incorrect artifact.*

## 185. Conditional-Export Resolution Correctness ★★ Flagship
**Status: Shipped** · `node-doctor exports-check [dir]` (aliases: `exports-map`, `dual-package`)

A `package.json` `exports` map is a resolution program, and it is routinely wrong in ways that surface only for *some* consumers: a `require` condition pointing at ESM, an `import` condition pointing at CJS, a `types` condition ordered after `default` (so TypeScript silently never sees it), a subpath resolving to a file that does not exist, and `main`/`module`/`exports` disagreeing about the same entry. §155 diffs the export *surface*; nothing checks that the map **resolves**. Pure resolution arithmetic against the files on disk, and the failure mode is "works for me, breaks for half my consumers."

**Seven problems, each a resolution that fails for a consumer and succeeds for the author** — the author has the whole source tree and never loads through the map: `missing-target`, `require-points-at-esm`, `import-points-at-cjs`, `types-after-default`, `types-condition-not-first`, `main-disagrees-with-exports`, `dead-wildcard`. The bar is the runtime's own bar, so anything the resolver treats as "maybe" is a silence. A file's module system is settled by extension first, then by **ESM syntax — which is conclusive either way**: whether the nearest `type` field says `module` (so it IS an ES module) or `commonjs` (so it is a syntax error waiting to happen), `require()` cannot load it, which is exactly the claim being made. A bundled file with no import/export and no `require` is *unknown* and judged not at all. Conditions are tracked **structurally** as the map is walked rather than recovered from the printed path, so a subpath named `./require` is never read as a condition. Bare-specifier targets belong to the package they name; `null` targets are deliberate blocks; `types`/`typings` targets are never judged for module system, and a `.` export carrying nothing but `types` cannot disagree with `main` — it names no runtime file. Wildcards are expanded against the real tree, so a live pattern is silent and a dead one is `ERR_PACKAGE_PATH_NOT_EXPORTED` for every subpath it was meant to serve. Exits 1 on any finding.

## 186. Transpile-Semantics Divergence ★ Differentiator
**Status: Planned** · 🔧 Needs depth

Where the emitted JavaScript does not mean what the TypeScript said: `useDefineForClassFields` changing field-initialization order, a side-effect-only import dropped, decorator metadata that disappears under a different setting, a `const enum` inlined across a package boundary, and `isolatedModules` violations that fail only under a different transpiler.

## 187. Bundle-Boundary Leakage ★★ Flagship
**Status: Planned** · 🔧 Needs depth

Server-only values reaching a client bundle: a module reading `process.env.DATABASE_URL` transitively reachable from a client entry point, a server-only package pulled into a shared utility, `"use server"`/`"use client"` boundary violations. The blast-radius graph already computes reachability; this points it at the bundler's entry points instead of the request handlers. The failure mode is a secret in a file served to browsers.

## 188. Tree-Shaking Defeat Detection ★
**Status: Adjacent case shipped; the section itself rejected** · `no-namespace-object-write`

Patterns that silently disable dead-code elimination: a missing or wrong `sideEffects` field, a top-level statement with an observable effect in a library entry, `export *` chains that defeat static analysis, and a namespace import used for exactly one member.

**All four catalogued sub-cases were scoped and rejected**, and the reasons are worth keeping. *A missing or wrong `sideEffects` field* requires proving a module has no observable effect, which is the whole-program analysis this engine refuses. *A top-level statement with an observable effect in a library entry* needs to know both that the file IS a library entry and that the statement HAS an effect; syntax supplies neither. *`export *` chains* rest on a false premise — bundlers resolve them. *A namespace import used for exactly one member* is a style preference, and fails the bar the same way `parseInt` without a radix did.

**What did ship is adjacent to the last of those, and is a fact rather than a preference.** `import * as NS` binds a module namespace exotic object whose `[[Set]]` returns `false` for every key, and ES module code is always strict — so a write to one of its properties is an unconditional `TypeError`. It arrives with a migration: `require("node:fs").readFile = wrapped` is legal CommonJS and is how a generation of APM shims was written, and the mechanical ESM translation of it throws.

The scoping found a trap that makes the ESM proof mandatory rather than tidy, and it is the same shape as the Worker findings a wave earlier: **loaded by a CommonJS caller — sloppy mode — the identical write on the identical object does not throw. It silently does nothing.** `Object.isSealed` is `true` in both worlds, so the object cannot tell you which one it is in; only the caller's strictness decides. Reporting a crash that does not happen would be the false positive, so this reuses `no-dirname-in-esm`'s proof ladder unchanged, and adds two silences of its own: a **test file** (a runner's module mock hands over a plain mutable object, so `mod.fn = vi.fn()` genuinely works) and `Object.assign(NS, src)` (which copies nothing and throws nothing when `src` is empty — value analysis, so not claimed).

## 189. Source-Map & Debug-Artifact Hygiene ★
**Status: Scoped and rejected** — every sub-case, with reasons, in the scoping pass recorded at the end of this part

Source maps shipped to production exposing original source, `.map` files referenced but absent (so every production stack trace is unreadable), inline base64 maps inflating the bundle, and a `sourceRoot` leaking absolute build-machine paths.

---

# Part XLV — Concurrency & Shared-Memory

*The catalog covers async concurrency (§10) and cross-request state (§59). It does not cover **real parallelism** — worker threads, clustering, shared memory — where Node's failure modes are different in kind, not degree.*

## 190. Worker-Thread Boundary Correctness ★★ Flagship
**Status: Detected** (`no-unclonable-worker-message`, opt-in) · ⚙️ Now

**Shipped: the one case that is decidable.** `postMessage` does not pass a reference — it runs the **structured clone algorithm**, and that algorithm throws on a function. So `worker.postMessage({ rows, onDone: () => finish() })` is a `DataCloneError`, thrown synchronously, at the call, on whichever code path happens to carry the callback. It is not a type error, no linter sees it, and the test that exercises the other branch passes.

The algorithm's rules are mostly undecidable from syntax — a `Map` clones, a `Proxy` throws, a class instance clones but silently loses its prototype — so the rule claims only **a function literal in the posted value**. The receiver must be a *proven* worker-thread port (a binding from `new Worker(…)` imported from `node:worker_threads`, or `parentPort` itself), because `postMessage` is also the method on a `BroadcastChannel`, a `MessagePort`, a browser `window` and any number of userland emitters — and the browser's has the same restriction with a different remedy, so a shared message would be wrong advice half the time. A bare identifier in the payload is never flagged: "this variable might be a function" is a guess. The walk stops at any nested function's own body, since that body is not part of the cloned structure. Zero findings across this project's 430 files.

Everything else the algorithm rejects — a `Proxy`, a `WeakMap`, a misused `SharedArrayBuffer`, a dropped prototype, a transferable used after transfer — needs value provenance this rule does not have, and stays Planned rather than guessed at.

## 191. Cluster & Multi-Process State Assumptions ★ Differentiator
**Status: Planned** · 🔧 Needs depth

Code that is correct single-process and wrong under `cluster`/PM2: an in-memory rate limiter or cache each worker keeps its own copy of, a `setInterval` cron that now fires N times, a lock held in a module-scope variable, an in-memory session store behind a load balancer with no sticky sessions. The commonest "it worked on one instance" outage class.

## 192. Atomics & Memory-Ordering Misuse ★
**Status: Planned** · 🔧 Needs depth

`SharedArrayBuffer` accessed without `Atomics`, `Atomics.wait` on the main thread (blocking the event loop entirely), a busy-wait over shared memory, and non-atomic read-modify-write on a shared counter.

## 193. Backpressure Across Async Iterators & Streams ★
**Status: Scoped and rejected** — every sub-case, with reasons, in the scoping pass recorded at the end of this part

The write-side half §128 deliberately left: ignoring the `false` return of `.write()`, an async iterator consumed faster than it produces, `for await` over an unbounded source with no concurrency limit, and a `Readable` pushed to without checking `push()`'s return.

## 194. Event-Emitter Contract Violations ★
**Status: Partially shipped** · `no-literal-listener-removal`

Emitting `error` with no listener (generalizing §31/§128), exceeding `maxListeners` on a long-lived emitter, `removeListener` with a different function identity than was added, and `once` used where the event fires before registration.

**The identity half shipped.** `removeListener`/`off`/`removeEventListener` all match by reference identity, so a function LITERAL written at the removal site — or a fresh `.bind(…)`, which allocates a new object every time it runs — was never registered and removes nothing. The call succeeds, the listener stays attached holding everything it closes over, and a per-connection handler grows the emitter until `MaxListenersExceededWarning` shows up in production logs attributed to something else. This needs no knowledge of the receiver: no removal API in any library matches structurally. An identifier is never reported, and a **test file is inert** — the harm is a long-lived process, which a test does not have, and every real-world instance the corpus sweep surfaced was a suite *asserting* the no-op. Found two real bugs on first contact: `@tiptap/core`'s `ResizableNodeView` adds and removes with two different `.bind(this)` results, and the Chrome DevTools frontend bundled into `@react-native/debugger-frontend` does the same.

**Not shipped, with reasons.** *`error` with no listener* needs whole-program reachability — the handler may be attached by the caller, in a factory, or after the emitter is returned. *`maxListeners` exceeded* is a runtime count. *`once` where the event fires before registration* is an ordering question no syntax answers.

---

# Part XLVI — Process & IPC Boundaries

## 195. Child-Process Boundary Correctness ★ Differentiator
**Status: Partially shipped** · `no-detached-child-without-unref`

Beyond §7's command injection: a child spawned with the parent's full `process.env` (leaking every secret to a subprocess), `stdio: "pipe"` with an unread pipe (the child blocks forever on a full buffer), `maxBuffer` exceeded silently truncating output, a child never killed on parent exit, and `detached` without `unref`.

**`detached` without `unref` shipped; the rest did not, and the reason is the same for each.** The shipped case is the one that is decidable from syntax: `detached: true` puts the child in its own process group so it can outlive the parent, but the parent's event loop still holds a reference — so the parent *cannot exit* until the child does, which is the exact opposite of what the author asked for. A CLI that spawns a detached background worker and then finishes simply hangs. The claim is "this handle is never unref'd", so every way it could be is a silence: the spawner must be proven by import (`spawn` is also `cross-spawn`, test helpers, and userland process pools), `detached` must be **literally** `true` with no spread after it that could overwrite it, the result must be bound to a plain local, and `unref()` anywhere on that binding — a later line, a callback, a guard, a `finally`, a computed member that *could* be it — ends the claim. A binding that escapes (returned, passed, stored, aliased) may be unref'd out of sight and is never reported.

**Not shipped, with reasons.** *Full `process.env` inheritance* is the **default**, so flagging it flags every correct `spawn` in every codebase; "should this child see the parent's secrets" is a policy question the syntax does not answer. *`stdio: "pipe"` with an unread pipe* requires proving no consumer exists anywhere — including in a handler attached later, or by a caller holding the returned handle — which is the whole-program reachability this engine deliberately does not claim. *`maxBuffer` exceeded* is a runtime quantity, not a syntactic one. *A child never killed on parent exit* is §165's resource-lifecycle question and fails the same way: the kill may live in a signal handler, a `finally`, or a teardown module, and absence of a syntactic kill is not absence of a kill.

## 196. Signal-Handling Correctness ★
**Status: Partially shipped** · `no-uncatchable-signal-handler`

§182 checks a SIGTERM handler *exists*; this checks it is *correct*: an async handler whose work never completes, a handler registered twice, `SIGKILL`/`SIGSTOP` handlers that can never fire, and a handler calling `process.exit()` before its own cleanup.

**The uncatchable-signal case shipped, and it turned out to be worse than the catalog assumed.** `SIGKILL` and `SIGSTOP` are handled by the kernel, and the catalog described a handler that "can never fire". Verified against the runtime, it is not a dead handler at all: `process.on("SIGKILL", …)` reaches `uv_signal_start`, which fails, and the `EINVAL` is **thrown at the point of registration** — so the line crashes the process at exactly the moment it is wiring up its shutdown path. Registered at module scope, that is a boot failure. The intent behind it ("clean up however we are killed") is unreachable by construction, which is why orchestrators send `SIGTERM` first and `SIGKILL` only after the grace period. `process.kill(pid, "SIGKILL")` SENDS the signal and is correct; only the registration methods are judged, only on the global `process`, and only with a literal signal name. The hunt then found three places where the crash claim is simply not true, each confirmed by running it: **inside a Worker there is no throw at all** — worker threads never install the hook that reaches `uv_signal_start`, so the listener is merely dead; a `try`/`catch` catches the throw and the process survives; and a file that replaces the global (`globalThis.process = fake`) or writes `import process = require(…)` has shadowed the name in a way the scope resolver cannot see. Since the finding is entirely about the crash, all four are silences.

**Not shipped, with reasons.** *An async handler whose work never completes* is a claim about whether a promise settles. *A handler registered twice* is legitimate — two subsystems may each want to hear about shutdown, and Node runs both. *A handler calling `process.exit()` before its own cleanup* is §166's `no-unreachable-cleanup-after-exit`, already shipped.

## 197. Exit-Code & Process-Lifecycle Semantics ★
**Status: Partially shipped** · `no-out-of-range-exit-code`

`process.exit()` with a pending write (the bug this project found in its own CLI), `process.exitCode` assigned but a later `exit()` overriding it, an exit code above 255 silently wrapping, and a CLI that always exits 0 so failures are invisible to CI.

**The wrapping shipped.** A process exit status is one byte, so Node keeps `code & 0xFF` and the two ways that goes wrong are both silent: a code above 255 becomes a *different* code (`process.exit(300)` → the shell sees 44), and a nonzero code that masks to zero reports the run as a **success** (`process.exit(256)` → 0, so CI goes green and the deploy proceeds). Both were confirmed by running them. The code must be a numeric literal — an exit code read from config is the config's problem — and `process.exit(-1)` is deliberately **not** reported: it masks to 255, a nonzero failure status, which is exactly what "exit minus one" means to everyone who writes it. The hunt found the one place the arithmetic does not apply, and running it confirmed the claim: **a worker's exit code never reaches `wait(2)`**. It is a plain JavaScript number handed to the parent's `exit` event, so `process.exit(1001)` inside a Worker really does deliver 1001, and a file that touches `worker_threads` is not judged.

**Not shipped, with reasons.** *`process.exit()` with a pending write* is §166, already shipped. *`process.exitCode` overridden by a later `exit()`* is mostly a non-bug — bare `process.exit()` honours `exitCode`, so only an explicit `process.exit(0)` after a nonzero assignment is wrong, and proving the two run on the same path needs a control-flow graph. *A CLI that always exits 0* requires knowing that a failure path exists and does not reach a nonzero exit, which is whole-program reachability.

## 198. IPC Message-Shape Contracts ★
**Status: Planned** · 🔧 Needs depth

§157's topology reasoning applied to `process.send`/`message`: a shape sent that no handler destructures, a handler expecting a field nothing sends, and a payload that will not survive structured clone.

## 199. Working-Directory & Path-Resolution Assumptions ★
**Status: Partially shipped** · `no-dirname-in-esm`, `no-url-as-filesystem-path`

A relative `fs` path resolved against `process.cwd()` rather than the module, `__dirname` in ESM, `import.meta.url` used as a filesystem path without `fileURLToPath`, and a config located by walking up from `cwd` in a tool that may run anywhere.

**Both module-identity cases shipped; both are decidable, and the other two are not.**

`no-dirname-in-esm` — `__dirname`/`__filename` are CommonJS wrapper parameters, so in an ES module the first line that reads one throws `ReferenceError` at module evaluation. The claim is "this file is an ES module", and being wrong about that turns correct CommonJS into a false report, so the module system is PROVEN: a `.mjs`/`.mts` extension, or `import.meta` in the file (which does not parse in CommonJS), or a `.js`/`.jsx` file in a `"type": "module"` package that really has `import`/`export`. A `.ts` file is not judged that last way — its emitted module format is a `tsconfig` question. Four silences the hunt and the corpus sweep proved necessary: a local `__dirname` (the `fileURLToPath` shim); a `typeof __dirname` guard anywhere in the file, which is the one operator that may name an undeclared binding safely and makes the file dual-mode; a **tool config** (`*.config.js`), which the tool's own loader bundles with `__dirname` defined; and a **bundler marker** (`import.meta.env`, `import.meta.hot`), which does not exist in Node at all and so proves the file is compiled before it runs. Only a *reference* counts — an interface member, a class field, a re-export specifier, an import alias and a TypeScript parameter property all merely spell the name.

`no-url-as-filesystem-path` — `import.meta.url` is a `file://` URL string, and the finding is that raw node sitting where the string gets rewritten or opened. Narrowed by the hunt to the four `path` members that actually break it — `join` and `normalize` collapse the scheme's slashes, `resolve` and `relative` measure against `process.cwd()` — because `basename`, `dirname`, `extname` and `parse` are pure segment arithmetic that works correctly on a URL, and a module name or a sibling URL built that way is right. `fs` is judged in argument 0 only. Both rules re-check at the CALL SITE that the imported name has not been shadowed: `resolve` is the most-collided identifier in Node, being a Promise executor's own parameter and `import-meta-resolve`'s `resolve(specifier, parentURL)` whose second argument really is a URL.

**Known boundaries, stated rather than hidden.** A `.js` source under a `type: module` root that a bundler transpiles to CommonJS before it runs — a serverless-webpack Lambda, a Babel monorepo workspace — is reported even though `__dirname` is defined in the artifact; the two settings are contradictory in intent, and 2,866 real source files across five `type: module` projects produced no instance. A test that *asserts* the ReferenceError, or asserts that a bare `file://` string is not a path, is reported on code whose brokenness is the point.

**Not shipped, with reasons.** *A relative `fs` path resolved against `cwd`* is not a defect — `readFile("./config.json")` is correct in a CLI run from the project root and wrong in a library, and nothing in the syntax says which this is. *A config located by walking up from `cwd`* is the documented behaviour of every tool that does it.

---

# Part XLVII — Primitive-Failure Reasoning

## 200. Allocation-Failure & Limit Reasoning ★
**Status: Adjacent case shipped; the section itself rejected** · `no-sparse-array-iteration`

`Buffer.allocUnsafe` with a caller-controlled size, a string built past the engine's maximum length, `JSON.parse` of an unbounded body at the allocation layer, an array pre-allocated from an untrusted count, and a regex on input with no length bound.

**All five were scoped and rejected.** *`Buffer.allocUnsafe` with a caller-controlled size* was the most promising and is worth recording in full: the disclosure is real — 7 of 20 non-pooled 64KB allocations came back holding the previous contents when measured — but `allocUnsafe` is correct when the buffer is immediately filled, and "was this fully written before it escaped" is exactly the flow analysis this engine does not do. *A string past the engine's maximum*, *an unbounded `JSON.parse`*, *an array from an untrusted count* and *a regex with no length bound* all need a value or a rate that the file does not contain; "no length bound" is not a syntactic property.

**What did ship is a fact about holes rather than about size.** `new Array(5)` creates five **holes**, not five `undefined`s, and every callback-taking method on `Array.prototype` skips holes — so `new Array(5).map((_, i) => i)` returns five holes and `new Array(3).forEach(seed)` runs the callback **zero** times. Both measured. It reads as obviously correct, which is why it survives review, and it fails quietly: `.length` is the number the author expected, and `JSON.stringify` renders the holes as `null`. Only a single positive-integer **literal** counts, because `new Array(n)` might be `new Array(0)` — and `fill`, `join` and `keys` visit holes, so `new Array(n).fill(0)`, the standard fix, is silent by construction.

## 201. Numeric-Boundary & Coercion Correctness ★ Differentiator
**Status: Partially shipped** · `no-nan-comparison`

The layer below §145: `parseInt` without a radix, `Number()` on a value that can be `""` (which is `0`, not `NaN`), integer division assumed where floats result, `%` on a negative operand, `Math.max()` of an empty array, an off-by-one in a `slice` bound from user input, and a comparison against `NaN`.

**One of the seven is a fact about the language rather than a guess about the data, and that is the one that shipped.** `NaN` is the only value not equal to itself, so every comparison against it has a constant answer: `=== NaN` is a validation branch that never runs, so the `NaN` flows onward and surfaces three layers away as a `null` in JSON or an `Invalid Date`; `!== NaN` is a guard that never rejects anything while reading like a check that was performed. Both shapes are silent, and they fail in opposite directions. The hunt found the rule's own precision model was only half-implemented: it excluded a rebound `NaN` but not a rebound `Number`, so a file declaring its own `Number` — a value namespace, an interpreter class, a schema object — was reported for comparing object identity, and applying the rule's advice there is a `TypeError`. Both roots are now checked, including the TypeScript `namespace`/`enum` declarations the scope resolver does not record. A **test file is inert**: `expect(NaN === NaN).toBe(false)` pins the constant down on purpose and has no branch at all.

**Not shipped, with reasons.** The other six all require knowing something about the VALUE, and this engine reasons about syntax. *`parseInt` without a radix* is a provable omission but not a provable defect — since ES5 the default is 10 unless the string carries an `0x` prefix, and ESLint's `radix` rule already owns the style question. *`Number("")` being `0`* needs proof that the operand can be the empty string. *Integer division*, *`%` on a negative operand* and *an off-by-one `slice` bound* are claims about ranges. *`Math.max()` of an empty array* needs proof the array can be empty, which is the emptiness analysis §145 already declines to fake.

## 202. Encoding & Buffer-Semantics Correctness ★
**Status: Partially shipped** · `no-string-length-as-content-length`, `no-chunk-string-concat`

`Buffer.byteLength` vs `.length` confused, a `latin1`/`utf8` mismatch that silently corrupts, `toString()` splitting a multibyte character at a chunk boundary, base64url vs base64 confusion in a token path, and `Buffer.compare` where `timingSafeEqual` is required.

**Two of the five shipped — the two where a byte count and a character count are provably different things.**

`no-string-length-as-content-length` — `String.prototype.length` counts UTF-16 code units and `Content-Length` counts bytes on the wire. They agree for ASCII, which is why this survives every test written in English, and when they disagree the header is always too *small*: the client reads exactly what it was promised and stops, truncating the body or, on a keep-alive connection, desynchronising so the leftover bytes are parsed as the next response. An emoji in a display name is enough. The hunt cut this one down hard, and correctly. A LITERAL is now decided by **arithmetic** rather than by shape — compute both counts and compare — so a canned `"Not Found"` body, a hex digest and a base64 token, every byte of which is ASCII, are correct code and stay silent. Everything decided by a METHOD NAME came out: `String(n)`, `Date#toISOString()`, `join()` over numbers all produce ASCII, and telling them from a non-ASCII case needs the value, not the name. `set` and `header` came out too — a `Map` of column widths keyed by a header name is not a response. What remains is `setHeader`/`writeHead` with `JSON.stringify(…)`, a template carrying substitutions, a concatenation, or a literal that genuinely encodes to more bytes than it has characters.

`no-chunk-string-concat` — the commonest body-collection snippet in circulation. A `data` chunk is a Buffer sized by the network, so `+=` decodes each one on its own and a character straddling the seam becomes replacement characters. Verified end-to-end against a real HTTP server: a body split across two TCP segments arrives as `{"name":"café ￯﾿ﾽ￯﾿ﾽ￯﾿ﾽ naïve"}`. The catalog's framing needed correcting on one point — it does **not** surface as a parse failure. `U+FFFD` is legal inside a JSON string, so `JSON.parse` succeeds and the corrupted value goes straight to the database: silent data loss on a fraction of requests, not an error anybody gets paged for. The claim is "these chunks are Buffers", and the hunt showed how often that is false: `Readable.from(["a","b"])`, any `objectMode` stream, `split2()`, `through2.obj()`, a `serialport` `ReadlineParser`, an `iconv-lite` `decodeStream`, `Readable.fromWeb` over a `TextDecoderStream` — on every one of those the chunks are strings and `+=` is correct. Eighteen of the hunt's claims were that shape, so the receiver is now **proven** rather than assumed: `process.stdin`, a `net`/`tls` socket, an `http`/`https` request or response, a `child_process` handle's `.stdout`/`.stderr`, or an `fs.createReadStream` opened with no encoding — each traced to the builtin it came from. Any `setEncoding` still drops the claim, and the accumulator must be provably initialised to a string. What that costs was then measured rather than assumed, and the first estimate was wrong. On a 525,810-file corpus the shipped rule reports **28 findings across four packages** — `@electron/windows-sign`, `json5`, `pstree.remy`, `simple-update-notifier` — every one a `child_process` handle, a `process.stdin` read or an unencoded `createReadStream`. The un-narrowed version fired considerably more widely, and the difference is not all noise: Metro's JSON body parser, Next's dev-server middleware and Cloudinary's API client take the stream as an opaque function parameter, which cannot be traced to a builtin from inside one file, so none of them is reported any more. Neither is a transpiled interop shape (`_fs2.default.createReadStream(…)`) nor a `cross-spawn` handle, which is a real `ChildProcess` from a package this rule does not know. Those are real bugs it will not find. They are the price of never reporting the eighteen string-emitting stream shapes the hunt produced, and on a precision-first bar that is the right side to err on.

**Not shipped, with reasons.** *A `latin1`/`utf8` mismatch* has to pair an encode with the decode that undoes it, across files. *base64url vs base64 in a token path* needs to know that the string reaches a URL, and the two alphabets differ in three characters that most payloads never contain. *`Buffer.compare` where `timingSafeEqual` is required* is already covered by §66's `no-timing-unsafe-secret-compare`; a provenance-based version (comparing the result of `createHmac(…).digest()`) would strengthen that rule rather than add a second one, and belongs there.

## 203. Filesystem-Primitive Failure Modes ★
**Status: Scoped and rejected** — every sub-case, with reasons, in the scoping pass recorded at the end of this part

A write that is not atomic (no temp-then-rename), `EMFILE` from unbounded concurrent opens, a `readdir` on a directory being written, a `watch` firing twice per change, and a path assumed case-sensitive that is not on macOS/Windows.

## 204. Time-Source Correctness ★
**Status: Partially shipped** · `no-oversized-timer-delay`

The non-timezone half of §116, provable where the timezone half is not: `Date.now()` used for elapsed time (it jumps with NTP; `performance.now()` is monotonic), a timeout computed from wall-clock subtraction, and `setTimeout` with a delay above 2³¹−1 (which fires immediately).

**The overflow shipped.** Node stores a timer delay in a signed 32-bit int, so anything above 2,147,483,647 ms (24.85 days) is clamped to **1 ms** — the session expiry meant for next month runs on the next tick, and a monthly `setInterval` becomes a 1 ms hot loop. The arithmetic reads as obviously correct (`1000 * 60 * 60 * 24 * 30` is plainly "30 days"), which is exactly why it survives review, and nothing but production ever waits long enough to notice. The claim is arithmetic, so it is made only where the arithmetic is: the delay must fold to a number from numeric literals and `+ - * / **` ALONE — a variable, a config read or a call is never folded, however plainly its name says `THIRTY_DAYS`. The callee must be a global `setTimeout`/`setInterval` with no local binding over it, or a `node:timers` import that still resolves to that import at the call site, so a fake-timer harness or an injected scheduler with its own units is never judged.

**Not shipped, with reasons.** *`Date.now()` for elapsed time* is true as a fact and useless as a finding: measuring a request or a query with wall-clock subtraction is what essentially every Node service does, the NTP step it warns about is rare and small, and a rule that fires on all of it is a style linter wearing a correctness badge. *A timeout computed from wall-clock subtraction* is the same claim one step further on.

---

# Part XLVIII — Authoring Provenance & Shape

*The final lens, and the most on-thesis: what the **shape** of the code says about how it was produced. Agents write recognizable code, and its failure modes are recognizable too.*

## 205. Agent-Artifact Detection ★★ Flagship
**Status: Partially shipped** · `no-unimplemented-stub`

Residue that ships because nobody read the diff: a `// TODO: implement` in a merged function body, a stub returning a hardcoded literal where an implementation belongs, commented-out alternatives left beside the chosen one, an obviously-templated docstring describing a different function. **A placeholder identifier is naming taste, not a defect** — the rule must fire only on unambiguous residue, or it becomes a style linter.

**The unambiguous form shipped**, and the section's own warning turned out to be the hard part rather than the easy one. `no-unimplemented-stub` fires on a function body with **zero statements** whose comment admits it was never written — the author stating the fact, and the rule repeating it. It returns `undefined` silently: nothing throws, nothing logs, and the caller gets a value that is falsy now and `NaN` once it reaches arithmetic.

The first version matched the bare words `implement`, `stub` and `placeholder` anywhere in a comment, and a corpus sweep found it firing on correct code explaining itself — Next's `voidCatch()`, whose comment says it expects "the underlying **implementation** to forward errors", and React Navigation's `removeListener`, which mentions "**placeholder** screens". Matching a domain word in prose is exactly the style-linter failure this section warns about, so a conventional tag now has to be written *as* a tag, at the start of the comment. The same sweep produced a third silence: an **inline callback argument** is never judged, because `req.on("error", () => {})` is a required idiom — the empty body is what stops an unhandled `error` event killing the process — and Next ships precisely that with a `// TODO: log socket errors?` beside it.

**Not shipped, with reasons.** *A stub returning a hardcoded literal* cannot be told from a legitimate constant function. *Commented-out alternatives* is a claim about what commented text means. *A templated docstring describing a different function* is §178's territory, and its four unprovable sub-cases are already recorded there.

## 206. Hallucinated-API Detection ★★ Flagship
**Status: Core** (`node-doctor api-check`, aliases `hallucinated` / `check-api`) · 🔧 Needs depth for the rest

**Shipped as a command.** `import { readJson } from "fs-extra"` — except `fs-extra` exports `readJson` *and* `readJSON`, and the one the agent picked does not exist. In JavaScript that is **not a compile error**: the import is `undefined`, and the failure is `TypeError: x is not a function` on the first request that reaches the line, in production. It is the single most common way an agent's code is wrong, and it is invisible to every existing check — the type checker sees it only if the package ships types *and* the project is strict, the linter has no idea what a package exports, and the suite passes if that path is uncovered.

The machinery is §175's, pointed at production code and at `node_modules` instead of at mocks and project modules — including its `complete` flag, itself hardened by twelve confirmed findings in §155.

**The claim is "this package does not export that name", so it abstains for the WHOLE package the moment the surface is not fully readable** — never for a single name, because a partially-read surface makes every absent name suspect. It skips, with a stated reason: a package that is **not installed** (`node_modules` is the only place the truth lives, and absent it says the check did not run rather than that the code is fine); a surface that is **not enumerable** (an unfollowable `export *`, a runtime-built `module.exports`, a parse failure); a **types-only** entry, because a `.d.ts` is a claim about the runtime rather than the runtime itself; a **dual ESM/CJS** package whose two entries export different names, since neither is authoritative; and a package used through **any computed access**, since `lib[name]` could be reaching anything. Named imports are checked under their *source* name, a local binding **shadows** the namespace import it collides with, and members read off a *default* import are not the named-export set and are never checked. Deep imports (`pkg/sub`) resolve through their own exports map and belong to §185.

Zero false claims across this project's own 407 files, with eleven of its twelve dependencies honestly reported as skipped — which is the report working, not failing.

## 207. Copy-Paste Divergence ★ Differentiator
**Status: Planned** · 🔧 Needs depth

Two structurally-identical blocks differing in one token — the classic copy-paste bug, and the one agents produce most: the same handler duplicated with one `userId` left as `orgId`. §122 fingerprints duplicates; this reports the *divergence within* a near-duplicate, which is where the bug is.

## 208. Defensive-Bloat & Redundant-Guard Detection ★
**Status: Scoped and rejected**

The opposite failure: a null check on a value that provably cannot be null, a `try`/`catch` around code that cannot throw, a type check on an already-narrowed value, a re-validation of input validated one frame up. Agents over-defend, and the noise hides the guards that matter.

**All four need the analysis this engine refuses**, and the word doing the work in each is the same one: *provably*. "Cannot be null" is a type-and-flow fact, "cannot throw" is a whole-program fact, "already narrowed" is a control-flow fact, and "validated one frame up" is interprocedural. A rule that guessed at any of them would report correct defensive code as bloat — which is the more expensive error, because the guard it tells you to delete is the one that was doing something.

## 209. Inconsistent-Abstraction-Level Detection ★
**Status: Planned** · 🔧 Needs depth

A function mixing a raw SQL string with a domain-service call, an HTTP handler doing its own connection pooling, a business-logic module reading `process.env` directly. Layering violations (§33) at the *statement* level rather than the module level.

## 210. Comment-Density & Explanation-Debt Signals
**Status: Vision** · 🛰 Needs infra

Where the code is least explained relative to its complexity and churn — the modules a new engineer (or agent) will most likely misread. Combines §35's complexity, §160's churn and comment density into a targeting signal.

---

## Honest read: what to actually build

Of §185–§210, **§206 and §190 shipped first** — the two the catalog's own read ranked highest, and both with no precision cliff. §206 is the defining agent failure mode and reuses machinery §175 already proved; §190's structured-clone boundary is a hard syntactic edge with a `DataCloneError` behind it.

**§185 and §195 followed**, in that order. §185 shipped whole as `exports-check`: it is pure resolution arithmetic, and every one of its seven problems is a load that throws for a consumer and resolves for the author. §195 shipped **one of its five sub-cases** — `detached` without `unref` — and the four it did not ship are recorded above with reasons; each fails on the same boundary, which is that "this never happens anywhere" is a whole-program claim and "this option is set and this method is never named" is a syntactic one.

**Five more shipped in one wave**, chosen on a single criterion — the claim has to be an always-wrong fact about the language or the runtime, not an inference about the data: `no-nan-comparison` (§201), `no-oversized-timer-delay` (§204), `no-dirname-in-esm` and `no-url-as-filesystem-path` (§199), `no-literal-listener-removal` (§194). Each catalog section above now records which of its sub-cases shipped and, for the ones that did not, the specific thing they would have to know that syntax does not say.

The wave was gated on a corpus sweep of **466,000 real files** across eighteen projects and their dependency trees, plus an adversarial hunt whose 42 claimed false positives were each reproduced by hand. Between them they found six genuine precision defects — a rule that checked whether `NaN` was rebound but not whether `Number` was, two rules that bound imported names without re-checking them at the call site, a `typeof` guard treated as a reference, a bundler-loaded config treated as a Node module, and a set of `path` functions that included four which work correctly on a URL — and two real bugs in published packages (`@tiptap/core`, `@swc/helpers`) plus one in the Chrome DevTools frontend.

**A third wave took §196, §197 and §202**, on the same criterion and with the same gate: four rules, each an always-wrong fact, validated against 544,000 real files and an adversarial hunt of 318 cases whose 43 claims were every one reproduced by hand.

The lesson of this wave is narrower than the last one and more useful: **an always-wrong fact is always wrong only in the context you checked it in.** Two of the four rules asserted runtime behaviour that is real on the main thread and false inside a Worker — `process.on("SIGKILL")` throws in one and not the other, and `process.exit(1001)` is masked in one and delivered intact in the other. Neither is discoverable by reading the documentation; both took ten lines of Node to settle. The same wave also corrected the catalog's own description of two bugs: a `SIGKILL` handler does not silently never fire, it throws where you register it; and a chunk-split multibyte character does not surface as a parse failure, it parses fine and silently stores corrupted text. Running the runtime rather than reasoning about it is now the standing rule for any claim about what Node does.

**The remaining ⚙️ Now sections were then scoped in full — §188, §189, §193, §200, §203, and the leftovers of §194/§198 — and the honest answer is that most of them cannot ship.** Thirty of thirty-seven sub-cases were rejected, each with the specific thing it would have to know that syntax does not say, and those reasons are recorded in the sections above so the catalog does not re-litigate them. Three of the rejections corrected the catalog's own premise: `export *` chains do not defeat modern bundlers, `fs.watch` firing twice is not the invariant the section assumed, and an absent `.map` file does not make a stack trace unreadable.

What survived is not what the catalog expected. The two rules that shipped from those six sections are both **adjacent** to a listed sub-case rather than one of them — a write to a sealed module namespace object (§188), and iteration over a pre-sized array's holes (§200). Five further candidates passed the decidability bar but were declined on yield: `setSourceMapsEnabled` in an ES module, `await` on a `Writable.write()`, callback-form `pipeline()` with a non-function tail, a function literal in a `process.send` payload, and a DOM-style options object passed to `EventEmitter.on` — the last of which is a genuine always-wrong fact (Node ignores the third argument entirely, so `{ once: true }` silently does nothing and the listener leaks) but needs a receiver proof that costs more than the fifteen instances in half a million files are worth. Any of them can be revisited; none of them is a gap.

Next: the AI pack is where the remaining depth is. §110–§113 stay **Vision** — they need git-metadata attribution, the original spec, or a signing chain, none of which the deterministic offline core has — and §205's shipped case is one of four, with the other three recorded above as unprovable.

**§207 copy-paste divergence and §209 abstraction-level are the two most likely to fail a precision hunt**, and if they do they should not ship. **§205 agent-artifact detection** is the most on-thesis but needs the sharpest scoping in the set: `// TODO: implement` in a merged body is a fact, and a variable named `data2` is taste — a rule that cannot tell them apart is a style linter wearing a correctness badge. The same discipline governs as it has for 206 sections.
