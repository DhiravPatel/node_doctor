<div align="center">

# node.doctor

### Your agent writes bad Node. This catches it.

Deterministic static analysis for Node.js backends — built for the class of defect that compiles, passes the tests, runs fine on your machine, and then falls over the moment two requests arrive at once.

[![npm version](https://img.shields.io/npm/v/node-doctor.svg)](https://www.npmjs.com/package/node-doctor)
[![npm downloads](https://img.shields.io/npm/dm/node-doctor.svg)](https://www.npmjs.com/package/node-doctor)
[![CI](https://img.shields.io/github/actions/workflow/status/your-org/node-doctor/ci.yml?branch=main)](https://github.com/your-org/node-doctor/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#license)
[![Node](https://img.shields.io/node/v/node-doctor.svg)](#requirements)

```bash
npx node-doctor@latest .
```

</div>

---

## Table of contents

- [What is node.doctor](#what-is-nodedoctor)
- [Quick start](#quick-start)
- [The problem it solves](#the-problem-it-solves)
- [Why not just ESLint](#why-not-just-eslint)
- [Installation](#installation)
- [Requirements](#requirements)
- [Current status](#current-status)
- [How it works](#how-it-works)
- [Command-line reference](#command-line-reference)
- [Output](#output)
- [The scoring model](#the-scoring-model)
- [The ruleset](#the-ruleset)
- [Capability detection and gating](#capability-detection-and-gating)
- [Configuration](#configuration)
- [Suppressing findings](#suppressing-findings)
- [Continuous integration](#continuous-integration)
- [Agent integration](#agent-integration)
- [Programmatic API](#programmatic-api)
- [Framework support](#framework-support)
- [Comparison with other tools](#comparison-with-other-tools)
- [Architecture](#architecture)
- [Writing a rule](#writing-a-rule)
- [Performance and scaling](#performance-and-scaling)
- [Roadmap](#roadmap)
- [FAQ](#faq)
- [Contributing](#contributing)
- [Security policy](#security-policy)
- [License](#license)

---

## What is node.doctor

node.doctor is a command-line auditor for Node.js server code. You point it at a
directory, it parses every source file, and it reports the defects that generic
tooling misses — the ones that are *correct in isolation and wrong under load*.

It exists because of a specific shift in how backend code gets written. Coding
agents — Claude, Cursor, Copilot, Codex — produce Node code at a volume no
review process was designed for, and they produce a very particular kind of bug.
The code they write compiles. It passes the happy-path test. It works when you
click through it once. And then it ships an async Express handler with no error
path, a `readFileSync` on the request path, an N+1 across a loop, or a
`Promise.all` that opens a socket per row of caller-supplied input. None of those
show up until there is concurrency and real data.

node.doctor compresses the review that would have caught them into one command,
and — this is the part that makes it more than a linter — it pushes the same
knowledge *upstream into the agent itself* via an installable skill, so the code
is written correctly the first time instead of caught afterward.

**Three things define it:**

1. **Context-aware analysis.** `readFileSync` at module scope is a config load
   and correct. The identical call inside a route handler stalls every
   concurrent request. node.doctor tells them apart. Most linters cannot, so
   they either flag both (and get disabled) or neither (and miss the bug).

2. **Version-aware analysis.** `express-async-handler-unprotected` is a genuine,
   client-hanging bug on Express 4 and a complete non-issue on Express 5, which
   awaits handler return values. node.doctor reads your manifest and retires the
   rule automatically when it no longer applies.

3. **A transparent, local score.** Every scan produces a 0–100 health number
   computed entirely on your machine from a published formula. No network call,
   no closed model, reproducible on a plane. The number that gates your CI is one
   you can audit and recompute by hand.

---

## Quick start

Run it against the current directory with no install:

```bash
npx node-doctor@latest .
```

Typical output on a codebase that needs help:

```
  node.doctor v0.1.0  checkout-service
  148 files · 21,904 lines · 50/95 diagnostics active
  detected: typescript esm express prisma jsonwebtoken

  ██████░░░░░░░░░░░░░░░░░░░░░░░░░░  21/100  critical

  38 errors  ·  17 warnings  ·  71.4 weighted/kLOC

  Security (19)

  ✖ SQL built by string interpolation · 6 sites
     SQL is built from caller-controlled input via interpolation — this is SQL injection.
     src/orders/repository.ts:88:24
     src/orders/repository.ts:141:19
     src/users/search.ts:52:31
     … 3 more
     → Use parameter binding: db.query("SELECT ... WHERE id = $1", [id]), Prisma's
       tagged $queryRaw template, or the query builder. Interpolation loses the
       data/grammar boundary before the driver sees it.
     node-doctor/no-sql-template-interpolation

  … more findings …
```

See the whole ruleset and when each rule applies:

```bash
npx node-doctor@latest rules
```

Machine-readable report for scripting or CI:

```bash
npx node-doctor@latest . --json
```

---

## The problem it solves

Agent-written backend code fails in four recurring ways. Each is a whole family
of rules in node.doctor.

### 1. Broken asynchrony

The single most common category. Agents reach for the shape that reads most
naturally, which is frequently the one that silently drops errors or work.

```js
// Looks fine. Runs. Is wrong.
users.forEach(async (user) => {
  await sendEmail(user);
});
return "all sent"; // returns BEFORE any email is sent; failures vanish
```

`Array.prototype.forEach` does not await. Every iteration becomes an unhandled
promise: ordering is lost, rejections disappear, and the surrounding function
resolves before the work finishes. The `.filter`/`.find` variants are worse —
an async predicate returns a promise, which is always truthy, so the filter
*matches everything*.

### 2. Blocking the event loop

Node runs your JavaScript on one thread. A synchronous call on the request path
does not slow down "this request" — it freezes **every** concurrent request, the
timers, and the health check your orchestrator uses to decide whether the pod is
alive.

```js
app.get("/report/:id", (req, res) => {
  const template = fs.readFileSync("./templates/report.html", "utf8"); // stalls the whole process
  res.send(render(template, req.params.id));
});
```

The exact same `readFileSync` at module scope is correct and idiomatic. Position
is everything, which is why node.doctor's most important internal primitive is
"am I on a request path?"

### 3. Unbounded resource use

Code that scales with caller-supplied input is a self-inflicted denial of
service waiting for the right request.

```js
// One socket per element. Fine on 10 rows. A DoS on 10,000.
await Promise.all(restaurants.map((r) => fetch(`https://partner.api/${r.id}`)));
```

```js
// One query per row: N round trips inside a single request.
for (const order of orders) {
  order.items = await db.orderItem.findMany({ where: { orderId: order.id } });
}
```

These are invisible with five rows in development and catastrophic with the row
counts production actually carries.

### 4. Injection and secret-handling sinks

The classics, still written constantly because the unsafe form is shorter than
the safe one.

```js
exec(`tar -czf backup.tgz ${req.body.dir}`);                       // command injection
db.$queryRawUnsafe(`SELECT * FROM u WHERE e = ${req.body.email}`); // SQL injection
const secret = process.env.JWT_SECRET || "dev-secret-123";         // committed signing key
const claims = jwt.decode(token);                                  // no signature check
```

Every one of these compiles and works. Every one is a production incident.

### Why these survive review

The pre-agent world was not immune to any of this — a careful reviewer catches
most of it. But careful review is tedious and it does not scale to the volume of
code an agent produces in one afternoon. node.doctor is not smarter than a good
reviewer; it is *tireless and consistent*, and it runs on every file, every time,
in a second.

---

## Why not just ESLint

You can assemble `eslint-plugin-security` + `eslint-plugin-n` +
`eslint-plugin-promise` + `eslint-plugin-no-unsanitized` and get overlapping
coverage. That is a legitimate setup. Here is what node.doctor does that a pile
of ESLint plugins does not:

| | ESLint + plugins | node.doctor |
| --- | --- | --- |
| Context gating (module vs request path) | ✗ Fires everywhere | ✓ Position-aware |
| Version gating (Express 4 vs 5) | ✗ Manual per-project config | ✓ Reads your manifest |
| Curated, opinionated ruleset | ✗ You assemble and maintain it | ✓ Ships as one thing |
| Health score | ✗ | ✓ Local, transparent |
| CI baseline delta (legacy-friendly) | ✗ | ✓ Built in |
| Agent skill (upstream prevention) | ✗ | ✓ One install command |
| Zero-config first run | Partial | ✓ |

node.doctor is **not** a replacement for a well-configured ESLint. Keep ESLint
for style, formatting, and the hundreds of general-purpose correctness rules it
does brilliantly. node.doctor is a complement focused on the specific,
high-severity, load-dependent defects that are hard to express as a generic lint
rule and easy to ship to production.

---

## Installation

**Run without installing (recommended for occasional scans and CI):**

```bash
npx node-doctor@latest .
```

**Install as a project dev dependency (recommended for teams):**

```bash
npm install --save-dev node-doctor
# or
pnpm add -D node-doctor
# or
yarn add -D node-doctor
```

Then add a script to `package.json`:

```json
{
  "scripts": {
    "audit:node": "node-doctor .",
    "audit:node:ci": "node-doctor . --blocking error"
  }
}
```

**Install globally (for ad-hoc use across many repos):**

```bash
npm install -g node-doctor
node-doctor ~/code/some-service
```

---

## Requirements

- **Node.js ≥ 20.19.0.** node.doctor uses modern language features and the
  native `node --test` runner for its own suite.
- No other runtime dependencies for the person scanning. The tool ships with a
  Rust-backed parser (`oxc-parser`) and two small utilities; there is nothing to
  configure.
- Works on JavaScript and TypeScript source: `.js`, `.mjs`, `.cjs`, `.ts`,
  `.mts`, `.cts`. TypeScript is parsed structurally — no `tsconfig` resolution or
  type checking is required for the current ruleset (see
  [Roadmap](#roadmap) for type-aware rules).

---

## Current status

node.doctor is at **v0**. It is real, tested, and useful — and it is early. Read
this before you depend on it.

**What ships today and works:**

- A sound analysis engine: parser, AST walker with parent links, shared AST
  helpers, request-path detection, intra-file taint, capability detection.
- A **three-phase engine** — per-file AST visitors on a bounded concurrency pool,
  a whole-project import graph with reachability from request handlers, and a
  whole-tree text scan over non-source files.
- A **whole-program call graph** with **interprocedural taint**: a blocking call —
  or an injection sink fed by request data — in a helper several modules from the
  handler that reaches it is detected and the whole path is named. In a monorepo
  the graph crosses package boundaries.
- **Diagnostics across Security, Reliability, Bugs, Performance, and
  Maintainability**, each with a valid/invalid test pair; FP-prone ones are opt-in.
  Run `node-doctor diagnostics` for the live catalog and count.
- A large regression suite, including a test for every real false positive found
  during development and against real-world corpora.
- Local, transparent scoring, plus a separate **modernization score**.
- A complete CLI: full scan, diagnostics catalog and in-place config editing,
  `delta` for CI baselines, ratchet, API-surface diff, SBOM, dead-code scan,
  autofix, agent handoff, JSON/SARIF/HTML/Markdown output.
- **Config file** with per-path overrides, and **inline suppression** with
  mandatory reasons.
- **Parallel file scanning** and a **content-hash cache**.
- Monorepo/workspace support, git & CI integration, an MCP server, a language
  server plus a VS Code extension, an installable agent skill, and a stable,
  documented programmatic API.

**What is deliberately not here yet** (and is on the [roadmap](#roadmap)):

- **Type-aware rules** (e.g. floating-promise detection that relies on
  `Promise<T>` types rather than the `async` keyword). This needs a TypeScript
  type source and would be opt-in behind a flag.
- **Runtime-informed analysis** — coverage, heap profiles, cold-start timings.
  These require executing the code, which is out of scope for a static,
  offline-first tool.
- **GraphQL and gRPC** API analysis.

The engine is the reusable asset; the ruleset grows from here.

---

## How it works

A scan is a pipeline. Understanding it explains both what node.doctor catches and
what it cannot.

```
  discover project ─▶ detect capabilities ─▶ select rules
        │
        ▼
  for each source file:
     parse (oxc) ─▶ attach parents ─▶ run taint pass ─▶ run enabled rules ─▶ collect diagnostics
        │
        ▼
  sort deterministically ─▶ compute score ─▶ render (terminal | JSON)
```

### 1. Project discovery and capability detection

node.doctor reads `package.json` and derives a set of **capability tokens** —
`express`, `prisma`, `typescript`, `esm`, and so on. Crucially, it inspects
version ranges: an Express `^5.0.0` dependency adds the `express:5` token, which
switches off rules that only apply to Express 4.

This is cheap by design — one manifest read, no lockfile parse, no install-tree
walk — and it is the difference between "a Fastify rule fires on an Express app"
and a tool people keep installed.

### 2. Rule selection

A rule runs only when the project satisfies its gate:

- Every token in the rule's `requires` list must be present.
- No token in its `disabledWhen` list may be present.
- Its tags must not be excluded via `--ignore-tag`.

So `no-jwt-decode-as-verify` (which `requires: ["jsonwebtoken"]`) never fires on
a project that does not use that library, and `express-async-handler-unprotected`
(which is `disabledWhen: ["express:5"]`) silently retires on a modern Express app.

### 3. Parsing

Each file is parsed with [`oxc-parser`](https://oxc.rs), a Rust-based
JavaScript/TypeScript parser that produces a standard ESTree AST an order of
magnitude faster than JavaScript-based parsers. A file that fails to parse is
recorded as a **coverage gap**, never silently reported as clean — the JSON
report's `complete` flag and `parseFailures` list make this explicit.

### 4. The request-path primitive

This is the load-bearing idea. node.doctor identifies which functions are
request handlers by detecting:

- Express/Fastify/Hono/Koa registrations: `app.get("/path", handler)`,
  including middleware (`app.use`).
- Fastify/Hono object form: `fastify.route({ method, url, handler })`.
- Nest/Adonis decorators: a class method carrying `@Get()`, `@Post()`, etc.
- A fallback for the common split-file shape: any function with a
  `(req, res)` / `(req, res, next)` signature, so a `controllers/` file whose
  handlers are mounted elsewhere is still covered.

A rule can then ask "is this node inside a request handler?" and give opposite
verdicts for the same syntax depending on the answer.

**The honest limitation:** this is *direct-lexical* detection. It sees code
written syntactically inside a handler, and it is sound in that direction —
everything it flags really is on a request path. It does not yet follow a call
from a handler into a helper defined elsewhere. That requires a call graph, which
is the headline roadmap item.

### 5. Intra-file taint

A small, local taint pass propagates "this value came from the caller" from
request-shaped roots (`req`, `request`, `ctx`, `event`) through a couple of
assignment hops. `const { name } = req.query` marks `name` as tainted.

This is used to **sharpen messages**, not to gate findings. An injection rule
still fires on interpolated SQL regardless of taint; taint only decides whether
the message says "built by interpolation" or the stronger "built from
caller-controlled input — this is SQL injection." Gating on an intentionally
unsound analysis would ship false negatives that people trust, so we don't.

### 6. Rule execution and isolation

Rules are registered as visitors keyed by AST node type (with an optional
`:exit` pass). The walker traverses once and dispatches to every interested rule.
Each rule — and each individual visitor invocation — is wrapped so that a crash
in one rule cannot take down the scan. A misbehaving rule is skipped; your report
still comes back.

### 7. Deterministic output and scoring

Diagnostics are sorted by severity, then file, then line, then column, then rule
id, so output is byte-stable across runs. Each diagnostic carries a deterministic
`id` (a hash of its location, rule, and message) — the primitive that makes CI
baseline deltas possible. Finally the score is computed locally (see
[The scoring model](#the-scoring-model)).

---

## Command-line reference

```
node-doctor [directory] [options]
node-doctor rules
node-doctor delta --baseline <file> --current <file> [options]
```

### Arguments

| Argument | Description | Default |
| --- | --- | --- |
| `directory` | Directory to scan (recursively) | current working directory |

### Options

| Option | Description | Default |
| --- | --- | --- |
| `--json` | Emit the full JSON report to stdout instead of the terminal view | off |
| `--json-out <path>` | Write the JSON report to a file (in addition to normal output) | — |
| `--verbose`, `-v` | Show every rule and every site, not just the top few per category | off |
| `--blocking <level>` | Process exit policy: `error`, `warning`, or `none` | `error` |
| `--ignore-tag <tag>` | Disable an entire rule family; repeatable | — |
| `--help`, `-h` | Show usage | — |

### The `rules` subcommand

Lists every rule, its severity, its category, and its gating, so you can see what
node.doctor checks and when each rule applies:

```bash
node-doctor rules
```

```
✖ node-doctor/express-async-handler-unprotected
    Async route handler with no error path
    Reliability · requires express · off when express:5

✖ node-doctor/no-sql-template-interpolation
    SQL built by string interpolation
    Security

⚠ node-doctor/require-fetch-timeout
    Outbound fetch without a timeout or abort signal
    Reliability
```

### The `delta` subcommand

Compares two JSON reports and prints only the findings the second one
**introduced** relative to the first. This is the engine behind CI on legacy
codebases — see [Continuous integration](#continuous-integration).

```bash
node-doctor delta --baseline base.json --current head.json --blocking error
```

| Option | Description | Default |
| --- | --- | --- |
| `--baseline <file>` | JSON report from the base branch (required) | — |
| `--current <file>` | JSON report from the head/PR (required) | — |
| `--blocking <level>` | Exit policy applied to *introduced* findings only | `error` |

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | No blocking findings (per `--blocking`), or `--blocking none` |
| `1` | At least one finding at or above the blocking level |
| `2` | Tool error (bad arguments, unreadable baseline, internal failure) |

With `--blocking error` (the default), warnings never fail the build; only errors
do. `--blocking warning` fails on either. `--blocking none` always exits `0`,
which is what you want for the informational baseline scans inside a CI delta.

### Examples

```bash
# Scan the current directory, human-readable
node-doctor .

# Scan a subdirectory, show everything
node-doctor ./services/api --verbose

# CI gate: fail only on errors
node-doctor . --blocking error

# Turn off the async and db families for this run
node-doctor . --ignore-tag async --ignore-tag db

# Write a report artifact and also print it
node-doctor . --json-out node-doctor-report.json

# Pipe JSON into jq
node-doctor . --json | jq '.score'
```

---

## Output

### Terminal report

The default view is designed to be read top to bottom and to fit real terminals.
It leads with the score and the headline counts, then groups findings by category
(largest first), and within each category by rule (most sites first). For each
rule it shows the message, the first few file locations, the recommended fix, and
the rule id. By default it caps the number of rules and sites shown per category;
`--verbose` removes the caps.

Anatomy:

```
  node.doctor v0.1.0  checkout-service            ← tool version + project name
  148 files · 21,904 lines · 50/95 diagnostics active   ← scan scope + active diagnostics
  detected: typescript esm express prisma         ← capability tokens

  ██████░░░░░░░░░░░░░░░░░░░░░░░░░░  21/100  critical   ← score bar + label

  38 errors  ·  17 warnings  ·  71.4 weighted/kLOC    ← counts + density

  Security (19)                                   ← category header + total

  ✖ SQL built by string interpolation · 6 sites   ← rule + site count
     SQL is built from caller-controlled input…    ← message
     src/orders/repository.ts:88:24                ← locations
     …
     → Use parameter binding: …                    ← recommendation
     node-doctor/no-sql-template-interpolation     ← rule id
```

### JSON report

`--json` (or `--json-out`) emits a structured report with a stable schema. This
is the contract other tools should build on.

```json
{
  "schemaVersion": 1,
  "project": {
    "name": "checkout-service",
    "rootDirectory": "/abs/path/checkout-service",
    "capabilities": ["esm", "express", "jsonwebtoken", "prisma", "typescript"],
    "analyzedFileCount": 148,
    "totalLines": 21904,
    "complete": true,
    "parseFailures": []
  },
  "rulesRun": 17,
  "rulesAvailable": 17,
  "diagnostics": [
    {
      "id": "src/orders/repository.ts::88:24::node-doctor/no-sql-template-interpolation::7c8ec1e7",
      "filePath": "/abs/path/checkout-service/src/orders/repository.ts",
      "normalizedFilePath": "src/orders/repository.ts",
      "line": 88,
      "column": 24,
      "plugin": "node-doctor",
      "rule": "no-sql-template-interpolation",
      "title": "SQL built by string interpolation",
      "category": "Security",
      "severity": "error",
      "message": "SQL is built from caller-controlled input via interpolation — this is SQL injection.",
      "recommendation": "Use parameter binding: db.query(\"SELECT ... WHERE id = $1\", [id]) …",
      "tags": ["db", "injection"]
    }
  ],
  "score": {
    "score": 21,
    "label": "critical",
    "weighted": 156.5,
    "perThousandLines": 71.44,
    "byCategory": {
      "Security": 19,
      "Bugs": 8,
      "Performance": 11,
      "Reliability": 17,
      "Maintainability": 0
    }
  }
}
```

**Schema notes:**

- `schemaVersion` is bumped on any breaking change to this shape. Pin your
  integration to a major.
- `normalizedFilePath` is repo-relative with forward slashes on every OS; use it
  for display and grouping. `filePath` is absolute; use it to open the file.
- `diagnostics[].id` is deterministic and stable for an unchanged finding. It
  changes when the finding's location or user-visible message changes. This is
  what `delta` keys on.
- `project.complete` is `false` when any file failed to parse. **Never infer
  "clean" from an empty `diagnostics` array without checking this flag** — an
  empty array plus `complete: false` means "we couldn't read part of your code,"
  not "your code is fine."
- `tags` are sorted for stability.

---

## The scoring model

The score is intentionally simple, fully local, and published here so you can
reproduce it by hand. There is no server call and no hidden model. This is a
deliberate design choice: the score is the headline number that can gate merges,
so it must be auditable and available offline.

### The formula

Start at a perfect **100** and subtract a penalty derived from the *density* of
weighted findings.

**Step 1 — weight each finding** by severity and category:

```
finding_weight = severity_weight × category_weight
```

| Severity | Weight | | Category | Weight |
| --- | --- | --- | --- | --- |
| `error` | 3 | | Security | 2.0 |
| `warn` | 1 | | Reliability | 1.5 |
| | | | Bugs | 1.5 |
| | | | Performance | 1.0 |
| | | | Maintainability | 0.5 |

So a Security **error** is worth `3 × 2.0 = 6.0`; a Performance **warning** is
worth `1 × 1.0 = 1.0`.

**Step 2 — sum and normalize by size.** Raw counts would punish large codebases
for existing, so we measure findings per 1,000 lines:

```
weighted_total   = Σ finding_weight
per_kloc         = (weighted_total / total_lines) × 1000
```

**Step 3 — convert density to a penalty.** A project with roughly one weighted
error every ~30 lines bottoms out at zero. The constant that encodes this is
`DENSITY_AT_ZERO = 100` (weighted points per kLOC that map to a 100-point
penalty):

```
penalty = min(100, (per_kloc / 100) × 100)
score   = max(0, round(100 − penalty))
```

**Step 4 — label the score:**

| Score | Label |
| --- | --- |
| 75–100 | `healthy` |
| 50–74 | `needs work` |
| 0–49 | `critical` |

### Worked example

A 2,000-line service with 3 Security errors and 4 Performance warnings:

```
weighted_total = (3 × 3 × 2.0) + (4 × 1 × 1.0) = 18.0 + 4.0 = 22.0
per_kloc       = (22.0 / 2000) × 1000          = 11.0
penalty        = min(100, (11.0 / 100) × 100)  = 11.0
score          = round(100 − 11.0)             = 89  → healthy
```

### Why density, not raw count

A raw-count score would tell a 500k-line monolith it is hopeless and a 50-line
script it is perfect, regardless of how careful each actually is. Density asks
the fair question: *given how much code there is, how concentrated are the
problems?* A small file with one injection scores far worse than a large,
well-kept service with the same single finding — which is exactly the signal you
want.

---

## The ruleset

Rules are grouped into **categories** (which drive scoring weight) and tagged
with **families** (which drive `--ignore-tag`). Every rule has one of two
**severities**: `error` (fix before shipping) or `warn` (should fix).

### Categories

| Category | What it means | Weight |
| --- | --- | --- |
| **Security** | Injection, secret handling, auth bypass | 2.0 |
| **Reliability** | Crashes, hangs, resource exhaustion, lifecycle | 1.5 |
| **Bugs** | Logic errors that produce wrong results | 1.5 |
| **Performance** | Event-loop stalls, N+1, avoidable slow paths | 1.0 |
| **Maintainability** | Structure, hygiene, dead code, complexity, deprecated APIs | 0.5 |

### The catalog at a glance

The catalog is **generated from the source tree**, so a table here would drift the
moment a diagnostic is added. Ask the tool instead:

```bash
node-doctor diagnostics                      # every diagnostic, with gating and effective severity
node-doctor diagnostics --json               # machine-readable
node-doctor diagnostics --category Security  # filter by category, tag, or framework
node-doctor explain <id>                     # what one diagnostic catches, and why
```

Each entry reports its category, default severity, capability gating
(`requires` / `disabledWhen`), whether it is on by default, and where its
effective severity came from (default vs your config).


---

### `express-async-handler-unprotected`

**Reliability · error ·** requires `express`, disabled on `express:5`

An `async` Express route handler with no `try/catch` and no async wrapper.

**Why it matters.** Express 4 wraps handler invocation in a *synchronous*
try/catch. An `async` handler returns a promise immediately, so any rejection
*after the first `await`* escapes that catch entirely. Your error-handling
middleware never fires, the response is never sent, and the client hangs until
its own timeout. In older Node it additionally triggered an `unhandledRejection`
process kill. This is the Express footgun agents reproduce most reliably, and it
is exactly the kind of bug that never appears in a test that only exercises the
success path.

The rule gates itself off when `express:5` is detected, because Express 5 awaits
handler return values and propagates the rejection correctly.

❌ **Flagged:**

```js
app.get("/users/:id", async (req, res) => {
  const user = await db.user.findUnique({ where: { id: req.params.id } });
  res.json(user); // if findUnique rejects, this request hangs forever
});
```

✅ **Not flagged:**

```js
// Wrapped
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

app.get("/users/:id", asyncHandler(async (req, res) => {
  const user = await db.user.findUnique({ where: { id: req.params.id } });
  res.json(user);
}));

// Or caught inline
app.get("/users/:id", async (req, res, next) => {
  try {
    const user = await db.user.findUnique({ where: { id: req.params.id } });
    res.json(user);
  } catch (error) {
    next(error);
  }
});
```

**Fires when:** an async handler contains its own `await`, has no `try`, and is
not wrapped by a recognized async wrapper (`asyncHandler`, `expressAsyncHandler`,
`catchAsync`, `wrapAsync`, and similar).

**Stays silent when:** the handler has no `await` (no post-await rejection
window), is wrapped, contains a `try`, or the project is on Express 5.

---

### `express-missing-return-after-response`

**Bugs · error ·** requires `express`

A guard clause sends a response but does not `return`, so execution falls
through into the code the guard was meant to prevent.

**Why it matters.** `res.status(400).json({...})` does not stop the handler.
Without a `return`, control continues past the guard: the "rejected" request
still runs the protected logic, and the handler then tries to respond a second
time, producing `ERR_HTTP_HEADERS_SENT`. The visible symptom is a crash; the
invisible one is that your validation did not actually stop anything.

❌ **Flagged:**

```js
app.post("/login", async (req, res) => {
  if (!req.body.email) {
    res.status(400).json({ error: "email required" }); // no return
  }
  // runs even when email is missing:
  const user = await db.user.findUnique({ where: { email: req.body.email } });
  res.json(user); // second response → headers already sent
});
```

✅ **Not flagged:**

```js
app.post("/login", async (req, res) => {
  if (!req.body.email) {
    return res.status(400).json({ error: "email required" });
  }
  const user = await db.user.findUnique({ where: { email: req.body.email } });
  res.json(user);
});
```

**Fires when:** a terminal response call (`res.json`, `res.send`, `res.end`,
`res.redirect`, `res.render`, `res.sendFile`, `res.sendStatus`) is the last
statement inside a guard-shaped `if` block that has no `else`, and there is code
after the `if`.

**Stays silent when:** the call is prefixed with `return`, the `if` has an
`else` branch, or the response is the last thing in the handler (a legitimate,
common shape).

---

### `cors-credentials-reflect`

**Security · error**

CORS is configured to reflect any origin while also sending credentials.

**Why it matters.** `origin: true` reflects whatever `Origin` header the caller
sent. Combined with `credentials: true`, the browser will attach the victim's
cookies to a cross-site request from *any* attacker page and let that page read
the response. This is CSRF with a free read primitive. The CORS spec forbids the
`*` wildcard precisely to prevent this; `origin: true` is the same hole with the
guardrail removed.

❌ **Flagged:**

```js
app.use(cors({ origin: true, credentials: true }));
// also flagged: origin: "*", or a function that always calls cb(null, true)
```

✅ **Not flagged:**

```js
const ALLOWED = ["https://app.example.com", "https://admin.example.com"];
app.use(cors({ origin: ALLOWED, credentials: true }));

// or a validating function
app.use(cors({
  origin: (origin, cb) => cb(null, ALLOWED.includes(origin)),
  credentials: true,
}));
```

**Fires when:** a `cors(...)` call has `credentials: true` and an `origin` that
reflects the caller (`true`, `"*"`, or a function whose body unconditionally
signals allow).

**Stays silent when:** `credentials` is absent/false, or `origin` is an explicit
allowlist or a validating function.

---

### `no-sync-io-in-request-path`

**Performance · error**

A blocking synchronous call (`*Sync` fs/child_process/crypto/zlib) on a request
path.

**Why it matters.** Node executes your JavaScript on a single thread. A
synchronous read inside a handler does not block "this request" — it blocks
**every** concurrent request, the timers, and the health check the orchestrator
uses to decide whether to kill the pod. The same call at module scope is a
correct one-time boot cost. This rule is the reason request-path detection
exists: identical node, opposite verdict based on position.

❌ **Flagged:**

```js
app.get("/report/:id", (req, res) => {
  const template = fs.readFileSync("./templates/report.html", "utf8"); // stalls the process
  res.send(render(template));
});
```

✅ **Not flagged:**

```js
// Async on the request path
app.get("/report/:id", async (req, res) => {
  const template = await fs.promises.readFile("./templates/report.html", "utf8");
  res.send(render(template));
});

// Sync at module scope: correct, one-time, idiomatic
const config = JSON.parse(fs.readFileSync("./config.json", "utf8"));
```

**Detected sinks include:** `readFileSync`, `writeFileSync`, `readdirSync`,
`statSync`, `existsSync`, `execSync`, `execFileSync`, `spawnSync`, `pbkdf2Sync`,
`scryptSync`, `gzipSync`, `brotliCompressSync`, and more.

**Fires when:** one of these calls is on a request path (inside a registered
handler, or inside a `(req, res)`-signature function).

**Stays silent when:** the call is at module scope or inside a non-handler
function (a boot-time loader, a CLI script).

---

### `no-process-exit-in-request-path`

**Reliability · error**

`process.exit()` (or `process.abort()`) reachable from a request handler.

**Why it matters.** `process.exit()` terminates immediately: in-flight requests
are severed mid-response, pending writes are lost, and open transactions are
abandoned for the database to time out. Inside a handler it converts one bad
request into a whole-instance outage — a free denial of service for anyone who
discovers the triggering input.

❌ **Flagged:**

```js
app.get("/admin/shutdown", (req, res) => {
  if (req.query.confirm) process.exit(0); // kills every in-flight request
  res.json({ ok: true });
});
```

✅ **Not flagged:**

```js
app.get("/admin/shutdown", (req, res) => {
  if (req.query.confirm) {
    scheduleGracefulShutdown(); // drain, then exit outside the request
    return res.status(202).json({ status: "shutting down" });
  }
  res.json({ ok: true });
});

// process.exit in a top-level fatal handler is fine and not on a request path
process.on("uncaughtException", (err) => { logger.fatal(err); process.exit(1); });
```

**Fires when:** `process.exit`/`process.abort` is on a request path.

**Stays silent when:** it is in startup code, a signal handler, or a CLI entry
point.

---

### `no-async-array-callback`

**Bugs · error**

An `async` function passed to a synchronous array method.

**Why it matters.** These methods do not await. The failure mode depends on the
method:

- `forEach` / discarded `map` → N floating promises: errors vanish, ordering is
  lost, the surrounding function resolves before the work finishes.
- `filter` / `find` / `some` / `every` → the returned promise is always truthy,
  so the async predicate silently *matches everything*.

❌ **Flagged:**

```js
users.forEach(async (user) => { await sendEmail(user); }); // fire-and-forget
const active = users.filter(async (u) => await isActive(u)); // matches all users
items.map(async (i) => { await save(i); });                  // promise array discarded
```

✅ **Not flagged:**

```js
// Sequential
for (const user of users) { await sendEmail(user); }

// Parallel, awaited
await Promise.all(users.map((user) => sendEmail(user)));

// Async predicate done right: resolve first, then filter synchronously
const flags = await Promise.all(users.map(isActive));
const active = users.filter((_, i) => flags[i]);
```

**Fires when:** an async callback is passed to `forEach`, a coercing predicate
(`filter`/`find`/`some`/`every`/`sort`), or a `map`/`flatMap` whose result is
discarded.

**Stays silent when:** the `map` result is awaited/returned/assigned, or the
iteration uses `for...of` with `await`.

---

### `no-unbounded-promise-all`

**Reliability · warn**

`Promise.all` (or `allSettled`/`race`/`any`) over `collection.map(asyncFn)` with
no concurrency limit.

**Why it matters.** This opens one connection *per element* simultaneously. On a
small authored array it is fine; on a caller-supplied collection it is a
self-inflicted DoS — socket exhaustion, connection-pool starvation, or a
rate-limit ban from the upstream. The fix is to bound the fan-out, not to remove
the parallelism.

❌ **Flagged:**

```js
const restaurants = await db.restaurant.findMany(); // unbounded size
await Promise.all(restaurants.map((r) => fetch(`https://partner.api/${r.id}`)));
```

✅ **Not flagged:**

```js
import pLimit from "p-limit";
const limit = pLimit(5); // at most 5 in flight

const restaurants = await db.restaurant.findMany();
await Promise.all(
  restaurants.map((r) => limit(() => fetch(`https://partner.api/${r.id}`)))
);

// A literal, finite array is known-small and not flagged
await Promise.all([fetchA(), fetchB(), fetchC()]);
```

**Fires when:** the mapped collection is a variable/expression (not an array
literal) and the mapper is async.

**Stays silent when:** the collection is an array literal, or a concurrency-bound
wrapper is applied.

---

### `require-fetch-timeout`

**Reliability · warn**

An outbound `fetch` with no `signal` / timeout.

**Why it matters.** A `fetch` without a signal waits effectively forever for a
server that accepts the socket and then stalls. One hung upstream pins a request
slot, then a connection, then eventually the pool — a slow-motion outage caused
by a dependency you do not control.

❌ **Flagged:**

```js
const res = await fetch("https://partner.api/sync"); // no timeout
const res2 = await fetch(url, { method: "POST", body }); // options, but no signal
```

✅ **Not flagged:**

```js
const res = await fetch("https://partner.api/sync", {
  signal: AbortSignal.timeout(5_000), // Node 18+
});
```

**Fires when:** a `fetch` call has no second argument, or an object-literal
second argument with no `signal` property.

**Stays silent when:** a `signal` is present, or the options are spread/variable
(unanalyzable without types — we stay quiet rather than guess).

---

### `no-exec-with-interpolation`

**Security · error**

A shell command built by string interpolation or concatenation.

**Why it matters.** `exec` spawns a *shell*. Any interpolated value can carry
`;`, `&&`, backticks, or `$(...)` and become a second command running as your
service account. `execFile("git", ["clone", url])` does not have this problem
because there is no shell to re-parse the arguments — that is the entire fix.

❌ **Flagged:**

```js
exec(`tar -czf backup.tgz ${req.body.directory}`); // ; rm -rf / …
exec("convert " + filename + " out.png");
```

✅ **Not flagged:**

```js
execFile("tar", ["-czf", "backup.tgz", directory]); // argument array, no shell
execFile("convert", [filename, "out.png"]);
```

**Fires when:** `exec`/`execSync` receives a template literal with interpolation
or a `+` concatenation. The message escalates to "command injection" when taint
analysis links the value to caller input.

**Stays silent when:** the command is a static string, or `execFile`/`spawn` with
an argument array is used.

---

### `no-sql-template-interpolation`

**Security · error**

SQL built by string interpolation instead of parameter binding.

**Why it matters.** Parameter binding is not a convenience — it is the only thing
that keeps data from being re-parsed as SQL grammar. An interpolated query has
already lost that boundary before the driver ever sees it. This rule correctly
*allows* Prisma's tagged `$queryRaw` template, which parameterizes every `${}`,
and flags only the unsafe call forms.

❌ **Flagged:**

```js
db.query(`SELECT * FROM users WHERE email = '${req.body.email}'`);
db.$queryRawUnsafe(`SELECT * FROM users WHERE id = ${id}`);
db.execute("DELETE FROM sessions WHERE token = " + token);
```

✅ **Not flagged:**

```js
db.query("SELECT * FROM users WHERE email = $1", [email]);       // bound params
db.$queryRaw`SELECT * FROM users WHERE id = ${id}`;              // Prisma tagged template (safe)
knex("users").where({ email }).first();                          // query builder
```

**Fires when:** a query method (`query`, `execute`, `$queryRawUnsafe`,
`$executeRawUnsafe`, `raw`, `unsafe`) receives an interpolated template or `+`
concatenation.

**Stays silent when:** the argument is a parameterized string, a tagged template
expression, or a query-builder chain.

---

### `secret-in-env-fallback`

**Security · error**

A secret-shaped environment variable with a hardcoded fallback value.

**Why it matters.** `process.env.JWT_SECRET || "dev-secret"` is the most common
way a real signing key ends up in git — and it is *worse* than a plain hardcoded
secret, because it works in every environment. Nothing ever fails loudly enough
to get noticed, so production silently signs tokens with a value anyone can read
off your repository. The fix is to fail fast at boot instead of degrading
silently.

❌ **Flagged:**

```js
const JWT_SECRET = process.env.JWT_SECRET || "super-secret-dev-key-123";
const apiKey = process.env.API_KEY ?? "sk_live_fallback_value";
```

✅ **Not flagged:**

```js
// Validate at boot, no fallback
if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is required");
const JWT_SECRET = process.env.JWT_SECRET;

// Non-secret vars can have sensible defaults
const port = process.env.PORT || "3000";

// Obvious placeholders are not flagged
const key = process.env.API_KEY || "changeme";
```

**Fires when:** the left side is `process.env.<SECRET_NAME>` (name matching
secret/token/key/password/credential/etc.), joined by `||`/`??` to a string
literal that is not a short/placeholder value.

**Stays silent when:** the variable name is not secret-shaped, or the fallback is
a placeholder (`changeme`, `xxx`, `todo`, `<...>`) or too short to be a real
credential.

---

### `no-timing-unsafe-secret-compare`

**Security · warn**

A secret compared with `===` instead of a constant-time comparison.

**Why it matters.** `===` on strings short-circuits at the first differing byte,
so response time leaks a prefix oracle: an attacker recovers the secret one byte
at a time instead of brute-forcing the whole thing. This is practical over a LAN
or against a co-located function. `crypto.timingSafeEqual` compares in constant
time and the fix costs one line.

❌ **Flagged:**

```js
if (signature === expectedSignature) { /* … */ }
if (req.headers["x-api-key"] !== apiKey) return res.status(401).end();
```

✅ **Not flagged:**

```js
import { timingSafeEqual } from "node:crypto";

const a = Buffer.from(signature);
const b = Buffer.from(expectedSignature);
if (a.length === b.length && timingSafeEqual(a, b)) { /* … */ }
```

**Fires when:** both operands of `===`/`!==`/`==`/`!=` are secret-shaped
identifiers or members (name matching secret/token/signature/hmac/apikey/etc.).

**Stays silent when:** either side is a literal (a sentinel check, not a secret
compare), or neither side is secret-shaped.

---

### `no-jwt-decode-as-verify`

**Security · error ·** requires `jsonwebtoken`

`jwt.decode()` used where the result steers an authorization decision.

**Why it matters.** `jwt.decode()` parses the payload *without checking the
signature*. Anyone can mint `{"role":"admin"}`, base64-encode it, and send it. If
the decoded claims then drive an authorization decision, the token is not
authentication — it is a request parameter the caller fully controls. The rule is
deliberately narrow: decoding a token to read `exp` for a refresh heuristic is
legitimate and not flagged.

❌ **Flagged:**

```js
const claims = jwt.decode(req.headers.authorization);
if (claims.role !== "admin") return res.status(403).end(); // trusts unsigned claims
```

✅ **Not flagged:**

```js
const claims = jwt.verify(token, JWT_SECRET, { algorithms: ["RS256"] });
if (claims.role !== "admin") return res.status(403).end();

// Decoding for a non-authz purpose is fine
const { exp } = jwt.decode(token);
if (exp * 1000 < Date.now()) scheduleRefresh();
```

**Fires when:** a `jwt.decode(...)` result is used near an authorization-shaped
member access (`role`, `admin`, `scope`, `permission`, `sub`, `userId`, `tenant`,
`org`).

**Stays silent when:** `jwt.verify` is used, or the decoded value never touches an
authz-shaped field.

---

### `no-weak-hash-for-password`

**Security · error**

MD5/SHA-1 used in a password-storage context.

**Why it matters.** MD5 and SHA-1 are *fast*, which is exactly what makes them
wrong for passwords: a commodity GPU does billions of guesses a second. Password
hashing wants a deliberately slow, salted, memory-hard KDF. This is not a "weak
algorithm" style nit — it is the difference between a leaked table being useless
and being cracked overnight. The rule is context-gated: a fast hash for an ETag or
a cache key is fine and not flagged.

❌ **Flagged:**

```js
function hashPassword(password) {
  return crypto.createHash("md5").update(password).digest("hex"); // GPU-crackable
}
```

✅ **Not flagged:**

```js
import argon2 from "argon2";
async function hashPassword(password) {
  return argon2.hash(password); // argon2id: slow, salted, memory-hard
}

// A weak hash for a non-secret purpose is fine
function etagFor(body) {
  return crypto.createHash("md5").update(body).digest("hex");
}
```

**Fires when:** `crypto.createHash("md5" | "sha1" | ...)` appears in a scope that
also references password-shaped identifiers.

**Stays silent when:** no password context is present (ETags, cache keys, content
addressing).

---

### `no-path-traversal`

**Security · error**

A filesystem path built from caller input without a containment check.

**Why it matters.** `path.join(UPLOAD_DIR, req.params.name)` looks scoped, but
`join` happily resolves `../../../etc/passwd`. The containment you assumed is not
enforced anywhere — `join` normalizes, it does not confine. An attacker reads any
file the process can read.

❌ **Flagged:**

```js
app.get("/files/:name", (req, res) => {
  const full = path.join("./uploads", req.params.name); // ../ escapes uploads
  res.sendFile(full);
});
```

✅ **Not flagged:**

```js
app.get("/files/:name", (req, res) => {
  const root = path.resolve("./uploads");
  const full = path.resolve(root, req.params.name);
  if (!full.startsWith(root + path.sep)) return res.status(400).end(); // containment guard
  res.sendFile(full);
});

// Or strip traversal entirely
const full = path.join("./uploads", path.basename(req.params.name));
```

**Fires when:** `path.join`/`path.resolve` receives a caller-controlled segment
and no containment guard (`startsWith`, `relative`, `realpath`, `basename`,
`isAbsolute`) appears in the enclosing function.

**Stays silent when:** a containment check is present, or no segment is
caller-controlled.

---

### `no-query-in-loop`

**Performance · error**

A database query inside a loop — the N+1.

**Why it matters.** One query to list, then one query per row. With five rows in
development it is invisible; in production with five thousand it is five thousand
round trips inside a single request, each holding a pool connection. This is the
most common cause of "it was fast on my machine" in Node services, and agents
write it constantly because the loop form reads more naturally than the join.

This rule uses *segment-aware* receiver matching to avoid a specific false
positive class: an earlier version flagged `items.find()` because the token
`em` (TypeORM's EntityManager) appears inside "it-**em**-s". Short, ambiguous
receiver names must now match a whole path segment.

❌ **Flagged:**

```js
const orders = await db.order.findMany();
for (const order of orders) {
  order.items = await db.orderItem.findMany({ where: { orderId: order.id } }); // N+1
}
```

✅ **Not flagged:**

```js
// Single round trip with eager loading
const orders = await db.order.findMany({ include: { items: true } });

// Array.prototype.find in a loop is not a query
for (const order of orders) {
  const match = lookupTable.find((row) => row.id === order.id);
}

// A deliberate batch (Promise.all) is not treated as N+1
const results = await Promise.all(ids.map((id) => db.item.findUnique({ where: { id } })));
```

**Fires when:** a query-shaped method (`findMany`, `findUnique`, `query`,
`execute`, `select`, `save`, …) is called on a database-shaped receiver inside a
`for`/`while` loop, and the loop is not a `Promise.all` batch.

**Stays silent when:** the receiver is an array/plain object, the query is
outside any loop, or the loop body is a batched `Promise.all`.

---

### `no-unbounded-module-cache`

**Reliability · warn**

A module-scope `Map`/`Set` that is written but never evicted.

**Why it matters.** A module-scope cache that is only ever written to is not a
cache — it is a memory leak with a friendly name. It survives every request,
grows forever, and the pod OOMs at 3am. A real cache has an eviction story: a
TTL, a max size, or an explicit delete keyed to a lifecycle event.

❌ **Flagged:**

```js
const sessionCache = new Map();
export function remember(token, user) {
  sessionCache.set(token, user); // only ever grows
}
```

✅ **Not flagged:**

```js
// Bounded via TTL sweep
const sessionCache = new Map();
setInterval(() => sessionCache.clear(), 60_000);

// Or an LRU with a max size
import { LRUCache } from "lru-cache";
const sessionCache = new LRUCache({ max: 10_000 });

// WeakMap self-evicts when keys are collected
const cache = new WeakMap();

// A function-scoped Map dies with the call, not flagged
function group(items) {
  const m = new Map();
  for (const i of items) m.set(i.id, i);
  return m;
}
```

**Fires when:** a module-scope `Map`/`Set` receives writes (`set`/`add`/`push`)
and never any eviction (`delete`/`clear`/`evict`/`prune`/`expire`/`reset`).

**Stays silent when:** eviction exists, the collection is a `WeakMap`/`WeakSet`,
or it is scoped inside a function.

---

## Capability detection and gating

Capabilities are the vocabulary that decides which rules run. They are derived
from `package.json` and the presence of certain files.

### Detected tokens

| Token | Detected from |
| --- | --- |
| `node` | Always present |
| `esm` / `cjs` | `package.json` `type` field |
| `typescript` | `typescript` dependency or a `tsconfig.json` |
| `express` | `express` dependency |
| `express:5` | `express` dependency with major version ≥ 5 |
| `fastify` | `fastify` dependency |
| `hono` | `hono` dependency |
| `nest` | `@nestjs/core` dependency |
| `adonis` | `@adonisjs/core` dependency |
| `prisma` | `@prisma/client` dependency |
| `drizzle` | `drizzle-orm` dependency |
| `knex` | `knex` dependency |
| `mongoose` | `mongoose` dependency |
| `jsonwebtoken` | `jsonwebtoken` dependency |

### How gating works

Each rule may declare:

- **`requires`** — every listed token must be present, or the rule does not run.
- **`disabledWhen`** — if any listed token is present, the rule does not run.

For example, `express-async-handler-unprotected` is
`requires: ["express"], disabledWhen: ["express:5"]`: it runs on an Express 4
project and is silent on both non-Express projects and Express 5 projects. The
scan header reports the active count (`50/95 diagnostics active`), and the `diagnostics`
subcommand shows each rule's gating so nothing is a surprise.

---

## Configuration

Everything in this section is live: tag filtering, the config file with per-path
overrides, and inline suppression with mandatory reasons.

### Tag filtering

Every rule carries one or more family tags. Disable an entire family for a run:

```bash
node-doctor . --ignore-tag async --ignore-tag db
```

Available tags include: `async`, `concurrency`, `network`, `event-loop`,
`lifecycle`, `injection`, `db`, `n+1`, `crypto`, `secrets`, `auth`, `cors`,
`fs`, `memory`, `express`.

### Config file

A `node-doctor.config.json` / `.jsonc` / `.js` (or a `nodeDoctor` key in
`package.json`) sets defaults so they do not have to be passed on every
invocation. Resolution walks up from the scan root to the repo boundary, so a
nested package inherits the repo-root config:

```js
// node-doctor.config.js
export default {
  // Override severity, or enable an opt-in diagnostic
  diagnostics: {
    "no-query-in-loop": "off",
    "require-fetch-timeout": "error", // upgrade a warning to an error
    "max-function-length": "warn",    // opt-in: off unless named here
  },

  // Disable whole families
  ignoreTags: ["async"],

  // Skip paths entirely (in addition to the built-in ignores)
  ignore: ["**/legacy/**", "**/*.generated.ts"],

  // Re-severity or silence per path — can even re-enable a globally-off
  // diagnostic for specific files
  overrides: [{ files: ["tests/**"], diagnostics: { "no-console-log-in-committed-code": "off" } }],

  // Default exit policy
  blocking: "error",
};
```

Built-in ignores (always applied): `node_modules`, `dist`, `build`, `.next`,
`coverage`, `*.d.ts`, `*.min.js`.

---

## Suppressing findings

When a finding is a genuine false positive, or an accepted risk with a documented
reason, suppress it inline. A **reason is mandatory** — an unexplained suppression
raises `suppression-without-reason`, because a silent disable is how a real bug
lives forever:

```js
// node-doctor-disable-next-line no-sync-io-in-request-path -- one-time warmup, gated behind a flag
const seed = fs.readFileSync("./seed.json", "utf8");
```

```js
/* node-doctor-disable no-exec-with-interpolation */
// … block where the rule is intentionally off …
/* node-doctor-enable no-exec-with-interpolation */
```

**Suppression requires a reason** (the text after `--`). A suppression with no
justification is itself reported, so the escape hatch cannot be used to silently
hide problems. This mirrors the project's stance in the agent skill: a false
positive is a bug in the rule and should be reported, not quietly silenced.

---

## Continuous integration

node.doctor is built for CI, and specifically for CI on codebases that predate
it. The killer feature is the **baseline delta**.

### The problem with linting legacy code in CI

Point any analyzer at a large existing codebase and it finds thousands of
pre-existing issues. If CI fails on all of them, the first PR after adoption is
blocked by problems it did not introduce, someone adds `continue-on-error` to
unblock the release, and the check becomes decoration. The tool is off in
everything but name.

### The solution: report only what the PR introduced

The baseline delta scans the base branch and the head branch, then reports **only
the findings the PR added**. Pre-existing issues are ignored; you are accountable
only for what your diff introduced. This makes node.doctor adoptable on day one,
on any codebase, without a cleanup sprint first.

### GitHub Actions

A ready-to-use workflow ships in the repo at
`.github/workflows/node-doctor.yml`:

```yaml
name: node-doctor

on:
  pull_request:

jobs:
  scan:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Scan base branch (baseline)
        run: |
          git checkout --detach origin/${{ github.base_ref }}
          npx node-doctor@latest . --json-out /tmp/baseline.json --blocking none

      - name: Scan head
        run: |
          git checkout --detach ${{ github.sha }}
          npx node-doctor@latest . --json-out /tmp/current.json --blocking none

      - name: Report introduced findings only
        run: |
          npx node-doctor@latest delta \
            --baseline /tmp/baseline.json \
            --current /tmp/current.json \
            --blocking error
```

The two baseline scans use `--blocking none` (they are informational — they must
never fail the job), and only the final `delta` step enforces a policy, on the
introduced set alone.

### Example delta output

```
  ✓ 1 finding(s) resolved by this change

  2 new finding(s) introduced by this change:

  ✖ src/invoices/routes.ts:94:26
    Async route handler with no error path
    Async handler has no try/catch and is not wrapped — a rejection after the
    first await escapes Express 4 error handling and the request hangs.
    → Wrap the handler (asyncHandler(fn) / express-async-errors), add a
      try/catch that calls next(error), or upgrade to Express 5.
    node-doctor/express-async-handler-unprotected

  ✖ src/invoices/routes.ts:97:27
    Database query inside a loop (N+1)
    Query runs once per iteration — N round trips for one request. Batch it.
    → Fetch the set in one round trip: a JOIN, a WHERE id IN (...), or the ORM's
      eager-load (include / with / populate).
    node-doctor/no-query-in-loop
```

### GitLab CI

```yaml
node-doctor:
  image: node:20
  script:
    - git fetch origin $CI_MERGE_REQUEST_TARGET_BRANCH_NAME
    - git checkout FETCH_HEAD
    - npx node-doctor@latest . --json-out baseline.json --blocking none
    - git checkout $CI_COMMIT_SHA
    - npx node-doctor@latest . --json-out current.json --blocking none
    - npx node-doctor@latest delta --baseline baseline.json --current current.json --blocking error
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
```

### Pre-commit hook

For fast local feedback, scan on commit via
[husky](https://typicode.github.io/husky) + a script:

```json
{
  "scripts": {
    "precommit:node-doctor": "node-doctor . --blocking error"
  }
}
```

```bash
# .husky/pre-commit
npm run precommit:node-doctor
```

---

## Agent integration

This is what separates node.doctor from a linter. A linter catches bad code after
it is written. node.doctor also ships its knowledge **into the agent that writes
the code**, so the code is correct the first time.

### Install the skill

```bash
npx node-doctor@latest install
```

This writes a skill/rules file into your agent's config — Claude Code, Cursor,
Windsurf, Codex, and other clients that support skills or project rules. From
then on, the agent treats node.doctor's checks as part of how it writes Node
code, and it runs the scanner before declaring backend work complete.

### The skill's philosophy

The skill (`skill/SKILL.md`) is deliberately thin. It does not try to encode all
seventeen rules as prose — that would drift out of date the moment a rule
changed. Instead it tells the agent to **run the scanner and trust its output**,
and it teaches the reasoning the scanner cannot yet automate:

> **Do not guess — verify.** Do not reason about whether the code has these
> problems. Run the scanner. It resolves the project's actual dependency
> versions, which changes the verdict.

> **When the scan is clean but you are still on the hook.** The scanner is
> intra-file and syntactic. A clean scan means "no detected defects," never
> "correct." Reason about the cross-file cases yourself.

It also gives the agent four questions to ask of any handler it writes: where a
post-`await` rejection goes, whether anything blocks the event loop, whether the
code fans out proportionally to caller input, and which values crossed the
network and where they land.

And it sets a firm stance on the escape hatch:

> Do not suppress a rule to make a scan pass. If a finding is wrong, say so
> explicitly and explain why; a false positive is a bug in the rule and should
> be reported, not silenced.

---

## Programmatic API

node.doctor is a library as well as a CLI. Import it to build custom
integrations, dashboards, or bespoke CI logic.

```js
import {
  scanProject,
  lintSource,
  computeDelta,
  calculateScore,
  renderReport,
  RULES,
  RULES_BY_ID,
  discoverProject,
  shouldEnableRule,
} from "node-doctor";
```

### `scanProject(options)`

Scan a directory. Returns the same report object as `--json`.

```js
const report = await scanProject({
  rootDirectory: "/path/to/service",
  ignoredTags: new Set(["async"]), // optional
  only: ["/path/to/service/src/routes.ts"], // optional: explicit file list (diff/staged mode)
});

console.log(report.score.score, report.score.label);
for (const d of report.diagnostics) {
  console.log(`${d.normalizedFilePath}:${d.line} ${d.rule} — ${d.message}`);
}
```

### `lintSource(options)`

Lint a single source string with no filesystem access — ideal for editor
integrations and unit tests.

```js
const { diagnostics, parseFailed } = lintSource({
  filePath: "app.js",
  sourceText: `app.get("/u", async (req, res) => { const u = await db.find(1); res.json(u); });`,
  rules: RULES.filter((r) => shouldEnableRule(r, new Set(["node", "express"]))),
  capabilities: new Set(["node", "express"]),
});
```

### `computeDelta(baseline, current)`

Diff two reports; returns `{ introduced, resolved }` arrays of diagnostics.

```js
const { introduced, resolved } = computeDelta(baselineReport, currentReport);
if (introduced.some((d) => d.severity === "error")) process.exit(1);
```

### `calculateScore(diagnostics, { totalLines })`

Run the scoring model on an arbitrary diagnostic set.

### `renderReport(report, { verbose })`

Produce the terminal-formatted string for a report.

### `RULES` / `RULES_BY_ID`

The full rule array and a `Map` keyed by rule id, for building your own
catalogs, docs, or config UIs.

### Editor integration sketch

```js
// On document change, lint just the buffer and surface diagnostics.
import { lintSource, RULES, shouldEnableRule } from "node-doctor";

function lintBuffer(filePath, text, capabilities) {
  const caps = new Set(capabilities);
  const rules = RULES.filter((r) => shouldEnableRule(r, caps));
  const { diagnostics } = lintSource({ filePath, sourceText: text, rules, capabilities: caps });
  return diagnostics.map((d) => ({
    range: { line: d.line - 1, column: d.column - 1 },
    severity: d.severity,
    message: `${d.message}\n${d.recommendation}`,
    source: `node-doctor/${d.rule}`,
  }));
}
```

---

## Framework support

| Framework / library | Request-path detection | Dedicated rules | Notes |
| --- | --- | --- | --- |
| **Express** 4 | ✓ | ✓ (async handler, missing return, CORS) | Full support |
| **Express** 5 | ✓ | ✓ (async-handler rule auto-retires) | Full support |
| **Fastify** | ✓ (method + object route forms) | Partial (shared rules apply) | Dedicated rules on roadmap |
| **Hono** | ✓ | Partial | Dedicated rules on roadmap |
| **Koa** | ✓ (middleware form) | Partial | Dedicated rules on roadmap |
| **Nest** | ✓ (decorator handlers) | Partial | Dedicated rules on roadmap |
| **Adonis** | ✓ (decorator handlers) | Partial | Dedicated rules on roadmap |
| **Prisma** | — | ✓ (raw query, N+1 eager-load hints) | Full support |
| **Drizzle / Knex / Mongoose / TypeORM** | — | Partial (N+1 receiver-aware) | Dedicated rules on roadmap |

"Shared rules apply" means the framework-agnostic rules (async, event-loop,
injection, secrets, memory) work everywhere; only the framework-*specific* rules
are Express-first in v0. Broadening framework-specific coverage is a primary
roadmap item.

---

## Comparison with other tools

node.doctor is not trying to replace the ecosystem. Here is where it fits.

| Tool | Focus | Context-aware | Score | Baseline delta | Agent skill | Setup |
| --- | --- | --- | --- | --- | --- | --- |
| **node.doctor** | Node runtime defects | ✓ | ✓ | ✓ | ✓ | Zero-config |
| **ESLint** + plugins | General correctness + style | ✗ | ✗ | ✗ | ✗ | You assemble it |
| **Biome** | Fast lint + format | ✗ | ✗ | ✗ | ✗ | Config file |
| **Semgrep** | Pattern-based security | Partial | ✗ | ✓ (paid) | ✗ | Write/import rules |
| **Snyk Code** | Security (SAST) | ✓ | ✗ | ✓ | ✗ | Account + CLI |
| **SonarQube** | Quality gate + coverage | Partial | ✓ (quality gate) | ✓ | ✗ | Server + scanner |
| **CodeQL** | Deep dataflow security | ✓ (dataflow) | ✗ | ✓ | ✗ | Heavy setup |

**In prose:**

- **ESLint / Biome** are your baseline for style and general correctness. Keep
  them. node.doctor is a focused complement, not a substitute.
- **Semgrep / Snyk / CodeQL** are strong security tools, and CodeQL in particular
  does the whole-program dataflow node.doctor has on its roadmap. They are heavier
  to set up and are not opinionated about Node-specific *reliability* (event-loop
  stalls, N+1, lifecycle) the way node.doctor is.
- **SonarQube** overlaps most on the "quality gate + score" idea, but it is a
  server product with a broad, language-agnostic remit rather than a zero-config
  CLI tuned for Node runtime failure modes.

node.doctor's distinct position: **Node runtime defects specifically, context- and
version-aware, zero-config, with a score and an agent skill.** No other single
tool occupies exactly that spot.

---

## Architecture

For contributors and the curious. The codebase is small and deliberately layered.

```
node-doctor/
├── bin/
│   └── node-doctor.js          CLI entry: arg parsing, subcommands, exit codes
├── src/
│   ├── index.js                Public API surface
│   ├── core/
│   │   ├── types.js            The Rule contract, categories, defineRule
│   │   ├── walk.js             ESTree walker: parent links, enter/exit, findDescendant
│   │   ├── ast.js              Shared helpers: callee resolution, enclosing fn, taint helpers
│   │   ├── request-path.js     Request-handler detection (the load-bearing primitive)
│   │   ├── taint.js            Intra-file taint from request-shaped roots
│   │   ├── project.js          package.json → capability tokens; rule gating
│   │   ├── scan.js             Orchestrator: parse, run rules, diagnostic identity, delta
│   │   ├── score.js            Local transparent scoring
│   │   └── registry.js         The rule list (hand-written; codegen-shaped)
│   ├── rules/
│   │   ├── async/              forEach-async, unbounded Promise.all, fetch timeout
│   │   ├── express/            async handler, missing return, CORS credentials
│   │   ├── event-loop/         sync IO, process.exit on request path
│   │   ├── security/           exec, SQL, secrets, timing, JWT, weak hash, path traversal
│   │   ├── db/                 N+1
│   │   └── reliability/        unbounded module cache
│   └── report/
│       └── terminal.js         Human-readable renderer
├── skill/
│   └── SKILL.md                The agent skill
├── .github/workflows/
│   └── node-doctor.yml         CI with baseline delta
├── tests/
│   └── …                       900+ tests; valid/invalid pairs + regressions
└── fixtures/
    ├── agent-app/              Deliberately bad Express + Prisma app
    └── good-app/               Correct equivalent (false-positive canary)
```

### Data flow

1. **`bin/node-doctor.js`** parses arguments and dispatches to `scanProject`,
   the `rules` catalog, or `delta`.
2. **`scanProject`** (`core/scan.js`) discovers the project (`core/project.js`),
   selects rules by capability, globs source files, and lints each one.
3. **`lintSource`** parses with oxc, runs the taint pass (`core/taint.js`),
   builds a per-rule context, and walks the AST once (`core/walk.js`) dispatching
   to every interested rule visitor.
4. Diagnostics are collected with deterministic ids, sorted stably, and scored
   (`core/score.js`).
5. **`report/terminal.js`** renders, or the JSON is emitted directly.

### Design principles

- **Rules are pure and host-agnostic.** A rule never touches the filesystem and
  never knows which host runs it. This is what keeps an ESLint adapter or an
  oxlint-plugin host cheap to add.
- **Precision over recall, everywhere.** Every heuristic resolves toward silence.
  A false negative costs one missed bug; a false positive costs the whole tool,
  because people uninstall linters that cry wolf.
- **Isolation.** A rule that throws is skipped; it cannot take down the scan.
- **Determinism.** Output is byte-stable across runs — a prerequisite for the CI
  delta and for snapshot tests.

---

## Writing a rule

Adding a rule is a single-file operation. Here is the whole process.

### 1. The contract

Every rule is an object created with `defineRule`:

```js
import { defineRule } from "../../core/types.js";

export const myRule = defineRule({
  id: "my-rule-id",                    // becomes node-doctor/my-rule-id
  title: "Short headline, no period",
  severity: "error",                    // "error" | "warn"
  category: "Security",                 // drives scoring weight
  requires: ["express"],                // optional: all must be present
  disabledWhen: ["express:5"],          // optional: any present disables it
  tags: ["injection"],                  // optional: families for --ignore-tag
  recommendation: "The specific fix, naming the mechanism, in 1–2 sentences.",
  create: (context) => ({
    // Visitors keyed by AST node type; ":exit" for the post-order pass.
    CallExpression: (node) => {
      // … analysis …
      context.report(node, "What is wrong, concretely.");
    },
  }),
});
```

### 2. The context

The object passed to `create` gives a rule everything it needs:

| Field | Description |
| --- | --- |
| `context.report(node, message)` | Record a finding at `node`'s location |
| `context.filePath` | Absolute path of the file being linted |
| `context.sourceText` | The raw source |
| `context.program` | The parsed AST root |
| `context.taintedBindings` | `Set` of caller-controlled binding names |
| `context.hasCapability(token)` | Query a capability token |

### 3. The helpers

`src/core/ast.js` and `src/core/request-path.js` provide the primitives you will
reach for constantly:

- `getCalleeName(node)` → dotted callee string (`res.json`) or `null`
- `getMethodName(node)` → last segment (`json`)
- `isFunctionLike(node)` → is this a function of any kind
- `findEnclosingFunction(node)` → nearest enclosing function
- `isResultDiscarded(node)` → is a call's value thrown away
- `containsOwnAwait(fn)` / `containsTryStatement(fn)`
- `hasInterpolation(templateNode)` → does a template literal interpolate
- `looksCallerControlled(node, tainted)` → the injection-family predicate
- `collectRequestHandlers(program)` → `Set` of handler function nodes
- `findEnclosingRequestHandler(node, handlers)` → am I inside one
- `looksLikeExpressHandler(fn)` → `(req, res)`-signature fallback

### 4. A complete worked example

A rule that flags `res.send()` called with a raw request value (a naive
reflected-XSS smell):

```js
import { defineRule } from "../../core/types.js";
import { getMethodName, looksCallerControlled } from "../../core/ast.js";

export const noRawEcho = defineRule({
  id: "no-raw-request-echo",
  title: "Response body echoes raw request input",
  severity: "warn",
  category: "Security",
  requires: ["express"],
  tags: ["injection"],
  recommendation:
    "Encode or validate caller input before writing it to the response. Echoing raw request values enables reflected XSS when the response is HTML.",
  create: (context) => ({
    CallExpression: (node) => {
      if (node.callee.type !== "MemberExpression") return;
      if (getMethodName(node.callee) !== "send") return;

      const [body] = node.arguments;
      if (!looksCallerControlled(body, context.taintedBindings)) return;

      context.report(body, "res.send() is passed a raw caller-controlled value.");
    },
  }),
});
```

### 5. Register and test

Add it to `src/core/registry.js` (import + push into `RULES`), then add a
valid/invalid pair to `tests/rules.test.js`:

```js
describe("no-raw-request-echo", () => {
  test("fires on echoed request input", () => {
    expectFires("no-raw-request-echo",
      `app.get("/x", (req, res) => { res.send(req.query.q); });`);
  });
  test("silent on a static body", () => {
    expectSilent("no-raw-request-echo",
      `app.get("/x", (req, res) => { res.send("ok"); });`);
  });
});
```

### The one hard rule of rule-writing

**Write the `valid` test first and make sure the rule stays silent on correct
code.** A rule that fires on good code gets the entire tool uninstalled. Every
rule in node.doctor ships with a passing "does not fire" case for exactly this
reason, and the `fixtures/good-app` canary exists to catch the false positives no
unit test anticipated.

---

## Performance and scaling

node.doctor parses with a Rust-backed parser and walks each file once, which is
fast per file. On top of that:

- **Bounded-concurrency file scanning** (`--no-parallel` to disable), with a
  deterministic fan-in so output does not depend on completion order.
- A **content-hash cache** (`--cache`), so an unchanged file is not re-analyzed
  between runs — the biggest win for local iteration and for CI with a warm cache.
- A **time budget** (`--max-duration`), which truncates deterministically in
  sorted file order and marks the report `complete: false` rather than reporting
  a partial scan as clean.
- The project pass computes its whole-project collections **once per graph**, not
  once per file. That distinction is worth 17× on a 427-file package; getting it
  wrong made a 4,000-file monorepo effectively unscannable.
- Cross-package reachability is scoped to the **transitive importers** of each
  member, so workspace cost stays linear in tree size rather than growing with
  member count.

Reference point: a 4,101-file, 11-project monorepo scans in roughly 22 seconds.

---

## Roadmap

Ordered by leverage. Items 1, 4, 5 and 6 of the original v0 roadmap — the
whole-program call graph, config and suppression, the parallel scanner and
content-hash cache, and the fuzz/corpus harness — have shipped; what follows is
what is genuinely left.

### 1. Type-aware rules

The most valuable Node rule — "this promise is floating" — needs the return type.
Without types, node.doctor catches `async function` and misses everything typed
as `Promise<T>`. The same limitation makes "is this a DB client?" a
receiver-name heuristic rather than a fact (the heuristic already cost one false
positive; see `no-query-in-loop`). This needs a TypeScript type source
(`typescript-go` / `oxlint-tsgolint`), is slower, and would be opt-in via a
`--typed` flag.

**Estimate: 2–3 weeks.**

### 2. Ruleset depth

Framework parity is the thinnest area: Hapi, Restify, Sails, Feathers, LoopBack,
Next.js route handlers and Remix loaders/actions are detected but have no
dedicated diagnostics, and the ORM checks are receiver-aware rather than
schema-aware. Streams and backpressure are also underserved.

**Estimate: roughly a day per diagnostic, with tests and an FP sweep.**

### 3. GraphQL and gRPC

Query-depth and cost limits, introspection exposed in production, resolver-level
N+1, and unauthenticated reflection. Both need a schema/IDL reader before the
checks are worth writing.

**Estimate: 2–3 weeks.**

### 4. Deeper data-layer analysis

Migration and schema awareness: a missing index behind a hot query, a destructive
migration with no down path, a column added NOT NULL without a default. This
needs to read migration files and schema definitions rather than call sites.

**Estimate: 3–4 weeks.**

### Explicitly out of scope

Anything that requires **executing** the code: test coverage, heap profiles, CPU
hotspots, cold-start timings, real N+1 counts from query logs. node.doctor is
static, offline, and deterministic; those belong to a profiler or an APM, and
pretending to infer them statically would mean shipping guesses as findings.

### A strategic note on scope

If node.doctor is to be a public tool, going *broad* against an established,
well-resourced competitor is a losing race — rule count is not where a new
entrant wins. The stronger plays are **narrow and deep**: pick one framework or
one domain and be the best tool for it (`adonis-doctor`, `prisma-doctor`), or
target the genuinely under-served lane of **MCP server and agent-tool security**,
where the whole ecosystem is Node/TS, the code is overwhelmingly agent-written,
and no incumbent has meaningful coverage. The other high-value direction is
*internal*: encode a specific team's conventions as ~25 rules — nobody else can
build that, and the baseline delta makes it adoptable on legacy code immediately.

---

## FAQ

**Is this a replacement for ESLint?**
No. Keep ESLint for style and general correctness. node.doctor is a focused
complement for Node runtime defects that are hard to express as generic lint
rules.

**Does it modify my code?**
No. node.doctor is a detector, not a fixer. It reports findings and recommends
fixes; you (or your agent) make the edits. This is deliberate — an auto-fixer for
security and concurrency bugs would need to be far more certain than a
heuristic-based tool can be.

**Does it send my code anywhere?**
No. Everything, including the score, runs locally. There is no telemetry and no
network call in a scan.

**Why did it flag correct code / miss a real bug?**
node.doctor tunes for precision, so it prefers to stay silent when unsure — that
means some real bugs are missed (especially cross-file ones; see the roadmap). If
it flagged something correct, that is a bug in the rule; please report it with a
minimal reproduction. If it missed something, that is expected coverage growth.

**Does it work with TypeScript?**
Yes, structurally — it parses `.ts`/`.mts`/`.cts`. The current ruleset does not
require type information. Type-*aware* rules are on the roadmap.

**Why a custom score instead of just a pass/fail?**
The score gives a single, trackable health number and a fair way to compare a
large codebase against a small one (via density). Pass/fail is available too —
that is what `--blocking` and exit codes are for.

**Can I run it on just my changed files?**
Yes, via the API's `only` option, and in CI via the `delta` subcommand, which
reports only PR-introduced findings.

**How do I turn off a diagnostic I disagree with?**
`node-doctor diagnostics disable <id>` edits your config in place; or set it in
`node-doctor.config.json`, scope it to paths with `overrides`, disable a whole
family with `--ignore-tag`, or suppress one site inline with
`// node-doctor-disable-next-line <id> -- reason`. The reason is required.

**Is the catalog big enough to be useful?**
It covers a real class of high-severity bugs across Security, Reliability, Bugs,
Performance and Maintainability, including cross-file and cross-package paths that
single-file linters cannot see. Breadth still grows — framework parity and
type-aware rules are the thinnest areas, and both are on the roadmap. Run
`node-doctor diagnostics` for the current catalog rather than trusting a number
written in a document.

---

