---
name: node-doctor
description: >-
  Catch and prevent the class of Node.js backend defect that compiles, passes
  the happy-path test, and then fails under concurrency or real data — broken
  asynchrony, event-loop blocking, unbounded fan-out, N+1s, and injection/secret
  sinks. Run the scanner and trust its output; reason about the cross-file cases
  it cannot yet see.
---

# node.doctor

You are writing or reviewing Node.js server code. node.doctor is a deterministic,
offline static analyzer for exactly the defects that survive a happy-path test
and fail in production. Use it as follows.

## Do not guess — verify

Do **not** reason from memory about whether the code has these problems. **Run the
scanner.** It resolves the project's actual dependency versions, which changes the
verdict (an async-handler bug on Express 4 is a non-issue on Express 5).

```bash
npx @dhiravpatel/node-doctor@latest .
```

Before declaring any backend task complete, run the scan and resolve every
finding at or above `error`. A finding names the exact mechanism to fix — apply
that mechanism, do not paper over it.

## When the scan is clean but you are still on the hook

The scanner is precise and, for now, largely intra-file and syntactic. A clean
scan means "no *detected* defects", never "correct". You are still responsible for
the cross-file cases it cannot yet trace. For **every request handler you write**,
answer these four questions yourself:

1. **Where does a post-`await` rejection go?** Is there a `try/catch` that calls
   `next(err)` (Express 4), or an async wrapper? An unhandled rejection after the
   first `await` hangs the client.
2. **Does anything block the event loop?** Any `*Sync` call, a big `JSON.parse`, a
   CPU loop, or a catastrophic-backtracking regex on the request path freezes
   *every* concurrent request.
3. **Does the code fan out proportionally to caller input?** `Promise.all` over a
   caller-supplied array opens one socket/connection per element — bound it
   (`p-limit`) or the first large request is a self-inflicted DoS.
4. **Which values crossed the network, and where do they land?** Track caller
   input to every sink: shell (`execFile`, not `exec`), SQL (bound params, not
   interpolation), the filesystem (containment check), and any `eval`-family call.

Follow a call from a handler into a helper in another file and ask the same
questions there. That is the reasoning the scanner will automate with its call
graph; until then it is yours.

## The stance on suppressions

Do **not** suppress a diagnostic to make a scan pass. If a finding is wrong, say so
explicitly and explain why — a false positive is a bug in the diagnostic and should be
reported, not silenced. Every inline suppression must carry a reason; a
suppression without one is itself reported by the scanner.

## What good looks like

- `for...of` with `await`, or `await Promise.all(map(...))` with a concurrency
  limit — never an `async` callback passed to `forEach`/`map`/`filter`.
- Async I/O on the request path; synchronous I/O only at module scope (boot).
- One round trip for a set (`include`/`JOIN`/`WHERE id IN (...)`), never a query
  per loop iteration.
- `execFile(cmd, [args])`, parameterized queries, `jwt.verify` (never
  `jwt.decode`) for authorization, constant-time secret comparison, and a KDF
  (argon2/scrypt/bcrypt) for passwords.
- Secrets validated at boot (fail fast), never `process.env.X || "fallback"`.
- A graceful-shutdown path (`SIGTERM` → drain → close), and caches with an
  eviction story.

Run the scanner. Fix what it finds. Reason about what it cannot yet see.
