# Changelog

All notable changes to node.doctor are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
semantic versioning. The JSON report's `schemaVersion` is bumped on any breaking
change to that shape.

## [Unreleased]

CLI, terminal UX, configuration, and the diagnostic set are substantially
expanded — closing the remaining parity gaps with react-doctor's tooling surface
while staying offline-first and deterministic.

### Package API semver lint — `node-doctor semver` (§155)

- **`node-doctor semver`** (aliases `api-semver`/`exports`) — semver linting for
  internal package exports. Extracts each workspace package's name-level export
  surface (ESM incl. recursive relative `export *` and structure-aware
  destructuring; CJS `exports.x` / `module.exports = {…}`; `dist/` entries fall
  back to their `src/` twin), snapshots it with `--baseline`, and lints changes:
  a removed export without a major bump (or a 0.x minor) exits 1; additions with
  an unchanged version are advisory. A partial surface (unfollowable `export *`,
  opaque or spread `module.exports`) never yields a removal claim, an
  unresolvable entry is unanalyzed rather than guessed, and a removed package is
  info (no version left to lint). Deterministic, offline.

### Queue & topic topology — `node-doctor queues` (§157)

- **`node-doctor queues`** (aliases `topics`/`topology`) — the event-driven import
  graph: who publishes to each topic/queue and who consumes it, across kafkajs,
  amqplib, BullMQ/bull, NATS, MQTT, and Redis pub/sub. Reports **orphan topics**
  (published, never consumed — messages into the void) and **dead consumers**
  (subscribed, nothing publishes — dead code that looks alive). Precision: every
  fact receiver is traced to a client binding constructed from the library's own
  entry point — `new Kafka(…)` → `.producer()`, `amqp.connect(…)` →
  `.createChannel()`, nats/mqtt `connect(…)`, `new Redis()`/`.duplicate()` — so an
  EventEmitter's `.publish`, an RxJS `.subscribe`, or a broker-named object yields
  nothing regardless of imports; topics come only from static strings, bull's ambiguous single
  `Queue` claims nothing until a same-file `.add`/`.process` classifies it, and a
  dynamic topic suppresses exactly the claims it could hide while the map still
  renders. A same-file consume+publish loop is info, never judged.

### Schema drift & dead data — `node-doctor schema-drift` (§142)

- **`node-doctor schema-drift`** (alias `dead-schema`) — the Prisma schema crossed
  against every statically-visible model access, both directions. **Drift**: a
  `where`/`select`/`data`/`orderBy`/aggregate key naming a field the schema does
  not define — the runtime `PrismaClientValidationError` found at build time, with
  a did-you-mean suggestion (exit 1). **Dead models**: schema models no code path
  touches. A dependency-free `.prisma` parser (models, `@@map`/`@map`, relations,
  compound `@@unique` aliases, enums, multi-file schemas); operators, relation
  traversals (validated against the related model), and compound where-unique keys
  are understood; any spread/computed key silences its object; dead-model claims
  require a full proof — no dynamic `client[expr]` access and no unresolved raw
  SQL anywhere, with resolved raw-SQL tables crediting their models via `@@map`.

### Diagnostics — timeout budget consistency (§136)

