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

It runs **62 diagnostics**, produces a transparent **0–100 health score** entirely
on your machine — no network, no telemetry — and can push the same knowledge
**upstream into your coding agent** as an installable skill and an MCP tool.

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

- **62 diagnostics** across Security, Reliability, Bugs, Performance, and
  Maintainability — each with a valid + invalid test; FP-prone ones are opt-in.
- **Cross-file call graph** — flags a blocking sink in a helper reached from a
  handler *through other files*.
- **CI baseline delta** — reports only the findings your PR introduced.
- **`deslop`** dead-code scan — unused files, exports, and dependencies.
- **MCP server** — call node.doctor as a native tool from any MCP client.
- **Autofix** (`--fix`), self-contained **HTML report** (`--html-out`),
  **content-hash cache** (`--cache`), and **watch mode** (`--watch`).
- **Config file** + **inline suppression** with mandatory reasons.
- **ESLint adapter**, a stable **programmatic API**, and JSON / SARIF 2.1.0 /
  GitHub-annotation output.
- **Offline & deterministic** — no network calls, byte-identical runs.

## Diagnostics at a glance

| Category | Focus | Score weight | Count |
| --- | --- | --- | --- |
| **Security** | Injection, secrets, auth | 2.0 | 24 |
| **Reliability** | Crashes, hangs, lifecycle | 1.5 | 17 |
| **Bugs** | Logic errors, wrong results | 1.5 | 7 |
| **Performance** | Event-loop stalls, N+1 | 1.0 | 9 |
| **Maintainability** | Structure, hygiene, dead code | 0.5 | 5 |

Run `node-doctor diagnostics` for the full catalog with gating.

## Command-line

```
node-doctor [directory] [options]
node-doctor diagnostics                         list diagnostics and gating
node-doctor delta --baseline <f> --current <f>  report only introduced findings
node-doctor deslop [directory]                  dead-code scan
node-doctor explain <id> | <file>:<line>        why a diagnostic fired
node-doctor install [--client <name>]           install the agent skill
node-doctor mcp                                 run as an MCP server
node-doctor init                                scaffold a config

Options  --json · --json-out · --sarif-out · --html-out · --annotations
         --fix · --cache · --watch · --blocking <error|warning|none>
         --ignore-tag · --only · --diff · --staged · --config
```

Exit codes: `0` no blocking findings · `1` blocking findings · `2` tool error.

## Continuous integration

The **baseline delta** makes node.doctor adoptable on a legacy codebase from day
one: scan the base branch, scan the head branch, and report only the difference.

```yaml
- run: |
    git checkout origin/$BASE
    npx node-doctor@latest . --json-out base.json --blocking none
    git checkout $SHA
    npx node-doctor@latest . --json-out head.json --blocking none
    npx node-doctor@latest delta --baseline base.json --current head.json --blocking error
```

A ready-to-use GitHub Action ships at [`.github/action.yml`](./.github/action.yml).

## Agent integration

Push node.doctor's knowledge into the agent that writes the code:

```bash
npx node-doctor@latest install   # writes a skill into Claude Code, Cursor, Windsurf, …
npx node-doctor@latest mcp        # …or run as an MCP server
```

```json
{ "mcpServers": { "node-doctor": { "command": "npx", "args": ["node-doctor", "mcp"] } } }
```

## Programmatic API

```js
import { scanProject } from "node-doctor";

const report = await scanProject({ rootDirectory: "./service" });
console.log(report.score.score, report.score.label, report.findings.length);
```

Exports include `scanProject`, `lintSource`, `computeDelta`, `calculateScore`,
`renderReport`, `runDeslop`, `DIAGNOSTICS`, and `DIAGNOSTICS_BY_ID`.

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
