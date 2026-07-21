---
name: improve-node
description: >-
  Audit a Node.js backend with node.doctor and turn its findings into a
  leverage-ranked, verified remediation plan — WITHOUT modifying source. Use this
  when asked to review, harden, or plan improvements for a Node service rather
  than to make changes directly.
---

# Improve Node — audit-then-plan advisor

You are auditing a Node.js backend. Your job is to produce a **plan**, not to edit
code. node.doctor gives you a deterministic, offline list of real defects; you
verify each one and turn the list into a ranked, actionable plan.

## 1. Run the scanner and capture the report

```bash
npx node-doctor@latest . --json --json-out .node-doctor/report.json
```

Every finding names an exact file, line, diagnostic id, and fix. The health score
is a local 0–100 number — record the starting score.

## 2. Verify each finding at its location — do not trust blindly

For every finding, open the file at `file:line` and confirm it is real in this
codebase. A clean scan means "no detected defect", never "correct":

- Is the flagged call actually on a request path / reachable from a handler?
- Does the caller-controlled data really reach the sink?
- Is there already mitigation the diagnostic can't see?

If a finding is a false positive, note *why* — that is a bug to report
(`node-doctor explain <id>`), not something to silence.

## 3. Rank by leverage

Order the verified findings by blast radius, not by count:

1. **Security sinks** (injection, secrets, auth bypass, deserialization) — an
   attacker-reachable one outranks everything.
2. **Availability** (event-loop blocking, unbounded fan-out, missing timeouts) —
   fails the whole process under load.
3. **Correctness** (missing error paths, N+1s, wrong results).
4. **Maintainability** — last.

Group findings that share a root cause; fixing the cause clears them together.

## 4. Write the plan — never touch source

Write a plan to `plans/node-doctor-<date>.md` (create the dir). For each item:

- **What & where** — the diagnostic, file:line, and the concrete risk in plain
  language ("this SQL injection lets any user read the whole users table").
- **Root-cause fix** — the mechanism from the finding's recommendation, not a
  suppression.
- **Effort & risk** of the fix.
- **Verification** — re-run `npx node-doctor@latest .` and confirm the score rose
  and the finding is gone.

Do **not** modify application code in this mode. Deliver the ranked plan and let a
human (or `node-doctor fix`) apply it.
