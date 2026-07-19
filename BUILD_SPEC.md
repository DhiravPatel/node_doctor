# node.doctor — Production Build Specification

**Audience:** an autonomous coding agent (e.g. Claude Code) executing this build end to end.
**Mandate:** ship a production-ready, offline-first static analyzer for Node.js backends, modeled on the *thesis* of [react.doctor](https://www.react.doctor/) / [millionco/react-doctor](https://github.com/millionco/react-doctor) but built for Node — and diverging where Node's realities differ.

> **How to use this document.** Do not attempt to build everything in one pass. Execute the numbered **Phases** in order (§20). Each phase has **acceptance criteria** you must satisfy — with tests passing and the tool actually run against fixtures — before starting the next. If a decision is ambiguous, follow the **Architectural Decisions** (§3) and the **Quality Bars** (§5); when still ambiguous, choose the option that lowers false positives.

---

## 1. Mission and context

Coding agents produce backend code at a volume no review process was built for, and they produce a *specific* class of bug: code that compiles, passes the happy-path test, works on one click-through, and then fails under concurrency or real data. An async Express handler with no error path. A `readFileSync` on the request path. An N+1 across a loop. A `Promise.all` that opens a socket per row of caller-supplied input. Injection sinks, because the unsafe form is shorter than the safe one.

react.doctor solved this for React: one command that catches the anti-patterns, plus a skill that pushes the rules *upstream into the agent* so the code is written correctly the first time. **node.doctor does the same for Node.js server code.**

**Study the references before writing code.** Clone `millionco/react-doctor` and read, specifically:
- how rules are authored and registered (the rule contract, the codegen'd registry),
- how the CLI, JSON output, and scoring are structured,
- how the agent skill installs into many clients,
- how the CI baseline-delta reports only PR-introduced findings,
- how the dead-code scanner, language server, and fuzz harness are organized.

You are borrowing **architecture and product shape**, not code, and you are deliberately diverging on several points (§3).

**Naming convention (follow exactly):** the product/brand is **`node.doctor`**; the npm package and CLI binary are **`node-doctor`** (npm names cannot contain a dot). This mirrors react.doctor / `react-doctor`.

---

## 2. Prior art: what to borrow vs. what to change

| Aspect | react.doctor does | node.doctor should |
| --- | --- | --- |
| Parser | oxc (Rust) | **Same** — use `oxc-parser`. Non-negotiable; it's the fast, correct foundation. |
| Rule host | rules are **oxlint JS plugins** | **Standalone engine** on the oxc AST (see §3.1). Own the project-level passes; keep rules adaptable to oxlint later. |
| Registry | **codegen'd** from rule bucket dirs | **Same pattern** — generate the registry so adding a rule is one file. Hand-write it only until the generator lands. |
| Scoring | **server call** to a closed `/api/score`, null offline | **Local, transparent, published formula** (§12). Reproducible and offline. This is a deliberate product difference. |
| Agent skill | thin skill, installs to 50+ clients, fetches prompt remotely at runtime | **Thin skill, installs to many clients, but bundled locally** (no runtime remote fetch — offline-first). |
| CI | baseline-delta reports only PR-introduced findings | **Same** — this is the single most important adoption feature. |
| Dead-code scanner | `deslop` (unused files/exports/deps) | **Build an equivalent** (`node-deslop`), phased. |
| Editor | language server + VS Code + Zed | **LSP + VS Code**, phased (VS Code first). |
| Fuzzing | crash/slow/invariant oracles | **Build a fuzz harness**, phased. |
| Tuning philosophy | broad recall across ~400 rules | **Precision over recall** (§5). We win on trust, not rule count. |

---

## 3. Architectural decisions (respect these; they are the spine)

### 3.1 Standalone engine, not oxlint plugins — but rule-portable

Build our own analysis engine on top of `oxc-parser`'s ESTree AST. **Reason:** our differentiators (cross-file reachability, local scoring, baseline-delta identity) require a **project-level** analysis phase, which a file-oriented linter runtime does not naturally give us. Keep the rule contract clean and pure (§8) so a rule *could* later be wrapped as an oxlint or ESLint rule with an adapter. Ship a thin **ESLint adapter** for distribution reach (Phase 6), re-exposing the same rule objects.

### 3.2 Two-phase engine from day one (this prevents a rewrite)

Even though v1 ships mostly intra-file rules, architect the engine as two phases:

- **Phase A — per-file pass.** Parse each file; collect **local facts**: exports, imports, request-handler registrations, and a **per-function effect summary** (does it do sync IO? spawn a shell? run a query? contain an unbounded fan-out?). Run intra-file rules here.
- **Phase B — project pass.** Build the **module import graph** from Phase A facts, resolve **reachability from every request handler**, and run **cross-file rules** against the resolved graph (e.g. "a sync IO effect is reachable from a handler through N call hops"). Cache Phase A facts keyed by file content hash so unchanged files are never recomputed.

The single biggest limitation of a naïve linter here is that everything interesting is cross-file. Do **not** hard-code a per-file-only assumption anywhere. Rules declare whether they are `scope: "file"` or `scope: "project"`.

### 3.3 Local scope/binding resolution

Build a lightweight scope + binding resolver on the AST (extend the existing taint/parent-link approach). Do **not** block on oxc exposing a semantic model; if/when richer symbol tables are available from the oxc toolchain, adopt them behind the same internal interface. Rules must never depend on a semantic API that may not exist — they depend on **our** helper layer.

### 3.4 Precision is a hard product constraint

A false positive gets the whole tool uninstalled; a false negative costs one missed bug. Every heuristic resolves toward **silence** when unsure. Taint analysis **sharpens messages** (“caller-controlled” vs “interpolated”) but does **not gate** injection findings. This is not a preference — it is the product's survival condition.

### 3.5 Offline-first, telemetry-free

No network calls during a scan. No telemetry. The score, the skill, and every rule run locally. This is a trust and adoption decision and a differentiator vs. server-scored tools.

---

## 4. Tech stack (pinned — do not substitute without recording a reason)

- **Runtime:** Node.js **≥ 20.19**. Pure **JavaScript, ESM** (`"type": "module"`). **No TypeScript compiler / no build step for the core**; document types with **JSDoc**. (TypeScript-authored is acceptable *only* if you also configure a fast build and keep `npx` cold-start low — default to plain ESM JS unless you justify otherwise.)
- **Parser:** `oxc-parser` (Rust-backed, ESTree output). The one heavy dependency; everything else stays light.
- **File discovery:** `fast-glob`.
- **Terminal color:** `picocolors` (zero-dep; do **not** add chalk).
- **Hashing / IO / paths:** Node stdlib `node:crypto`, `node:fs/promises`, `node:path` only.
- **Tests:** Node's native **`node:test`** + **`node:assert`**. No Jest/Vitest/Mocha.
- **CLI:** hand-rolled argument parsing. **No** commander/yargs.
- **CI:** GitHub Actions YAML. Agent skill: a single Markdown `SKILL.md`.

**Dependency policy:** every new production dependency must be justified in the PR description. A security/analysis tool with a large dependency tree is a contradiction. Prefer stdlib and a few well-audited packages.

**Environment gotcha for the agent:** the shell may be `dash`, not `bash` — brace expansion (`mkdir -p a/{b,c}`) silently fails and files land in `/`. Always wrap such commands in `bash -c '...'`, and verify paths after creating directories. Watch for apostrophes inside `bash -c '...'` heredocs terminating the quote; prefer writing file content via the editor tool, not shell heredocs, for prose/markdown.

---

## 5. Non-negotiable quality bars

1. **Every rule ships with a valid AND an invalid test.** The *valid* (does-not-fire-on-correct-code) test is mandatory and is written first.
2. **A `good-app` fixture is the canary.** A realistic, correct Express+Prisma (and later Fastify/Nest) app that must produce **zero findings** except genuine true positives. Any new rule must be run against it and must not light it up.
3. **Determinism.** Identical input → byte-identical output. Diagnostics sorted by severity, file, line, column, rule id. This is a prerequisite for baseline-delta and snapshot tests.
4. **Rule isolation.** A rule that throws is skipped, never crashes the scan. Each rule and each visitor invocation is wrapped.
5. **Stable diagnostic identity.** Each finding has a deterministic `id` (hash of location + rule + message) so CI delta can tell "new" from "pre-existing."
6. **No `complete: true` when files failed to parse.** Never let an empty diagnostics array read as "clean" when part of the code was unreadable.
7. **Recommendations name the mechanism.** "Use `execFile` with an argument array" — not "sanitize input."
8. **Precision over recall, everywhere** (§3.4).

A phase is not "done" until its tests pass **and** you have run the CLI against both fixtures and pasted the output into the phase's completion note.

---

## 6. System architecture

```
                 ┌──────────────────────────────────────────────┐
   CLI / API ───▶│  Orchestrator (scanProject)                  │
                 │   1. discoverProject → capability tokens      │
                 │   2. select rules by capability + config      │
                 │   3. Phase A: per-file parse + local facts    │
                 │   4. Phase B: import graph + reachability      │
                 │   5. run rules (file-scope + project-scope)   │
                 │   6. sort, assign ids, score                  │
                 └───────────────┬──────────────────────────────┘
                                 ▼
                 Terminal renderer │ JSON report │ SARIF │ GH annotations
```

**Core primitives (each is a module):**

- **Parser wrapper** — `oxc-parser`; returns AST + parse errors; records coverage gaps.
- **Walker** — ESTree traversal with **parent-link attachment** and enter/`:exit` visitor dispatch; a `findDescendant(node, pred, skip)` for containment queries.
- **AST helpers** — dotted callee resolution, enclosing-function lookup, "is result discarded," template-interpolation detection, `looksCallerControlled`, offset→line/col locator.
- **Scope/binding resolver** — bindings, aliases, module-scope vs function-scope determination.
- **Capability detection** — `package.json` → tokens (`express`, `express:5`, `prisma`, `typescript`, `esm`/`cjs`, `fastify`, `nest`, `adonis`, `hono`, `koa`, `drizzle`, `knex`, `mongoose`, `jsonwebtoken`, `node:20`…). Version-aware (major-version gates).
- **Request-path detection** — the load-bearing primitive. Detect handler registrations (method-call form, object-route form, decorator form) + a `(req,res)` signature fallback for split-file controllers. Answers "is this node reachable-in-request-context?" (intra-file now; via the call graph in Phase B).
- **Taint** — small intra-file propagation from request roots; sharpens messages only.
- **Call graph (Phase B)** — module resolution, import graph, reachability from handlers, per-function effect summaries, sidecar cache keyed on content hash + probe set.
- **Scoring** — local, transparent (§12).
- **Diagnostic identity + delta** — stable ids; `computeDelta(baseline, current) → { introduced, resolved }`.
- **Reporters** — terminal, JSON, SARIF, GitHub annotations.

---

## 7. Repository layout

```
node-doctor/
├── bin/
│   └── node-doctor.js            # CLI entry: arg parse, subcommands, exit codes
├── src/
│   ├── index.js                  # public API surface
│   ├── core/
│   │   ├── types.js              # Rule contract, categories, defineRule
│   │   ├── parse.js              # oxc wrapper + parse-error handling
│   │   ├── walk.js               # walker, parent links, findDescendant
│   │   ├── ast.js                # shared AST helpers
│   │   ├── scope.js              # binding/scope resolution
│   │   ├── request-path.js       # handler detection
│   │   ├── taint.js              # intra-file taint
│   │   ├── project.js            # package.json → capabilities; rule gating
│   │   ├── graph.js              # import graph + reachability (Phase B)
│   │   ├── effects.js            # per-function effect summaries (Phase B)
│   │   ├── cache.js              # content-hash sidecar cache
│   │   ├── scan.js               # orchestrator, diagnostic identity, delta
│   │   ├── score.js              # local scoring
│   │   ├── config.js             # config file + inline suppression
│   │   └── registry.js           # generated rule list (codegen target)
│   ├── rules/
│   │   ├── async/                # promise/async correctness
│   │   ├── event-loop/           # blocking, CPU-on-request-path
│   │   ├── db/                   # N+1, transactions, pagination
│   │   ├── security/             # injection, auth, secrets, crypto
│   │   ├── http/                 # express/fastify/nest/koa/hono handler rules
│   │   ├── reliability/          # lifecycle, leaks, shutdown
│   │   └── maintainability/      # slop, hygiene (opt-in leaning)
│   ├── report/
│   │   ├── terminal.js
│   │   ├── json.js
│   │   ├── sarif.js
│   │   └── annotations.js
│   ├── skill/
│   │   └── install.js            # writes SKILL.md into agent clients
│   └── deslop/                   # dead-code scanner (Phase 7)
├── skill/
│   └── SKILL.md
├── scripts/
│   └── gen-registry.js           # codegen for src/core/registry.js
├── .github/
│   ├── action.yml                # composite/JS action
│   └── workflows/node-doctor.yml # example workflow users copy into their repo
├── tests/
│   ├── rules/                    # one test file per rule bucket
│   ├── engine/                   # walker, graph, scoring, delta, config
│   └── fixtures/
│       ├── agent-app/            # deliberately bad app (all buckets)
│       ├── good-app/             # correct canary — must stay clean
│       ├── fastify-app/
│       └── monorepo/             # workspace resolution fixture
├── bench/
│   └── corpus.js                 # FP-rate measurement vs. real repos
├── package.json
├── README.md
├── CHANGELOG.md
├── CONTRIBUTING.md
├── SECURITY.md
└── LICENSE                       # MIT
```

---

## 8. The rule contract

```js
/**
 * @typedef {"Security"|"Bugs"|"Performance"|"Reliability"|"Maintainability"} Category
 * @typedef {"error"|"warn"} Severity
 * @typedef {"file"|"project"} Scope
 *
 * @typedef {Object} Rule
 * @property {string}        id            // → node-doctor/<id>
 * @property {string}        title         // headline, no trailing period
 * @property {Severity}      severity
 * @property {Category}      category
 * @property {Scope}         [scope]       // default "file"; "project" runs in Phase B
 * @property {string[]}      [requires]    // ALL capability tokens must be present
 * @property {string[]}      [disabledWhen]// ANY present disables the rule
 * @property {string[]}      [tags]        // families for --ignore-tag
 * @property {boolean}       [defaultEnabled] // false → opt-in only
 * @property {string}        recommendation   // the fix, naming the mechanism
 * @property {(ctx: RuleContext) => Record<string, Function>} create // visitors by node type (+ ":exit")
 */
export const defineRule = (rule) => rule; // identity; the value is the contract
```

`RuleContext` provides: `report(node, message)`, `filePath`, `sourceText`, `program`, `taintedBindings`, `hasCapability(token)`, and — for `scope: "project"` rules — `graph` (import graph + reachability) and `effectsOf(fn)`.

**Registry is codegen'd** (`scripts/gen-registry.js`): the bucket directory supplies the default `category`; adding a rule is creating one file and re-running the generator. Hand-write `registry.js` only until the generator exists, keeping the exact shape the generator will emit.

---

## 9. Target ruleset

Ship **precision-first**. Target **~90–120 rules** at v1; drop any rule that cannot be made low-FP against the `good-app` canary. Existing v0 rules are marked ✅. Implement bucket by bucket (§20). Each bucket lists concrete, high-value, low-FP rules; expand within the bucket following the same bar.

### Async & Promises (target ~16)
`no-async-array-callback` ✅ · `no-unbounded-promise-all` ✅ · `require-fetch-timeout` ✅ · `no-floating-promise` (project/type-aware where possible; heuristic otherwise) · `no-async-executor` (`new Promise(async …)`) · `no-await-in-loop-over-independent-work` (→ parallelize) · `require-abort-signal-propagation` · `no-swallowed-error-returns-undefined` (catch returns undefined) · `no-missing-catch-on-async-iife` · `no-race-without-timeout` · `prefer-promise-all-over-sequential-independent-awaits` · `no-unhandled-rejection-in-emitter-callback`.

### Event loop & performance (target ~14)
`no-sync-io-in-request-path` ✅ · `no-process-exit-in-request-path` ✅ · `no-large-json-parse-in-request-path` · `no-cpu-bound-loop-in-request-path` (O(n²)/big-data over request input) · `require-worker-thread-for-heavy-crypto` · `no-redos-prone-regex-on-input` · `prefer-stream-over-read-whole-file` · `require-pagination-limit` (`findMany` without `take`) · `no-blocking-sync-hash-in-request-path`.

### Database (target ~14)
`no-query-in-loop` ✅ (N+1) · `no-missing-transaction-on-multi-write` · `prefer-eager-load-over-n-plus-one` · `no-db-connection-per-request` (client/pool constructed in handler) · `no-findMany-then-filter-in-js` (belongs in WHERE) · `no-missing-await-on-query` (floating query) · `require-parameterized-in-clause` · `prefer-batch-insert-over-loop-insert` · `no-external-call-inside-open-transaction` · `no-select-star-on-wide-table` (heuristic).

### Security — injection (target ~12)
`no-exec-with-interpolation` ✅ · `no-sql-template-interpolation` ✅ · `no-path-traversal` ✅ · `no-eval-with-input` · `no-function-constructor-with-input` · `no-vm-run-untrusted` · `no-unsafe-regexp-from-input` · `no-nosql-object-injection` (`$where`, operator injection) · `no-ssrf-unvalidated-url` · `no-open-redirect` · `no-server-side-template-injection` · `no-xxe-enabled-parser`.

### Security — auth / secrets / crypto (target ~14)
`secret-in-env-fallback` ✅ · `no-timing-unsafe-secret-compare` ✅ · `no-jwt-decode-as-verify` ✅ · `no-weak-hash-for-password` ✅ · `cors-credentials-reflect` ✅ · `no-hardcoded-secret-literal` (known key prefixes / high entropy) · `no-jwt-none-algorithm` · `require-jwt-algorithms-allowlist` (alg-confusion) · `require-secure-cookie-flags` · `no-math-random-for-token` · `no-weak-cipher` (des/rc4/ecb) · `no-disabled-tls-verification` (`rejectUnauthorized:false`) · `no-secret-in-url-or-log`.

### HTTP / framework (target ~15)
`express-async-handler-unprotected` ✅ (off on `express:5`) · `express-missing-return-after-response` ✅ · `require-error-handling-middleware` (Express: no 4-arg error handler) · `no-missing-body-size-limit` · `no-send-after-next` · `no-response-in-middleware-without-return` · `fastify-missing-validation-schema` · `nest-missing-validation-pipe` · `no-wildcard-route-before-specific` · `no-trust-proxy-misconfig` · `koa-unhandled-route-error` · `hono-missing-error-handler`.

### Reliability & lifecycle (target ~14)
`no-unbounded-module-cache` ✅ · `require-sigterm-handler` (graceful shutdown) · `no-uncleared-module-interval` · `no-listener-added-per-request` (emitter leak) · `require-server-close-on-shutdown` · `no-throw-in-finally` · `no-missing-stream-error-handler` · `no-infinite-retry-without-backoff` · `no-global-mutable-state-mutation-in-handler` · `no-unhandled-worker-error`.

### Maintainability / AI-slop (target ~8, several `defaultEnabled: false`)
`prefer-node-protocol-imports` (`fs` → `node:fs`) · `no-redundant-try-catch-rethrow` · `no-console-log-in-committed-code` · `no-duplicate-route-definition` · `no-unused-express-middleware` · `no-dead-async` (async fn, no await, no returned promise).

For each rule, document (in JSDoc and in the README rule catalog): **why it matters** (the production consequence), a **❌ flagged** example, a **✅ not-flagged** example, and explicit **fires-when / stays-silent-when** conditions.

---

## 10. CLI specification

```
node-doctor [directory] [options]
node-doctor rules
node-doctor delta   --baseline <file> --current <file> [--blocking <level>]
node-doctor install [--client <name>]        # write the agent skill
node-doctor deslop  [directory]              # dead-code scan (Phase 7)
node-doctor explain <file>:<line>            # why a rule fired / didn't (Phase 8)
```

**Options:** `--json`, `--json-out <path>`, `--sarif-out <path>`, `--annotations` (GitHub), `--verbose|-v`, `--blocking <error|warning|none>` (default `error`), `--ignore-tag <tag>` (repeatable), `--only <glob>` / `--diff [base]` / `--staged` (scan subset), `--config <path>`, `--offline` (default true; flag reserved), `--help|-h`, `--version`.

**Exit codes:** `0` no blocking findings (or `--blocking none`); `1` blocking findings present; `2` tool error. Baseline scans in CI use `--blocking none`; only the `delta` step enforces policy on introduced findings.

---

## 11. Output and reporting

- **Terminal:** score bar + label, error/warn counts + weighted density, findings grouped by category (largest first) then rule (most sites first), each with message, top-N locations, recommendation, rule id. `--verbose` removes caps. Colors via `picocolors`; degrade gracefully when not a TTY.
- **JSON (`schemaVersion` pinned):** `{ schemaVersion, project{ name, rootDirectory, capabilities[], analyzedFileCount, totalLines, complete, parseFailures[] }, rulesRun, rulesAvailable, diagnostics[]{ id, filePath, normalizedFilePath, line, column, plugin, rule, title, category, severity, message, recommendation, tags[] }, score{ score, label, weighted, perThousandLines, byCategory{} } }`. `normalizedFilePath` is repo-relative, forward-slash, cross-OS.
- **SARIF 2.1.0:** for GitHub code-scanning upload.
- **GitHub annotations:** `--annotations` emits `::error file=…,line=…::message` lines.

---

## 12. Scoring model (local, transparent, published)

Start at **100**; subtract a penalty from the **density** of weighted findings.

```
finding_weight = severity_weight × category_weight
  severity: error=3, warn=1
  category: Security=2.0, Reliability=1.5, Bugs=1.5, Performance=1.0, Maintainability=0.5
weighted_total = Σ finding_weight
per_kloc       = (weighted_total / total_lines) × 1000
penalty        = min(100, (per_kloc / DENSITY_AT_ZERO) × 100)   // DENSITY_AT_ZERO = 100
score          = max(0, round(100 − penalty))
label          = score ≥ 75 ? "healthy" : score ≥ 50 ? "needs work" : "critical"
```

Density (not raw count) so a large, well-kept codebase isn't punished for size. Keep the scoring function **pure and unit-tested with worked examples**; expose it via the API. Make weights a single documented constant block so they can be tuned in one place.

---

## 13. CI/CD and the baseline delta

The **baseline delta** is the top adoption feature: on a legacy codebase, report **only findings the PR introduced**, so the first PR after adoption isn't buried in pre-existing issues and the check doesn't get disabled.

Ship: a GitHub **Action** (`.github/action.yml`) and an **example workflow** that (1) scans the base branch with `--blocking none --json-out baseline.json`, (2) scans head with `--json-out current.json`, (3) runs `node-doctor delta --baseline … --current … --blocking error`, and optionally posts a **sticky PR comment** listing introduced/resolved findings. Provide GitLab and pre-commit recipes in the README.

---

## 14. Agent skill (the thesis)

`node-doctor install` writes a **thin** `SKILL.md`/rules file into supported agent clients (Claude Code, Cursor, Windsurf, Codex, and others — enumerate a client→path map, extensible). The skill does **not** encode all rules as prose (that drifts); it tells the agent to **run the scanner and trust its output**, teaches the reasoning the scanner can't yet automate (the cross-file cases), gives the "four questions" for any handler (post-`await` rejection path; event-loop blocking; unbounded fan-out; where caller data lands), and forbids suppressing a rule to make a scan pass. **Bundle the skill locally** — no runtime remote fetch (offline-first divergence from react.doctor).

---

## 15. Editor / LSP (Phase 8)

An LSP server exposing diagnostics via the same `lintSource` path, plus a VS Code extension surfacing them inline with the recommendation as the hover. Reuse the engine; do not fork rule logic. Zed can follow.

---

## 16. Dead-code scanner (Phase 7)

`node-deslop`: unused files, unused exports, and unused dependencies across the project, using the Phase B import graph. Bundle into the default scan with a `--no-dead-code` opt-out, mirroring react.doctor's deslop integration.

---

## 17. Configuration and suppression

- **Config file:** `node-doctor.config.js` or a `nodeDoctor` key in `package.json`: `{ rules: { <id>: "off"|"warn"|"error" }, ignoreTags: [], ignore: [globs], blocking }`. Built-in ignores always applied (`node_modules`, `dist`, `build`, `.next`, `coverage`, `*.d.ts`, `*.min.js`).
- **Inline suppression:** `// node-doctor-disable-next-line <rule> -- <reason>` and block `disable`/`enable` comments. **A reason is mandatory**; a suppression without one is itself reported so the escape hatch can't hide problems silently.

---

## 18. Testing strategy

- **Unit (per rule):** valid + invalid pair minimum; add regression cases for every false positive ever found (e.g. the receiver-substring bug where `em` matched inside "it-em-s" and flagged `items.find()` — segment-aware matching + a pinned test).
- **Engine tests:** walker, scope resolver, capability gating, import graph, reachability, scoring (worked examples), delta (introduced/resolved), config + suppression, resilience (syntax error = coverage gap not crash; deep nesting doesn't blow the stack; empty file clean).
- **Fixture canary:** `good-app` must stay at zero findings modulo true positives; CI fails if it regresses.
- **Fuzzing (Phase 9):** feed generated/mutated sources; oracles for crashes, pathological slowness, and invariant violations (e.g. a rule reporting outside the file).
- **Corpus FP measurement (Phase 9):** run against the top ~200 real Node repos; measure and publish the **actual** false-positive rate. "Zero FPs on our fixtures" is weak evidence; this is the real bar.

---

## 19. Performance and scaling

- **Worker pool** sized `min(cores, totalmem / 1GiB)` (use total, not free, memory) for parse + Phase A across files.
- **Content-hash cache** so unchanged files skip re-analysis between runs (huge for local iteration and warm-cache CI).
- **Batch recovery:** binary-split a failing batch so one pathological file can't stall a run.
- **Layered timeouts** per file and per rule.
Target: comfortable on 10k+ files; sub-second warm-cache re-scans.

---

## 20. Build phases (execute in order; satisfy acceptance criteria before advancing)

**Phase 0 — Scaffold & engine skeleton.**
Repo layout, `package.json`, parser wrapper, walker with parent links, AST helpers, scope resolver, capability detection, `defineRule`, hand-written registry (generator shape), orchestrator (Phase A only), terminal + JSON reporters, CLI (`scan`, `rules`), local scoring.
*Accept:* `node-doctor .` runs on an empty project and on a trivial fixture; JSON schema emitted; `node --test` green.

**Phase 1 — Core rule buckets (intra-file) + fixtures.**
Implement Async, Event-loop, Security-injection, Security-secrets/crypto, Express HTTP, DB (N+1), Reliability (module cache). Build `agent-app` (bad) and `good-app` (canary).
*Accept:* `agent-app` scores critical with all planted bugs caught; **`good-app` has zero findings except genuine true positives**; every rule has valid+invalid tests; full suite green; paste both CLI outputs into the completion note.

**Phase 2 — Determinism, identity, delta, config, suppression.**
Stable sort, diagnostic ids, `computeDelta`, config file, inline suppression (with mandatory reasons).
*Accept:* delta unit tests (introduced/resolved) pass; a simulated PR that adds one bad handler reports exactly the new findings and ignores pre-existing ones; suppression requires a reason (tested).

**Phase 3 — Registry codegen + capability/version gating hardening.**
`scripts/gen-registry.js`; verify Express 4↔5 gating, ORM gating, framework gating.
*Accept:* adding a rule file + regen wires it in with no manual edits; gating tests pass (e.g. async-handler rule silent on `express:5` and on non-Express).

**Phase 4 — CI Action artifact + SARIF/annotations reporters.**
Build the GitHub Action definition and the example workflow file as shippable artifacts (users copy these into their own repos), plus the SARIF and GitHub-annotation reporters.
*Accept:* the Action definition and example workflow file exist and are valid; running the two-scan + delta flow **locally** produces correct introduced/resolved output; SARIF validates against the 2.1.0 schema; GitHub annotation lines format correctly.

**Phase 5 — Agent skill + `install`.**
Thin `SKILL.md`; `node-doctor install` writes to a client→path map; bundled locally.
*Accept:* install writes the skill to at least Claude Code + Cursor paths; `--client` targets one; skill content matches §14.

**Phase 6 — ESLint adapter + programmatic API polish.**
Thin adapter re-exposing rule objects; finalize public exports (`scanProject`, `lintSource`, `computeDelta`, `calculateScore`, `renderReport`, `RULES`, `RULES_BY_ID`, `discoverProject`, `shouldEnableRule`).
*Accept:* adapter runs a subset under ESLint; API examples in README execute.

**Phase 7 — Project pass (call graph) + first cross-file rules + deslop.**
Import graph, reachability from handlers, per-function effect summaries, sidecar cache. Promote `no-sync-io-in-request-path` (and peers) to detect effects reachable **through helpers**. Ship `node-deslop`.
*Accept:* a fixture where a handler calls a helper (another file) that does `readFileSync` is flagged; a non-handler caller of the same helper is not; deslop finds planted unused file/export/dep; cache demonstrably skips unchanged files.

**Phase 8 — LSP + VS Code extension + `explain`.**
*Accept:* diagnostics appear inline in VS Code; `explain <file>:<line>` reports why a rule fired or a suppression didn't apply.

**Phase 9 — Performance, fuzzing, corpus FP measurement, docs.**
Worker pool, caching, batch recovery; fuzz harness with oracles; corpus run publishing the measured FP rate; complete README rule catalog, CHANGELOG, CONTRIBUTING, SECURITY, LICENSE.
*Accept:* scan of a 10k-file synthetic project completes within target and warm re-scan is sub-second; fuzz harness runs clean; corpus FP rate measured and recorded; docs complete.

**Phase 10 — Type-aware rules (opt-in `--typed`).**
Integrate a TypeScript type source (evaluate `oxlint-tsgolint` / `typescript-go`); enable `no-floating-promise` and DB-client identification via types rather than heuristics, behind `--typed`.
*Accept:* `--typed` catches a `Promise<T>`-typed floating promise that the heuristic misses; untyped runs unchanged.

---

## 21. Definition of done (overall)

- All phases' acceptance criteria met; `node --test` fully green.
- `good-app` canary at zero findings modulo true positives, enforced in CI.
- ~90–120 rules, each documented (why / flagged / not-flagged / conditions) and tested (valid + invalid).
- CLI, JSON, SARIF, annotations, delta, config, suppression, `install`, deslop, LSP/VS Code all functional.
- Cross-file detection working for at least the request-path effect rules.
- Measured corpus false-positive rate published in the README.
- README, CHANGELOG, CONTRIBUTING, SECURITY, LICENSE complete; the package installs and runs from a clean checkout (`npm install && node bin/node-doctor.js .`).
- No network calls during a scan; no telemetry.

---

## 22. Guardrails — mistakes to avoid (read before each phase)

1. **Never ship a rule that fires on `good-app`.** Run the canary after every rule. A false positive is a release blocker, not a nuisance.
2. **Write the valid test first.** If you can't articulate a clean-code case that must stay silent, the rule isn't ready.
3. **Don't gate injection findings on taint.** Taint sharpens the message; it must not create false negatives by silencing an interpolated sink it failed to trace.
4. **Don't hard-code per-file assumptions.** Every rule declares `scope`; the engine supports a project pass from Phase 0's design even before Phase 7 fills it in.
5. **Don't add heavy dependencies.** Justify every one. This is a security tool; its own supply chain matters.
6. **Keep output deterministic.** No `Date.now()`, no unsorted maps, no filesystem-order iteration in output.
7. **Respect capability gating.** An Express rule must not fire on a Fastify app; a JWT rule must not fire without `jsonwebtoken`; the Express-4 async-handler rule must be silent on `express:5`.
8. **Handle parse failures honestly.** Coverage gap, `complete:false`, listed in `parseFailures` — never silent "clean."
9. **Isolate rule crashes.** One rule throwing must never end the scan.
10. **Shell hygiene (agent-specific).** Assume `dash`; wrap brace-expansion in `bash -c`; verify created paths; write markdown/prose via the editor, not shell heredocs (apostrophes break quoting).
11. **Don't claim "production ready" prematurely.** A phase is done only when its tests pass and you've run the CLI against the fixtures and recorded the output.

---

*End of specification. Begin at Phase 0. Do not skip acceptance criteria.*