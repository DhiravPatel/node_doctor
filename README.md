<div align="center">

# node.doctor

### Your agent writes bad Node. This catches it.

Deterministic, offline-first static analysis for Node.js backends — built for the
class of defect that compiles, passes the tests, runs fine on your machine, and
falls over the moment two requests arrive at once.

[![npm version](https://img.shields.io/npm/v/node-doctor.svg)](https://www.npmjs.com/package/node-doctor)
[![CI](https://img.shields.io/github/actions/workflow/status/DhiravPatel/node_doctor/ci.yml?branch=main)](https://github.com/DhiravPatel/node_doctor/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#license)
[![Node](https://img.shields.io/node/v/node-doctor.svg)](#requirements)

```bash
npx node-doctor@latest .
```

</div>

---

## What it is

node.doctor scans Node.js server code and reports the defects generic tooling
misses — the ones that are *correct in isolation and wrong under load*: an `async`
Express handler with no error path, a `readFileSync` on the request path, an N+1
across a loop, a `Promise.all` that opens a socket per row, injection and
secret-handling sinks.

It runs **118 diagnostics** — including a whole-tree scan for **committed secrets**
in `.env`, config, CI, and key files — produces a transparent **0–100 health
score** entirely on your machine (no network, no telemetry), and can push the
same knowledge **upstream into your coding agent** as an installable skill and an
MCP tool.

## Quick start

```bash
npx node-doctor@latest .              # scan the current directory
npx node-doctor@latest diagnostics    # list every diagnostic + gating
npx node-doctor@latest . --json       # machine-readable report
```

Typical output on a codebase that needs help:

```
  node.doctor v0.1.0  checkout-service
  148 files · 21,904 lines · 50/62 diagnostics active
  detected: typescript esm express prisma jsonwebtoken

  ██████░░░░░░░░░░░░░░░░░░░░░░░░  21/100  critical
  38 errors · 17 warnings · 71.4 weighted/kLOC

  Security (19)
  ✖ SQL built by string interpolation · 6 sites
     src/orders/repository.ts:88:24
     → Use parameter binding: db.query("… WHERE id = $1", [id])
     node-doctor/no-sql-template-interpolation
```

## Why it's different

- **Context-aware.** `readFileSync` at module scope is a config load; the same
  call inside a handler stalls *every* concurrent request. node.doctor tells them
  apart — most linters flag both (and get disabled) or neither (and miss the bug).
- **Version-aware.** It reads your manifest and retires diagnostics that no longer
  apply — the Express-4 async-handler footgun is silent on Express 5.
- **Transparent, local score.** A 0–100 number from a published formula,
  reproducible by hand, offline. No server call, no closed model.

## Features

- **118 diagnostics** across Security, Reliability, Bugs, Performance, and
  Maintainability — each with a valid + invalid test; FP-prone ones are opt-in.
- **Whole-tree secret scan** — committed credentials in `.env`, YAML/CI configs,
  and `*.pem`/`*.key` files, gated to git-tracked files so a local `.env` is safe.
- **Deploy-config analysis** — the same engine reads the files that ship your code:
  **Dockerfiles** (final stage running as root, mutable base tags, secrets baked
  into a layer), **Kubernetes manifests** (privileged containers, host namespaces,
  missing resource limits), **GitHub Actions** (script injection via
  `\${{ github.event.* }}`, `pull_request_target` checking out untrusted code,
  unpinned actions), and **Terraform/CloudFormation** (open security groups,
  over-broad IAM, public buckets). Each demands positive evidence of the file type
  first — a docker-compose file with `privileged: true` is not a Kubernetes finding.
- **Cross-file call graph + interprocedural taint** — flags a blocking sink, or an
  injection sink fed by request data, in a helper reached from a handler *through other
  files*, and names the whole path. In a monorepo the graph **crosses package
  boundaries**: a handler in `apps/api` reaching a blocking read in `packages/db`
  is a finding, attributed to the package that contains the code.
- **Runtime-aware** — detects Bun, Deno, and edge runtimes (Cloudflare Workers,
  Vercel Edge) and gates diagnostics accordingly; `node:fs` on the edge is an
  error there and silent everywhere else.
- **Modernization score** (`node-doctor modernize`) — a second number, separate
  from health, that goes *up* as you retire deprecated APIs and unsupported Node
  majors.
- **AI-feature security** — Node is where LLM apps are built, and their code has its
  own vulnerability class. On a project that imports an AI SDK, node.doctor flags
  **prompt injection** (request data welded into a `system` prompt — the same taint
  engine as SQL injection, silent on the isolated `{ role: "user", content }`
  shape), **LLM output reaching a dangerous sink** (`eval`/shell/SQL/HTML), an **MCP
  tool that runs shell/SQL/`fs` on model-controlled arguments**, **system-prompt
  leakage**, and **LLM calls in a loop**. The whole pack is silent on a project that
  never calls a model.
- **Type-aware diagnostics** (`--typed`) — an optional pass that reads the project's
  own TypeScript types. It catches a **discarded promise** even when the callee is
  typed `(): Promise<T>` rather than written `async` — the case a syntactic check
  cannot see, and the majority in a real TypeScript codebase. The compiler is an
  optional peer (`typescript@^5`); without it a normal scan is unchanged, and
  `--typed` fails loudly rather than silently finding nothing.
- **Framework, API and migration depth** — GraphQL/gRPC server-setup checks
  (introspection on in production, insecure gRPC credentials), Hapi/Restify
  diagnostics gated to those stacks, and SQL-migration checks (a destructive
  statement outside a down section, `ADD COLUMN NOT NULL` with no default, an
  unindexed foreign key).
- **CODEOWNERS routing** (`--owners`) and a **PR risk score** (`--risk`) — findings
  grouped by the team that owns them, plus one explainable number for triage.
- **Exploitability proof** (`node-doctor paths`) — for every injection sink fed by
  request data, the exact source→sink chain the taint engine resolved: request
  handler → each helper → the `eval`/shell/SQL sink, with `file:line` at every hop.
  Proof a finding is *reachable*, not a heuristic; exits 1 on a proven path.
- **Change-impact / blast radius** (`node-doctor impact`) — from the import graph,
  which routes and files a change reaches downstream. `impact --diff main` answers
  "what does my PR touch?" before review: *your two-line change to `db/pool.ts` is
  reachable from 14 routes.* Deterministic graph reachability, not a heuristic.
- **CI baseline delta** — reports only the findings your PR introduced.
- **`deslop`** dead-code scan — unused files, exports, and dependencies.
- **MCP server** — call node.doctor as a native tool from any MCP client.
- **Language server** (`node-doctor lsp`) + a VS Code extension — inline diagnostics,
  hover, and quick fixes on the unsaved buffer, from the same engine as the CLI.
- **Autofix** (`--fix`), self-contained **HTML report** (`--html-out`),
  **content-hash cache** (`--cache`), and **watch mode** (`--watch`).
- **Config file** + **inline suppression** with mandatory reasons.
- **ESLint adapter**, a stable **programmatic API**, and JSON / SARIF 2.1.0 /
  GitHub-annotation output.
- **Offline & deterministic** — no network calls, byte-identical runs.

## Diagnostics at a glance

| Category | Focus | Score weight | Count |
| --- | --- | --- | --- |
| **Security** | Injection, secrets, auth, deserialization, GraphQL/gRPC + AI-feature security, committed-secret + IaC/container/CI scan | 2.0 | 54 |
| **Reliability** | Crashes, hangs, lifecycle, runtime portability, deploy config, migrations, env drift | 1.5 | 28 |
| **Bugs** | Logic errors, wrong results, dead routes | 1.5 | 10 |
| **Performance** | Event-loop stalls, N+1, AI cost | 1.0 | 11 |
| **Maintainability** | Structure, hygiene, dead code, complexity, deprecated APIs | 0.5 | 10 |

Run `node-doctor diagnostics` for the full catalog with gating.

## Fix with an AI agent

Found the bugs — now hand them to the agent that can fix them. `node-doctor fix`
scans, then offers to pass every finding straight to a coding agent (Claude Code,
Codex, or Cursor) with a precise, root-cause-first instruction prompt:

```bash
npx node-doctor@latest fix .
```

```
  38 findings · 21/100 critical

  What would you like to do?
    1) Fix with Claude Code  (claude)
    c) Copy the prompt to your clipboard
    p) Print the prompt
    s) Skip
  > 1

  → Handing 38 finding(s) to Claude Code. It runs in auto-accept mode and will
    fix them end-to-end, then re-scan to confirm.
```

The prompt groups findings by root cause, names the exact fix for each, and tells
the agent to **fix the cause — never suppress** — then re-run node.doctor to
verify. It only lists agents actually installed on your machine; on a
non-interactive shell (or with `--print`) it prints the prompt instead of
launching anything.

```bash
node-doctor fix .            # scan, then pick an agent from the menu
node-doctor fix . --yes      # skip the menu, launch the first available agent
node-doctor fix . --agent claude   # choose the agent explicitly
node-doctor fix . --review   # agent asks before each edit (no auto-accept)
node-doctor fix . --print    # just print the prompt for your own agent
```

## Command-line

```
node-doctor [directory] [options]
node-doctor fix [directory]                     scan, then hand findings to an AI agent
node-doctor diagnostics [--json] [filters]      list diagnostics + effective severity/source
node-doctor diagnostics set|enable|disable <id> <sev>   edit the config in place
node-doctor diagnostics category <c> <sev> | ignore-tag <t>
node-doctor delta --baseline <f> --current <f>  report only introduced findings
node-doctor deslop [directory]                  dead-code scan
node-doctor explain <id> | <file>:<line>        why a diagnostic fired (with a code frame)
node-doctor install [--client <name>]           install the agent skill
node-doctor install --git-hook                  install an advisory pre-commit hook
node-doctor ci                                  scaffold a GitHub Actions workflow
node-doctor conventions [dir]                   write CLAUDE.md/AGENTS.md from your stack
node-doctor ratchet init|check                  lock current debt; fail only on new findings
node-doctor surface [--baseline <f>]            map routes + auth posture; diff for breaking changes
node-doctor impact <files…> | --diff [base]     blast radius: what routes/files a change reaches
node-doctor paths [directory]                   source→sink attack paths (exploitability proof)
node-doctor sbom [--framework spdx]             CycloneDX / SPDX bill of materials
node-doctor modernize [directory]               modernization score: deprecated APIs + Node major
node-doctor mcp                                 run as an MCP server
node-doctor lsp                                 run as a language server (editors)
node-doctor init                                scaffold a config
node-doctor version                             version + platform + Node runtime

Output   --json · --json-compact · --score · --json-out · --sarif-out · --html-out
         --md-out · --annotations · --color / --no-color
Scan     --fix · --fix-diff (emit autofixes as a patch) · --history (git-history secrets) · --dead-code · --cache · --watch · --audit · --max-duration <sec>
         --typed (type-aware diagnostics; needs typescript@^5 in the project)
         --no-parallel (analyze files serially; default is a concurrency pool)
Scope    --only <glob> · --diff [base] · --staged · --scope <lines|files>
         --changed-files-from <f> · --include-untracked
Monorepo --project <name|path> (repeatable) · --no-workspaces
Gate     --blocking <error|warning|none>
Display  --category <c> (repeatable) · --no-warnings · --verbose
         --owners (group findings by CODEOWNERS team) · --risk (PR risk score, with --diff)
Config   --config <path> · --ignore-tag <tag>
Fix      --yes,-y · --agent <claude|codex|cursor> · --print · --review · --verify
```

Exit codes: `0` no blocking findings · `1` blocking findings · `2` tool error.

**Config** lives in `node-doctor.config.json` (or `.jsonc`/`.js`, or a `nodeDoctor`
key in `package.json`), resolved by walking up to the repo root. A generated
[JSON Schema](./schema/node-doctor.config.schema.json) gives editors autocomplete.
Per-path `overrides` re-severity or disable diagnostics for a glob; `rootDir`
redirects the scan.

**Monorepos** are detected automatically: point node.doctor at a workspace root
(npm/yarn/bun `workspaces` or `pnpm-workspace.yaml`) and it scans every member
package, scores each separately, and reports a worst-of health score. Each
member's config layers over the root config. Use `--project <name|path>` to scan
one, or `--no-workspaces` to treat the root as a single project.

## Continuous integration

The **baseline delta** makes node.doctor adoptable on a legacy codebase from day
one: scan the base branch, scan the head branch, and report only the difference.
Matching is **evidence-based** (diagnostic + message + the triggering code), so
moving a finding to a new line or file doesn't read as newly introduced — only a
genuinely new defect fails the check.

Scaffold the whole thing in one command:

```bash
npx node-doctor@latest ci        # writes .github/workflows/node-doctor.yml
```

The bundled [GitHub Action](./.github/action.yml) runs the baseline delta and, on
a pull request, **upserts a summary comment**, posts **inline review comments** on
the changed lines, and publishes a **commit status** with the health score. Or
wire it by hand:

```yaml
- run: |
    git checkout origin/$BASE
    npx node-doctor@latest . --json-out base.json --blocking none
    git checkout $SHA
    npx node-doctor@latest . --json-out head.json --blocking none
    npx node-doctor@latest delta --baseline base.json --current head.json --blocking error
```

For local enforcement, `node-doctor install --git-hook` writes an advisory
pre-commit hook that scans staged files.

## Agent integration

Push node.doctor's knowledge into the agent that writes the code:

```bash
npx node-doctor@latest install         # skill → detected clients (Claude Code, Cursor, …)
npx node-doctor@latest install --skill improve-node   # a read-only audit-then-plan skill
npx node-doctor@latest install --agent-hooks          # post-edit hooks (feedback as it edits)
npx node-doctor@latest mcp             # …or run as an MCP server
```

```json
{ "mcpServers": { "node-doctor": { "command": "npx", "args": ["node-doctor", "mcp"] } } }
```

Six MCP tools: `scan`, `scan_diff`, `diagnostics`, `explain`, `deslop`, and **`check_snippet`** —
which lints a fragment *before* the agent writes it to disk, the cheapest feedback loop available.

Every finding carries a **confidence** (`high`/`medium`/`low`) so an agent can auto-fix what is
certain and escalate what is not, and every report carries a **provenance** record (tool version,
ruleset hash, config hash) so a CI result is reproducible and explainable.

## Programmatic API

```js
import { diagnose } from "node-doctor";

const report = await diagnose("./service");                  // one project
console.log(report.score.score, report.score.label, report.findings.length);

const batch = await diagnose({ directories: ["a", "b"] });   // many, resilient
console.log(batch.ok, batch.score.score);                    // worst-of aggregate
```

Exports include `diagnose`, `scanProject`, `scanWorkspaces`, `lintSource`,
`computeDelta`, `calculateScore`, `renderReport`/`renderReportMarkdown`,
`runDeslop`, `runTextScan`, `DIAGNOSTICS`, and `DIAGNOSTICS_BY_ID`. node.doctor
also ships as an **ESLint plugin** (`node-doctor/eslint`) and an **oxlint plugin**
(`node-doctor/oxlint`) — both re-run the same engine over file-scope diagnostics.

## Requirements

- **Node.js ≥ 20.19** to run the published package (compiled ESM, zero cold-start
  transpile cost).
- Analyzes `.js` `.mjs` `.cjs` `.ts` `.mts` `.cts` `.jsx` `.tsx`. TypeScript is
  parsed structurally — no `tsconfig` resolution or type checking required.

## Contributing

Diagnostics are one file each; every one ships with a valid + invalid test and
must never fire on the `good-app` canary. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)
