# Changelog

All notable changes to node.doctor are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
semantic versioning. The JSON report's `schemaVersion` is bumped on any breaking
change to that shape.

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

- `node-doctor [dir]`, `diagnostics`, `delta`, `install`; `--json`, `--json-out`,
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
