# Changelog

All notable changes to node.doctor are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
semantic versioning. The JSON report's `schemaVersion` is bumped on any breaking
change to that shape.

## [Unreleased]

CLI, terminal UX, configuration, and the diagnostic set are substantially
expanded — closing the remaining parity gaps with react-doctor's tooling surface
while staying offline-first and deterministic.

### Diagnostics (62 → 70)

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