- **`no-inverted-timeout-budget`** (Reliability, §136, opt-in) — an outer timeout
  budget B (the `p-timeout` package — proven **by binding**, not by name — or a
  `Promise.race` against a provably-rejecting timer) governing an operation whose
  outbound call keeps trying for T > B: the caller gives up at B while the HTTP
  request runs to T — orphaned work and a held socket, the connection leak that
  only shows under load. Hardened against an adversarial hunt: a same-file
  `withTimeout(fn, retries)` retry helper, a lock wrapper taking seconds, a
  resolve-only sleep, a `.timeout(n)` query method, a conditionally-rejecting
  guard, a `timeout` field in a POST **body**, and a shadowed local `fetch`/`got`
  are all silent — every client is verified by its import, and hops follow only
  module-level `const`/`function` bindings. Both numbers must be statically
  provable; the correct inner-≤-outer direction is never flagged. A second
  adversarial round hardened the proofs further: a name declared more than once in
  the file (a block-scoped shim shadowing the import, a shadowing param) is
  ambiguous and never proven; only IMMUTABLE bindings (ESM import /
  `const … = require`) prove a package — a reassignable `let`/`var` never does; a
  race-timer helper must RETURN its rejecting timer (not merely contain one),
  must not reassign its delay param, must reject unconditionally (no
  `if (CHAOS)` guards inside the callback), and must not `clearTimeout` itself;
  and a constructed-but-not-invoked closure (a factory-returned thunk, a lazy
  stream `.map`, a thenable lookalike's `.then`) never counts — array callbacks
  are followed only in the provable `Promise.all(ids.map(cb))` combinator shape.

### Data access map — `node-doctor data-map` (§143)

- **`node-doctor data-map`** (alias `lineage`) — the matrix of which routes touch which
  database entities, and how (read/write/delete). It walks the project call graph
  forward from each route handler (cross-file, depth-bounded), classifies every query
  call it reaches with a single pure `queryTarget`, and unions the `(entity, op)` pairs;
  inverting the index answers "which endpoints write `payments`?". Recognizes Prisma
  model calls, TypeORM `getRepository`, ORM `Model.method()`, Knex builder chains, and
  raw SQL — `db.query(...)`, `prisma.$queryRawUnsafe(...)`, and Prisma's typed
  tagged-template `` $queryRaw`…` `` / `` $executeRaw`…` ``. Raw-SQL **template
  literals** with interpolations are read from their static parts
  (`` `SELECT * FROM users WHERE id = ${x}` `` → `users:read`), while an interpolated
  **table position** (`` FROM ${t} ``), a bare `` sql`…` `` tag, and any
  dynamically-built SQL stay deliberately unresolved (counted, never guessed). The
  SQL reader strips comments, string literals, and row-locking clauses
  (`FOR UPDATE OF …` / `SKIP LOCKED` / `NOWAIT` / `FOR SHARE`) before parsing and
  resolves quoted/schema-qualified identifiers (`"public"."Users"` → `Users`), so a
  keyword hidden in a comment/value or a locking clause never invents a phantom
  table; the Knex/ORM side is gated on a db-hint chain root and a known query method,
  so `Buffer.from(…)` / `Array.from(…)` / `Object.create(…)` are never read as tables.
  Deterministic and offline; entities sorted, ops in fixed `read < write < delete` order.

### Observability coverage — `node-doctor observability` (§151) + frontier wave F

- **`node-doctor observability`** (alias `observe`) — the observability equivalent of
  test coverage: "could you debug this route at 3am?". It scores each route's handler
  on four checks — does an async path have error handling, does a failure path emit a
  log (a swallowing `catch`/`.catch(() => {})` fails), are outbound calls timed, and
  do logs carry a correlation/request id — as pass/fail/**na** (a risk a route cannot
  have never counts against it), and reports a per-route + codebase score. Only
  `(req, res)`/`ctx`-shaped handlers are scored, so a `cache.get(key, loader)` /
  `config.get(x, default)` look-alike is never mistaken for a route. Deterministic;
  cross-file handlers are under-reported rather than guessed at.
- **`no-wildcard-body-parser`** (Security, §149, opt-in) — a body parser that accepts
  ANY content-type (`express.json({ type: "*/*" })` or `type: () => true`), so a
  form/text/binary body is parsed as JSON and a client can mislabel a body to bypass
  content-type-based validation. Silent on scoped media types, real type predicates,
  and the `res.json` response serializer.

### Diagnostics — frontier wave E (§141/§156/§154)

A correctness + supply-chain wave. The two new opt-in diagnostics were hardened
against an adversarial false-positive hunt.

- **`no-unstable-offset-pagination`** (Bugs, §141) — offset/`skip` pagination with no
  stable `ORDER BY`, so pages silently drop and duplicate rows as data changes
  between fetches. Covers Prisma (`.findMany({ skip })` on a DB-shaped receiver, no
  `orderBy`), query-builder `.offset().limit()` chains, and raw SQL (`OFFSET` or
  MySQL's `LIMIT offset, count`) — all only when the SQL is a readable literal and no
  order clause is present.
- **`no-unpinned-dependency`** (Security, §156, text-scan on `package.json`) — a
  dependency pinned by a git ref / tarball URL / floating tag (`*`, `latest`, …),
  which makes the build non-reproducible and is a supply-chain risk. Normal semver
  ranges and intentional protocols (`workspace:`, `file:`, `npm:`, `jsr:`, …) are
  silent.
- **`node-doctor deslop` now detects undeclared / phantom dependencies (§154)** — a
  package **imported but not declared** in `package.json` (working only via a hoisted
  transitive dep; breaks on `--production` / a tree change). Node builtins, the
  package's own name, and same-scope workspace siblings are excluded, and imports are
  checked against the **nearest-ancestor** `package.json`, so a sample app under
  `tests/fixtures/` is never attributed to the root manifest.

### Diagnostics — frontier wave D (§140/§137/§138)

Three opt-in, precision-first rules anchored on the highest-severity item in the
frontier catalog. Each was hardened against an adversarial false-positive hunt and
produces zero findings on this repo's own source.

- **`no-cross-tenant-cache-key`** (Security, §140) — the flagship: a cache write
  (`cache.set`/`redis.set`) whose value depends on a user/tenant identity
  (`req.user.id`, `req.tenantId`, …) that the key omits — so one user is served
  another's data from cache. Fires only when the key is a fully-readable inline
  expression proven to omit the id (opaque/variable keys stay silent), and excludes
  audit-stamp fields (`createdBy`), per-session keys (`sess:${sid}`), and generic
  non-cache receivers.
- **`no-dropped-abort-signal`** (Reliability, §137) — a function that receives an
  `AbortSignal` but makes an outbound `fetch`/`axios`/`got` call without forwarding
  it, so a caller's abort leaves the request running. Excludes unix-signal params
  (string-compared / interpolated / switched).
- **`no-liveness-check-with-dependency`** (Reliability, §138) — a liveness probe
  (`/healthz`, `/livez`, …) that checks a downstream dependency (DB / network /
  Redis), turning one dependency failure into a fleet-wide restart. Segment-based
  path matching (readiness paths and content routes like `/health-tips` excluded);
  in-memory caches are not treated as a network dependency.

### Diagnostics — frontier wave C (§132/§135/§152)

Three opt-in, precision-first rules for outage-class defects nothing else catches
(`defaultEnabled: false`, so they never affect the default health score). Each was
hardened against an adversarial false-positive hunt and produces zero findings on
this repo's own source.

- **`no-retry-amplification`** (Reliability, §135) — stacked retries that multiply
  into a thundering herd: a retry wrapper (`pRetry`/`retry`/`backOff`/…) whose
  operation itself retries, either via a nested retry wrapper or an auto-retrying
  SDK client. Client detection is gated on the SDK actually being **imported**
  (`@aws-sdk` `.send()`, `got`, `stripe`, `axios`+`axios-retry`), so a receiver
  merely named like a client (`emailClient.send`, a local `got`) never fires.
- **`no-sequential-independent-awaits`** (Performance, §132) — independent network
  **GET** reads awaited one after another that could run in parallel
  (`Promise.all`) to collapse latency from the sum of the round trips to the max.
  Network-reads-only by design: writes (POST/PUT/…) and **DB queries** are never
  flagged, because parallelizing them is unsafe on a single connection / inside a
  transaction (ordering, connection, partial-failure semantics).
- **`no-lost-async-context`** (Reliability, §152) — `AsyncLocalStorage.getStore()`
  inside an EventEmitter listener, where the callback runs in the emit-time context
  and the request/tenant/trace context is silently lost. Fires only when the
  receiver resolves to an `AsyncLocalStorage` instance and the read is lexically the
  listener body.

### Agent context hygiene — `node-doctor context` (§158)

A new subcommand and a new privacy surface: the files an AI agent must never load
into context. It scans the on-disk working tree (including gitignored files — an
agent reads the filesystem, not git) and classifies the sensitive ones: `.env`
files, private keys / key material, credential files (`.netrc`, `.pgpass`, GCP
service accounts, an `.npmrc` with an auth token), database dumps, and config/data
files carrying an embedded provider key. It reports which are not yet fenced off by
an ignore artifact the agent honors, and with `--write` generates them —
`.aiignore`, `.cursorignore`, and Claude Code `Read()` deny rules — idempotently
(re-running reproduces byte-identical artifacts and preserves user content).

Precision-first: source code is never flagged (an agent is supposed to read your
code; a secret *in* source is the AST scanner's job), benign fixtures and
`.env.example` templates are excluded, and content detection uses only the anchored
provider-key / PEM patterns — never an entropy heuristic. The generated fences are
verified to actually cover what they flag (scan → write → re-scan reports zero
exposed).

### Diagnostics (62 → 130)

Frontier wave B (FEATURE.md §147/§148) — two opt-in, precision-first rules
(`defaultEnabled: false`, so they never affect the default health score), each
hardened against an adversarial false-positive hunt:

- **`no-shared-cache-authenticated-response`** (Security, §147) — a personalized
  response served with a shared-cacheable `Cache-Control` (`public` / positive
  `s-maxage`) that a CDN can hand to the next user. Fires only when user-identity
  data actually reaches the response *body* (not merely an auth-gate or CSRF read),
  and stays silent when the response is correctly keyed with `Vary: Authorization`
  or overridden to `private`/`no-store`. Covers express, koa (`ctx.state.user`), and
  fastify.
- **`no-unnormalized-identity-comparison`** (Security, §148) — an identity string
  (username/email/tenant/…) compared after case/whitespace folding but without
  Unicode normalization, so homoglyphs (`admin` vs Cyrillic `аdmin`) slip through.
  Narrow by design: requires demonstrated canonicalization intent and two dynamic
  operands (a comparison to a constant is a reserved-name check, not a collision).

Frontier wave A (FEATURE.md §145/§146/§150/§153) — five precision-first rules,
each corpus-verified false-positive-free against ~30k files of real third-party
source, plus a core scope-resolver fix (`catch` clause parameters are now modelled
as their own block-scoped bindings, so a caught name no longer resolves to a
like-named outer `const`):

- **`no-unanchored-security-regex`** (Security/error, §146) — an unanchored regex
  used as a boolean allow/deny gate on an untrusted URL/host (`/trusted\.com/.test(redirectUrl)`),
  the auth/redirect bypass class. Requires a concrete host in the pattern (a bare
  `://` scheme is absolute-URL detection, not an allowlist) and excludes the
  current page's own `window.location` (self-detection).
- **`no-stateful-global-regex-test`** (Bugs/error, §146) — a stored `g`/`y`-flagged
  regex reused via `.test()`/`.exec()` across calls (the `lastIndex` flip-flop bug),
  exempting the in-loop match-iteration idiom. Found real latent instances in
  `mongoose` and `websocket-extensions`.
- **`no-throw-literal`** (Bugs/warn, §153) — `throw` of a string/object/template/array
  literal (stack-trace-losing); silent on `throw new X()` and re-throws.
- **`no-bigint-precision-loss`** (Bugs/warn, §145) — `Number(x)`/`+x`/`parseInt(x)`
  on a provably-BigInt value (the 2^53 precision-loss coercion).
- **`no-nondeterministic-stable-key`** (Bugs/warn, §150) — a random source
  (`Math.random()`, `crypto.randomUUID()`) flowing into an HMAC payload, cache key,
  or idempotency key. Time sources are deliberately excluded (signed timestamps and
  time-bucketed keys are legitimate and indistinguishable from a single file).

- **`no-prototype-pollution`** (Security) — a write with a caller-controlled object
  key, or a literal `__proto__`/`constructor` write.
- **`no-unsafe-deserialization`** (Security) — `node-serialize` `unserialize` or a
  legacy `js-yaml` `load` on caller-controlled data.
- **`jwt-missing-expiration`** (Security) — `jwt.sign` that provably mints a token
  with no `expiresIn` and no `exp` claim.
- **`no-error-leak-to-client`** (Security) — a caught error's stack (or the raw
  error) sent in the HTTP response.
- **`no-circular-imports`** (Maintainability, cross-file) — a runtime import cycle,
  anchored at the exact `import` that closes it. Type-only imports are excluded.
- **`max-function-length`**, **`deep-nesting`**, **`high-cyclomatic-complexity`**
  (Maintainability, opt-in) — code-complexity limits.
- **Test/script auto-relax** — noise diagnostics (e.g. `no-console-log`) are
  dropped automatically in test files and CLI scripts.
- **Suppression near-miss hints** — a finding that fires despite an almost-right
  disable comment (wrong id, or a `disable-next-line` a few lines too high) now
  carries a corrective hint.

Verified at zero false positives across 213 files of real TypeScript; the
`good-app` canary and self-scan stay 100/100.

### CLI

- **New flags:** `--score` (health score only), `--json-compact`, `--audit`
  (surface inline-suppressed findings), `--max-duration <sec>` (time budget →
  advisory results), `--dead-code` (fold the dead-code scan into a normal run),
  `--category <c>` and `--no-warnings` (display-only filters), `--scope lines`
  (gate only on changed lines), `--changed-files-from <f>`, `--include-untracked`,
  and explicit `--color`/`--no-color`.
- **`version` subcommand** — prints version + platform + Node runtime for bug reports.
- **Structured JSON errors** — in `--json` mode a crash or bad flag emits a
  well-formed `{ ok: false, error, … }` report so CI always gets valid JSON.
- **Removed-flag guard** — flags like `--fail-on`/`--format` fail loudly with
  migration guidance instead of being silently ignored.
- **Process hardening** — clean exit on `EPIPE` (piping into `head`),
  SIGINT/SIGTERM handling, and Windows UTF-8 console setup.

### Terminal UX

- **Source code frames** with a caret under the column in `explain` and verbose output.
- **Clickable OSC-8 hyperlinks** on locations in capable terminals (off in CI/dumb terminals).
- **"Report this as a GitHub issue"** prefilled URL in `explain` for false positives.
- **Progress spinner** on an interactive stderr (silent in JSON/CI).
- **`diagnostics --json`** with `--category`/`--tag`/`--framework`/`--configured`
  filters, showing each diagnostic's effective severity and its source (default vs config).

### Configuration

- **Config-writing commands** — `diagnostics set|enable|disable|category|ignore-tag`
  edit `node-doctor.config.json` (or `package.json#nodeDoctor`) in place; an
  executable `.js` config is never rewritten (the block to paste is printed instead).
- **JSON / JSONC config formats** and **walk-up resolution** from the scan root to
  the repo boundary, so a nested package inherits the repo-root config.
- **Per-path `overrides`** — re-severity or disable diagnostics for a glob
  (can even re-enable a globally-off diagnostic for specific files).
- **`rootDir`** config redirect, resolved against the config file's own location.
- **Generated JSON Schema** (`npm run gen:schema`) for editor autocomplete/validation.

### Route shadowing (§4)

- **`no-shadowed-route`** (Bugs, warn, high confidence). A route made unreachable by
  an earlier, more general route on the same Express router — `router.get("/users/:id")`
  registered before `router.get("/users/me")` makes `/users/me` dead, because Express
  matches top-to-bottom and stops at the first hit. The handler you wrote never runs;
  the request quietly hits the wrong one. It is the routing bug that survives review
  because both lines are correct in isolation and only their *order* is wrong.
  - Precise by construction and sound toward silence: same receiver, same file, same
    method (or an earlier `.all`), a fully-static victim, and — the key guard — a
    **constrained** parameter (`:id(\\d+)`) is never assumed to match, so it does not
    shadow `/me`. **Gated to Express and disabled when Fastify is present**, because
    the claim rests on order-based matching; Fastify and hapi resolve by a radix tree
    where a static route wins regardless of order, so the same code is not a bug there.
    Zero false positives across 4,155 corpus files.

### Exploitability proof / attack paths (§121)

- **`node-doctor paths`.** A security finding matters only if it is *reachable*, and
  the interprocedural taint engine already computes the exact call chain that carries
  caller input from a request handler to an injection sink. This surfaces that chain
  as a navigable source→sink path — handler → each named helper → the `eval`/shell/SQL
  sink — with `file:line` at every hop (human + `--json`). It is the proof, not a
  heuristic assertion, that the finding is exploitable, and it exits 1 on a proven
  path so a build can gate on reachable injections. The taint engine now records a
  location per hop (not just a label) to power it. Deterministic — the path is the one
  the graph resolved; an unresolvable dynamic call produced no path to begin with.

### Change-impact / blast radius (§120)

- **`node-doctor impact <files> | --diff [base]`.** "If I touch this, what breaks?"
  answered from the import graph rather than guessed. It walks the graph *backward*
  from the changed files to every transitive dependent, records the shortest hop
  depth to each, and marks the ones that register request handlers — the routes
  whose behaviour a change can actually alter. In a workspace the walk crosses
  package boundaries, so a change in `packages/db` surfaces the apps that ship it.
  Reuses the same `--diff`/`--staged`/`--only`/`--changed-files-from` plumbing as the
  scan path, so `impact --diff main` is the blast radius of a PR.
  - This is deterministic graph reachability, not a heuristic — a file is a
    transitive dependent or it is not, so there is no false-positive surface; an
    unresolved dynamic import simply does not extend reach. Also exposed
    programmatically: `buildImpactGraph` / `computeImpact`.

### AI-feature security, and config drift (§105–§109, §124)

The catalog grows 106 → 112. Node/TypeScript is where most LLM apps, RAG pipelines
and MCP servers are actually built, and that code has its own, largely un-linted,
vulnerability class. An `ai` capability token (set from an LLM SDK dependency —
`openai`, `@anthropic-ai/sdk`, the Vercel `ai` SDK, LangChain, …) and an `mcp` token
(`@modelcontextprotocol/sdk`) gate the whole pack, and each rule *also* requires an
AI-SDK import in the file, so a name collision on a non-AI project stays silent.

- **`no-prompt-injection` (§105).** Caller-controlled input welded into an LLM
  `system` prompt, or concatenated/interpolated into prompt text — built on the same
  interprocedural-taint engine as SQL injection. The isolated, correct shape —
  `messages: [{ role: "user", content: req.body.q }]` — is deliberately silent, and
  so is the Vercel AI SDK's `prompt: req.body.x` (the SDK sends it as a distinct user
  message). Only user text *mixed into* the instructions fires. That distinction is
  the whole precision story, and a first-cut false positive on the Vercel shape was
  caught and fixed in review.
- **`no-llm-output-in-sink` (§107).** Model output reaching `eval`/`new Function`,
  `child_process`, a raw SQL string, an HTML response, or an outbound `fetch` without
  validation — the mirror of §105, where the model is the untrusted source. A binding
  is treated as model-tainted only when its initializer is a recognized LLM call (or a
  `.content`/`.text`/`.output_text` access on one); returning model output as JSON,
  logging it, or `JSON.parse`-ing it is silent.
- **`mcp-tool-unrestricted-capability` (§106, `requires: mcp`).** An MCP tool handler
  that runs shell, an `fs` write, a raw SQL string, or `eval` on a model-controlled
  argument — the model, not a person, drives the call, so an over-broad tool is a
  direct RCE surface. A **parameterized** query (`db.query("… WHERE id = $1",
  [args.id])`) is the safe form and stays silent; only an argument woven into the SQL
  *string* fires. (This false positive was found by an independent adversarial pass
  after the workflow's own hunt reported the rule clean — the reason every diagnostic
  is re-verified by hand.)
- **`no-system-prompt-leak` (§108)** and **`ai-call-in-loop` (§109)** — a system-prompt
  binding echoed back to the caller, and an LLM call inside a loop (a latency, cost and
  rate-limit blowup).
- **`no-unchecked-required-env` (§124, opt-in).** A `process.env.FOO` used as if
  defined — `process.env.FOO!` or an immediate member access — with no default or
  guard: the "works locally, `undefined` in prod" crash at first use. Silent on the
  defaulting/guarding forms, including an early-exit startup guard
  (`if (!process.env.FOO) throw …` then a later access), which a review pass flagged.

Verified at **zero false positives** across 4,155 corpus files and the 8 real
AI-SDK-importing files in it; the pack's positive controls fire end-to-end through the
CLI. The AI-native *governance* ideas from the same catalog (§110–§113 — agent-authored
trust boundaries, spec conformance, incident-to-rule) are deliberately **not shipped**:
they need git-attribution, the task spec, or an AI rule-generation layer that the
deterministic-offline core does not have, and are marked Vision rather than faked.
Money/time/idempotency correctness packs (§115–§117) are likewise held at Planned —
statically proving a value is monetary or timezone-sensitive is not reliable enough,
and the catalog's own rule applies: a false positive there is worse than its absence.

### Type-aware analysis, and API / migration / framework depth (§3, §14, §15, §46)

The catalog grows 95 → 106.

- **Type-aware diagnostics (`--typed`, §46).** An optional pass that reads the
  project's own TypeScript types, for the checks that syntax cannot express. The
  compiler is loaded dynamically and only under `--typed`, so **zero runtime
  dependencies stays zero** — it is an optional peer (`typescript@^5`). Three
  design lines held: a type-requiring diagnostic is *not selected at all* without
  a type source (running it and reporting nothing would look identical to a clean
  result); `--typed` with no usable compiler **fails loudly with an actionable
  message and exits 2**, never a silent empty report; and the type source may not
  time out or race, so byte-identical output survives. The compiler adapter is
  declared structurally and tested against a faithful stub, so the API contract is
  pinned without requiring a particular compiler installed.
  - **`no-floating-promise`** (Reliability, error, `requiresTypes`) — a discarded
    promise, caught even when the callee is typed `(): Promise<T>` rather than
    written `async`, which a syntactic rule misses and which is the majority in a
    real TypeScript codebase. Silent on the documented fire-and-forget forms
    (`void f()`, `f().catch(...)`), and — because the checker answers `"unknown"`
    for `any` and unresolved nodes — never fires on a guess.
  - Note: TypeScript 7's native (Go) build ships **no JavaScript compiler API**, so
    `--typed` against it reports exactly that and points at `typescript@^5`. This
    was found by probing the installed compiler, not assumed.
- **GraphQL / gRPC server setup (§3)** — `graphql-introspection-in-production`
  (a hardcoded `introspection: true`, silent on the `NODE_ENV`-guarded form that
  is the correct pattern), `grpc-insecure-credentials` (a server bound or channel
  dialed with `createInsecure()` to a non-loopback address, gated on a real gRPC
  import so a name collision stays quiet), plus `graphql-missing-depth-limit`
  (opt-in) and `graphql-resolver-returns-raw-error`. Deliberately about setup, not
  schema analysis — a schema reader is a separate project.
- **SQL migrations (§14, §15)** — `migration-destructive-without-guard` (a
  `DROP`/`TRUNCATE` outside a down/rollback section), `migration-add-not-null-without-default`
  (`ADD COLUMN … NOT NULL` with no default, which locks or fails on a non-empty
  table), and `migration-missing-index-on-foreign-key` (opt-in). Multi-line
  statements are reconstructed to the `;` before judging, and a `CREATE TABLE`
  with NOT NULL columns is correctly silent.
- **Framework depth (§2)** — `hapi-route-missing-validation`,
  `hapi-route-auth-disabled`, `restify-missing-error-handler`, each hard-gated on
  its framework capability so it is inert on every other stack.

Verified at **zero false positives** across 4,155 real files; the one migration
finding on the corpus is a true positive (an unindexed `user_id` foreign key in a
real Supabase migration). Sails/Feathers/LoopBack diagnostics were deliberately
**not shipped** — their access-control configuration lives in a separate file, so
any same-file check is guessing; those need the project graph.

### Deploy-config analysis (§24, §25, §26) and web-security depth (§7, §16, §21)

The catalog grows 82 → 95. The new checks read the files that *ship* your code, on
the same whole-tree text scan as the secret scanner — no new dependency, no YAML
or Dockerfile parser pulled in.

- **Dockerfile** — `dockerfile-runs-as-root` (the deployed stage runs as uid 0),
  `dockerfile-mutable-base-tag` (`FROM node` / `:latest`, so the image that passed
  CI is not the image that ships), `dockerfile-secret-in-build-stage` (a credential
  baked into a layer, which `docker history` shows to anyone who can pull it).
  Multi-stage is handled properly: a builder stage running as root is normal, and a
  file with a hardened `--target production` stage is not judged by its dev stage.
- **Kubernetes** — `k8s-privileged-container`, `k8s-host-namespace`,
  `k8s-missing-resource-limits`. Every rule first demands positive evidence that the
  document *is* a workload manifest (`apiVersion` plus a workload `kind`), because a
  repo's YAML is mostly CI config, compose files and Helm values — and
  docker-compose uses the very words these rules look for.
- **GitHub Actions** — `ci-script-injection` (attacker-controlled
  `${{ github.event.* }}` interpolated into a `run:` block, which executes on the
  runner with the workflow's token), `ci-pull-request-target-checkout`
  (`pull_request_target` checking out untrusted PR code with a write token), and
  `ci-unpinned-action` (opt-in). The injection rule is deliberately silent when the
  value is bound through `env:` — that is the documented fix, and flagging it would
  punish people for fixing the bug.
- **Web security and observability** — `no-sensitive-data-in-logs` (a credential
  written to a log sink, where it is retained for years and invisible in review),
  plus `no-xss-in-html-response`, `no-state-change-on-get` and `no-cache-without-ttl`
  as **opt-in**: each needs dataflow this engine cannot do without types, and each
  had verified false positives on ordinary code during review.
- **Framework detection (§2)** — Hapi, Restify, Sails, Feathers, LoopBack, Next.js,
  Remix and Serverless are now recognized. `react-router` deliberately does *not*
  imply Remix: it ships in essentially every React SPA.
- **Convention-registered request handlers.** Next.js App Router and SvelteKit
  register routes by *file convention* — `export async function GET(request)` —
  and Remix by exported `loader`/`action`. There is no registration call, so the
  registration-based detector saw none of them: node.doctor reported
  `detected: next` and then missed the blocking call in every route, leaving the
  tool's central analysis silently inapplicable to a very common stack. Both
  conventions are now recognized, which turns on the whole request-path ruleset —
  sync IO, N+1, unbounded concurrency, missing timeouts, injection via taint.
  Matching is deliberately narrow: `loader`/`action` qualify only with a
  destructured `{ request }`/`{ params }` argument, so a Redux action creator
  does not. Sweeping a real Next.js codebase, this immediately found a
  `gunzipSync` on a client-supplied request body that no earlier version could see.

Verified at **zero false positives** across 4,155 real files (including eight real
GitHub Actions workflows), clean on this repo's own CI config and Dockerfile, with
the `good-app` canary and the `src` self-scan still 100/100.

An adversarial review pass found 25 false positives in the first cut of these rules
— an Istio init container's `NET_ADMIN`, a node-exporter DaemonSet's `hostNetwork`,
a `kubectl apply` heredoc whose *embedded* manifest was parsed as the outer file, a
CSS lexer's `token` variable, `DOMPurify.sanitize` two assignments upstream — and
every one is fixed with a regression test.

### Fixed

- **`lintSource` now honors capability gating (`requires`/`disabledWhen`).** It
  previously filtered a caller-supplied diagnostic list only by `scope`, so the
  ESLint and oxlint adapters — which pass their own list and a hardcoded capability
  set — ran capability-gated rules on the wrong stack (an Express-only route rule
  firing on a Fastify project through the adapter). Every consumer of `lintSource`
  now applies the same gate the CLI/LSP/MCP already did. Found by an adversarial
  review of `no-shadowed-route`, alongside a second false positive where two
  `express.Router()` instances sharing the variable name `router` (the router-factory
  pattern) were conflated; the rule now resolves the receiver to its `ctx.scope`
  binding, so distinct instances are never compared and a reassigned receiver resets.

- **`--json` was silently truncated when piped.** `process.stdout.write()` is
  asynchronous on a pipe, so exiting immediately after the write discarded whatever
  was still buffered: a 400 KB report came out as exactly 65,536 or 131,072 bytes —
  a pipe-buffer boundary — so `node-doctor . --json | jq` failed on invalid JSON
  while the identical run redirected to a file was complete. Both exit paths now
  drain first. This affected every machine-readable mode on any repo large enough,
  and only through a pipe, which is why a file-redirect test never saw it.
- **False positives in `no-deprecated-node-api`.** The rule matched the last two
  segments of a member path with no binding resolution, so it reported Prisma's
  `db.domain.create()`, mem-fs's `generator.fs.exists()`, the `url-parse` package,
  `this.domain.create()`, `opts.crypto.createCipher()`, and every `const fs = { exists }`
  test mock. `new Buffer()` fired on any constructor merely *named* `Buffer` — a
  local ring-buffer class, an import, even a parameter. The receiver must now resolve
  to a real Node built-in imported in that file, and `Buffer` must be the global.
  This loses `this.fs = require("fs"); this.fs.exists()`; under "a false positive is
  a release blocker" that is the right trade.
- **A devDependency no longer marks a whole project "edge".** `wrangler` is a CLI and
  `@cloudflare/workers-types` is types-only, so both live in the devDependencies of
  ordinary Node repos — and every `node:fs` in a plain Express server was reported as
  an error with no escape hatch. Detection now requires a deploy manifest or a runtime
  dependency.
- **`no-node-builtin-on-edge` was wrong about what the edge provides.** Cloudflare
  ships `net`, `tls`, `os`, `http`, `fs` and more under `nodejs_compat` — the documented
  Hyperdrive pattern is literally `import net from "node:net"` — and the rule asserted
  otherwise at error/high confidence without ever reading the compatibility flags. The
  set is now only what no edge runtime provides. It also flagged type-only imports
  (erased at compile time) and Node-only build scripts and bundler configs, which the
  user cannot change.
- **Cross-package findings were nondeterministic and could be dropped.** The §96 pass
  ordered sibling module facts by scan-*completion* (I/O timing), which reached the
  taint hop trail baked into the message and hashed into `evidenceKey` — so the same
  tree produced different keys run to run and CI reported a pre-existing finding as
  newly introduced. Separately, deduping by `evidenceKey` (deliberately
  position-independent) swallowed a genuine cross-package finding whenever the package
  already had a byte-identical boilerplate site, and the `--cache` fast path returned no
  module facts at all, so a warm run silently lost every cross-package finding and
  flipped the gate from fail to pass.
- **CODEOWNERS matching routed findings to the wrong team.** `docs/*` and the ubiquitous
  `packages/*` recursed into nested files (GitHub documents them as matching one level),
  and `**` could not match zero directories, so `src/**/*.ts` missed `src/index.ts` and
  even inverted last-match-wins.
- **`delta --json --risk` emitted two top-level JSON documents**, so the output was
  unparseable — and `jq` exits 0 on two documents, so a CI threshold gate read garbage
  rather than failing.
- **`modernize` claimed `100/100 (current)` over a tree it could not parse**, violating
  the honest-coverage invariant `scan` enforces; and at a workspace root it read only
  the root manifest, dropping the 25-point end-of-life penalty even when every member
  declared an EOL Node.
- **`--risk` was silently ignored** on the `scan --diff` path it is documented for. It
  now works there, and fails loudly when given without a diff scope.
- **`scorePrRisk` reported "no findings introduced" when findings were introduced**
  (the fallback keyed off an unmatched reason bucket, not the finding count), printing a
  reason that contradicted the non-zero score beside it.
- **The §96 pass was superlinear in member count.** It rebuilt a whole-monorepo graph
  once per imported member; it now uses only the transitive importers of that member,
  which is the set that can actually reach into it. On 40 packages / 801 files:
  **16.7s → 0.94s**, and linear rather than ~3× per doubling.
- **Phase B was accidentally quadratic.** `taintedSinkSites()` and
  `reachableSyncIoSites()` are whole-project AST walks, and the project pass calls
  them **once per file** — so the walk ran once per file instead of once per scan.
  On a 427-file package that was 17.9s of an 18s scan; a 4,000-file monorepo was
  effectively unscannable. Both are now memoized per graph: the same package takes
  **1.0s**, and the full 4,101-file, 11-project monorepo scans in **22s**. Locked in
  by a regression test that asserts each collection is computed once per graph.

### Runtime awareness & organizational routing (§83, §85, §89, §90, §94, §95, §96)

- **Cross-package call graph (§96)** — in a workspace, the import graph now crosses
  package boundaries: a handler in `apps/api` that reaches a `readFileSync` in
  `packages/db` is a finding, where before each package was analyzed in isolation
  and the request path simply vanished at the `@acme/db` specifier. Findings are
  attributed to the package that **contains** the code, not the one that reaches it
  — that is the team who has to fix it.
  - Bounded by design: only members another member actually imports are revisited,
    and results are deduplicated by `evidenceKey`, so what survives is exactly the
    set that needed the cross-package edge to be seen at all.
  - Workspace layout is threaded through `buildProjectGraph` rather than held in
    module state, so two concurrent scans can never see each other's packages.
- **Runtime detection (§94, §95)** — Bun (`bun.lockb`, `bunfig.toml`, `bun-types`),
  Deno (`deno.json(c)`), and edge runtimes (`wrangler.toml`, `@vercel/edge`,
  `@cloudflare/workers-types`) are detected and exposed as capabilities.
- **`no-node-builtin-on-edge`** (Reliability) — importing `node:fs`,
  `child_process`, `worker_threads` and friends in a project that targets an edge
  runtime, where they do not exist. Gated on the `edge` capability, so it is
  completely silent on a normal Node service. Handles both `import` and `require`.
- **`no-deprecated-node-api`** (Maintainability, §83) — `url.parse`, `url.resolve`,
  `util.isArray`, `util._extend`, `fs.exists`, `crypto.createCipher` /
  `createDecipher`, `os.tmpDir`, `process.binding`, `domain.create`, and
  `new Buffer()`. Matched on the member path, so `router.parse(x)` and
  `queue.exists(k)` stay silent.
- **`node-doctor modernize` (§85)** — a modernization score separate from the health
  score, because the two diverge: code can be entirely correct and still be built on
  `new Buffer` and a Node major that left support two years ago. Density-based (so a
  large codebase is not punished for being large), with a 25-point penalty and an
  explicit note when `engines.node` targets an end-of-life release.
- **`--owners` (§89)** — group findings by CODEOWNERS team, following GitHub's
  semantics (last matching rule wins; a rule with no owners deliberately clears
  ownership). Unowned findings are grouped under `(unowned)` rather than dropped —
  silently hiding a finding because nobody claimed the file is exactly how it goes
  unfixed.
- **`--risk` (§90)** — one explainable PR risk score on the delta path, from the
  findings introduced and the breadth of the change, with plain-language reasons.
  An unrecognized category can no longer produce `NaN` (which would have surfaced
  as "low risk" and waved the change through).

### Editor integration: a language server (§41, §53)

- **`node-doctor lsp`** — a Language Server over stdio, so findings appear under the
  cursor as you type instead of behind a CLI run. The wire protocol is hand-rolled
  (Content-Length framing) rather than pulling in `vscode-languageserver`:
  node.doctor still ships **zero runtime dependencies**, and the decoder is a pure
  function, so the nasty cases — a header split across reads, two messages in one
  chunk, a multi-byte character on a boundary — are unit-tested rather than hoped for.
- Analyzes the **unsaved buffer**, so squiggles track what you are actually typing.
  Per-document debounce with supersede; a newer edit cancels a stale analysis.
- **A syntax error mid-edit keeps the last good diagnostics** rather than flashing
  the list empty on every incomplete keystroke.
- **Hover** cards (title, category, severity, the exact fix) and a **quick fix** that
  inserts a suppression comment *with a mandatory reason placeholder* — a bare
  suppression would only trade one finding for `suppression-without-reason`.
- Only file-scope diagnostics run in the editor; cross-file and secret scanning stay
  with the CLI, where they belong.
- **VS Code extension** under `editors/vscode` — a thin client, so the editor can
  never disagree with CI. Resolves the server as: setting → the workspace's pinned
  `node_modules/.bin/node-doctor` → `npx`.

### Security & API depth

- **`node-doctor surface`** (§70) — maps every externally reachable route with its
  middleware chain and auth posture, and flags routes with no recognizable guard.
  Route extraction is deliberately conservative: a path that is a bare variable is
  not recorded, because it is indistinguishable from `cache.get(key)`.
- **`node-doctor surface --baseline <f>`** (§78) — diffs the API surface and fails on
  **breaking** changes: a removed route, or one that now requires auth it did not
  before. Relaxed auth and added routes are reported as non-breaking.
- **`node-doctor sbom`** (§67) — CycloneDX 1.5 or SPDX 2.3 for the dependency tree,
  resolved from the lockfile (npm v2/v3, pnpm, yarn), offline and deterministic,
  with correct percent-encoded purls for scoped packages.
- **`--history`** (§68) — scans git history for credentials that were committed and
  later deleted. A deleted secret is still in every clone; the report says
  `ROTATE IT`. **The secret value is never emitted** — only the variable name.
- **IaC security** (§72) — three text diagnostics for Terraform and CloudFormation:
  `no-open-security-group` (ingress from `0.0.0.0/0`; egress and public web ports
  deliberately exempt), `no-public-cloud-storage`, and `no-overbroad-iam-policy`
  (fires only when action **and** resource are both wildcards). YAML/JSON must
  prove it is IaC before any of them fire, so docker-compose and CI files are safe.

Catalog: 77 → 80 diagnostics.

### Semantic depth: interprocedural taint (§56) and control-flow

- **Interprocedural taint** — the sound version of the intra-file heuristic. Taint now
  flows forward from every request handler **across call boundaries by argument
  position**, through the project call graph, carrying a hop trail. Exposed on
  `ProjectGraph` (`taintedParamsOf`, `taintPathTo`, `taintedSinkSites`) and computed
  lazily, so it costs nothing unless a diagnostic asks for it.
- **`no-tainted-sink-via-helper`** (Security, cross-file) — caller data reaching an
  `eval`/shell/SQL sink inside a helper, reported with the path that fed it
  (`routes.js:handler → service.js:lookup → repo.js:findUser`). Every file looks
  innocent alone; only the graph sees it. A parameterized query fed the same value,
  and an identical sink no handler reaches, both stay silent.
- **`no-cross-request-state-mutation`** (Reliability) — request-derived data assigned to
  module-scope `let`/`var`, the footgun where one user's request overwrites state another
  in-flight request reads. Requires the binding itself to carry the evidence, so a
  same-named `catch` param or loop variable elsewhere in the file cannot implicate it.
- **`no-unreachable-code`** and **`no-constant-condition`** (Bugs) — dead statements and
  dead guards. Hoisted `function`/`var`, TypeScript `declare` forms, `while (true)`,
  `do…while(false)` early-exit blocks, and the `while (m = re.exec(s))` assign-and-test
  idiom are all deliberately silent; only the genuine `=`/`===` typo shape fires.

Catalog: 73 → 77 diagnostics. Verified at zero false positives across ~10,000 real
source files; canary and self-scan stay 100/100.

### Agent loop: conventions, verification, patches & the ratchet

- **`node-doctor conventions`** (§50) — writes AGENTS.md / CLAUDE.md / .cursorrules
  derived from the project's **own** detected stack, so the agent writes correct code
  the first time instead of being corrected afterward. Rule citations are
  capability-gated: a Drizzle project is never told a Prisma-only diagnostic has its
  back. Non-destructive; `--overwrite` to replace.
- **`node-doctor fix --verify`** (§51) — re-scans after the agent finishes and gates on
  the result instead of trusting its exit code. An agent that exits 0 having fixed
  nothing now yields exit 1. Matching is evidence-based, so code the agent merely
  moved is not counted as a regression.
- **`--fix-diff`** (§54) — emits the safe autofixes as a unified diff instead of writing
  them, so an agent can apply a patch rather than re-derive the edit. Verified against
  `git apply`; paths are repo-relative so two checkouts produce identical patches.
- **`node-doctor ratchet init|check`** (§87) — locks today's debt as an accepted
  baseline and fails only on newly introduced findings. The accepted set may only
  shrink and the score floor may only rise, so debt cannot grow back. Tightens
  automatically when a scan is strictly better.

### Agent loop: confidence, provenance & pre-write linting

- **Per-finding confidence** (§54/§101) — every finding now carries `high` | `medium` | `low`,
  derived on a principled rule (threshold/opt-in → low, warn → medium, error → high) and
  overridable per diagnostic. An agent can auto-fix high-confidence findings and escalate the
  rest; the agent hand-off prompt states the policy explicitly. Confidence is a property of the
  **analysis**, not the config — downgrading a severity does not change it.
- **Provenance record** (§104) — every report carries `toolVersion`, `rulesetHash`,
  `configHash`, and the gating `capabilities`, so "why did this pass yesterday and fail today"
  is answerable from the artifact alone. Identical inputs produce an identical record.
- **`node_doctor_check_snippet`** MCP tool (§49) — lint a fragment **before** writing it to
  disk. The cheapest feedback loop there is: the agent corrects the code instead of writing it
  and re-scanning. Reports syntax errors honestly rather than claiming a broken snippet is clean.
- **`node_doctor_scan_diff`** MCP tool (§49) — baseline delta as a tool call, using the
  evidence-based matching so moved code is not reported as new.

### Programmatic API, plugins & install

- **`diagnose()`** — the formal programmatic entry point. `diagnose(dir, opts)`
  returns a report; `diagnose({ directories })` scans many concurrently, captures
  per-directory failures instead of throwing, and aggregates a worst-of score.
- **oxlint plugin** (`node-doctor/oxlint`) — every file-scope diagnostic as an
  oxlint rule, re-running the same engine. Project-scope and text-scan diagnostics
  are excluded (they can't run in a per-file model), mirroring the ESLint adapter.
- **`install --skill improve-node`** — a second bundled skill: a read-only
  audit-then-plan advisor that scans, verifies each finding, and writes a
  leverage-ranked plan under `plans/` without touching source.
- **`install --agent-hooks`** — native post-edit hooks for Claude Code and Cursor
  (scan changed files, surface findings as context; idempotent settings merge).
- **`install --package-script`** — adds a `doctor` script to the nearest
  package.json (with a fallback name if taken).
- **Detected-client default** — `install` now writes to the agent clients actually
  present (CLI on PATH or config dir), unless `--client <name>|all` is given, and
  remembers the selection in `~/.node-doctor/state.json` (never read by a scan).

### Git & CI integration

- **Evidence-based baseline delta** — a finding now carries an `evidenceKey`
  (diagnostic + message + the triggering code), and the delta matches on it with
  a same-file-first, then cross-file, multiset pass. Moving a finding to a new
  line or file no longer reads as "introduced"; only a genuinely new defect does.
  Falls back to the positional `id` for older reports.
- **`node-doctor ci`** — scaffolds `.github/workflows/node-doctor.yml`
  (fetch-depth 0, baseline→head→delta), non-destructive if it already exists.
- **`node-doctor install --git-hook`** — writes an advisory pre-commit hook
  (`node-doctor --staged --blocking warning`, never blocks the commit), husky-aware,
  idempotent, chmod 0755.
- **GitHub Action** now (on a PR) upserts a **summary comment**, posts **inline
  review comments** mapped onto the diff hunks (deduped, capped at 50), and
  publishes a **commit status** with the health score — via self-contained scripts
  (`.github/scripts/*.mjs`, Node built-ins + `fetch`, never fail the build).
- **Markdown reporters** — `renderReportMarkdown` / `renderDeltaMarkdown` (with a
  stable comment marker) and a `--md-out <path>` flag for a Markdown report or a
  `$GITHUB_STEP_SUMMARY`.

### Whole-tree secret / config-file scan (Phase C)

- A second file walk over **non-source** files — `.env*`, `*.pem`/`*.key`,
  YAML/CI configs, Dockerfiles, `*.tfvars`, JSON — for committed secrets that
  never appear in the AST. A new **text-diagnostic** kind (`scan(ctx)` over raw
  file content) whose findings flow through the normal report/score/CI pipeline.
- Three diagnostics: **`no-committed-env-secret`** (a real secret in a tracked
  `.env`, skipping `.env.example` and env-var references),
  **`no-committed-private-key`** (a PEM key in the repo), and
  **`no-secret-in-config-file`** (a provider key hardcoded in YAML/CI/JSON).
- Two precision guards: a **committed-files-only** git gate (a gitignored local
  `.env` is never flagged) and a **per-bucket size cap** (secrets aren't in 8 MB
  blobs). Verified at **zero false positives across 532 real config files**.
- `--no-secrets` (or config) disables the scan.

### Monorepo & performance

- **Workspace multi-project scanning** — point node.doctor at a workspace root
  (npm/yarn/bun `workspaces` or `pnpm-workspace.yaml`) and it discovers every
  member package, scans each as its own project through a bounded pool, scores
  them separately, and reports a **worst-of** health score. Each member's config
  layers additively over the root config. `--project <name|path>` selects members;
  `--no-workspaces` forces a single-project scan.
- **Parallel file analysis** — Phase A runs through a bounded concurrency pool
  sized to the CPU count (`NODE_DOCTOR_CONCURRENCY` to override, `--no-parallel`
  to disable). Output stays byte-identical to a serial run — findings are fanned
  in deterministically in sorted file order.

## [0.1.0] — 2026-07-18

The first release. A sound, offline-first analysis engine plus a curated,
precision-first diagnostic set for Node.js backend defects.

### Engine

- Two-phase architecture from day one: a per-file pass (parse, local facts,
  intra-file diagnostics) and a project pass (import graph + reachability from request
  handlers) so cross-file diagnostics never require a rewrite.
- `oxc-parser` (Rust-backed, ESTree output) with honest parse-failure handling —
  a gap is `complete: false` in the report, never a silent "clean".
- ESTree walker with parent links and an explicit stack (deep nesting cannot
  blow the native stack); shared AST helpers; a lightweight scope/binding
  resolver; request-path detection (method, object-route, decorator, and a
  `(req, res)` signature fallback); intra-file taint that sharpens messages
  without gating findings.
- Capability detection from `package.json` (version-aware: `express:5` retires
  the Express-4 diagnostics); per-diagnostic gating via `requires` / `disabledWhen`.
- Deterministic output: findings sorted by severity, file, line, column, diagnostic;
  stable finding ids; byte-identical runs.
- Diagnostic isolation: a diagnostic that throws is skipped, never fatal.
- Local, transparent, published scoring (density-based, offline).

### Diagnostics

- A precision-first diagnostic set (62 diagnostics) across Async, Event-loop, Database,
  Security (injection + auth/secrets/crypto), HTTP/framework, Reliability, and
  Maintainability. Every diagnostic ships with a valid (does-not-fire) and an invalid
  (fires) test; FP-prone diagnostics are opt-in (`defaultEnabled: false`).
- A `good-app` canary fixture that must stay at zero findings, enforced in CI,
  and `agent-app` / `crossfile` / `deslop-app` fixtures that exercise the engine.

### Cross-file analysis & dead code

- **Project pass (call graph):** the import graph is built from every file's
  facts and reachability is resolved from each request handler. The first
  cross-file diagnostic, `no-sync-io-reachable-from-handler`, flags a `*Sync` sink in a
  helper reachable from a handler *through other files* — while staying silent on
  a helper only reached from module scope.
- **`node-doctor deslop`** — the dead-code scanner: unused files, unused exports,
  and unused dependencies, tuned to not cry wolf (entry points, re-exports, and
  namespace imports are respected).
- **Content-hash cache** (`--cache`): an unchanged file is not re-analyzed between
  runs; results are byte-identical to a cold scan. The cache key includes a probe
  of the enabled diagnostics + severities + capabilities, so it never returns stale
  results after a config change.

### Developer & agent tooling

- **`node-doctor fix`** — scans, then hands the findings to a coding agent (Claude
  Code, Codex, or Cursor) to fix end-to-end. It detects which agent CLIs are
  installed, offers an interactive menu (fix with an agent · copy the prompt ·
  print · skip), and builds a root-cause-first prompt that names the exact fix per
  finding and forbids suppression. `--yes` launches without the menu, `--agent`
  picks one explicitly, `--review` disables auto-accept, `--print` emits the
  prompt for your own agent; a non-interactive shell degrades to printing.
- **MCP server** (`node-doctor mcp`): exposes scanning, the diagnostic catalog, diagnostic
  explanations, and deslop as MCP tools over stdio, so any MCP client (Claude
  Desktop, Cursor, …) can call node.doctor as a native tool — the product thesis
  made literal.
- **`--fix`**: applies only *mechanically safe* codemods (today, `node:` protocol
  prefixes on core-module imports). Security/concurrency findings are never
  auto-fixed.
- **`--html-out`**: a self-contained, shareable HTML report (inline CSS, no
  external requests).
- **`node-doctor explain <diagnostic-id> | <file>:<line>`** and **`node-doctor init`**
  (scaffold a config), plus **`--watch`** for local iteration.
- **Fuzz harness** (`npm run fuzz`) with crash/slow/invariant oracles, and a
  **corpus benchmark** (`npm run bench`) to measure the real false-positive rate.

### CLI & reporting

- `node-doctor [dir]`, `fix`, `diagnostics`, `delta`, `install`; `--json`, `--json-out`,
  `--sarif-out`, `--annotations`, `--verbose`, `--blocking`, `--ignore-tag`,
  `--only` / `--diff` / `--staged`, `--config`.
- Reporters: terminal (score bar + grouped findings), JSON (pinned schema),
  SARIF 2.1.0, GitHub annotations.
- Exit codes: `0` no blocking findings, `1` blocking findings, `2` tool error.

### CI / adoption

- Baseline **delta** (`computeDelta`) that reports only PR-introduced findings —
  the key adoption feature for legacy codebases.
- A GitHub composite Action (`.github/action.yml`) and a copy-paste example
  workflow; GitLab and pre-commit recipes in the README.

### Configuration & suppression

- `node-doctor.config.js` or a `nodeDoctor` key in `package.json`
  (`diagnostics`, `ignoreTags`, `ignore`, `blocking`).
- Inline suppression (`// node-doctor-disable-next-line <diagnostic> -- <reason>` and
  block `disable`/`enable`) with a **mandatory reason** — a suppression without
  one is itself reported.

### Agent integration & API

- A thin, locally-bundled agent `SKILL.md` and `node-doctor install` that writes
  it into Claude Code, Cursor, Windsurf, Codex, Cline, and Copilot paths.
- A stable programmatic API (`scanProject`, `lintSource`, `computeDelta`,
  `calculateScore`, `renderReport`, `DIAGNOSTICS`, `DIAGNOSTICS_BY_ID`, `discoverProject`,
  `shouldEnableDiagnostic`) and a thin ESLint adapter (`node-doctor/eslint`).

[0.1.0]: https://github.com/your-org/node-doctor/releases/tag/v0.1.0
