# Implementation plan — §159–§184 (Horizon)

How to build the Horizon catalog to the same bar as §1–§158: deterministic,
offline, precision-first, **a false positive is a release blocker**.

---

## What the infrastructure audit changed

Before sequencing anything, I checked what already exists. Three capabilities the
Horizon doc treats as missing are **already shipped**, which moves several
sections from "Vision" to "next sprint":

| Capability | Where it already lives | Unlocks |
|---|---|---|
| `git log -p` walking + per-(commit, file) diff parsing | `src/core/git-history-secrets.ts` | §159, §160, §163, §184 |
| **Comments preserved by the parser** (`{type, value, start, end}`) | `src/core/parse.ts` | §178 |
| TypeScript type source (opt-in `--typed`) | `src/core/type-source.ts` | §179, §175 |
| **Stable finding identity** (`evidenceKey`) + a committed state file that already records accepted/resolved findings | `src/core/ratchet.ts` (`RATCHET_SCHEMA_VERSION`) | **§161** |

That last row is the important one. §161 (Fix-Regression / "boomerang bugs") is
listed as *Vision · needs infra*, but the ratchet **already** persists
position-independent finding identities and already computes `resolved` when an
accepted entry disappears. Detecting a *reappearance* is a backward-compatible
field on a file that exists, not a new persistence layer.

**Revised buildability:** 13 of 26 sections are reachable with today's engine.
The rest genuinely need sustained history (multiple runs over weeks) or an AI
layer, and stay Vision — honestly.

---

## Sequencing principle

Ordered by **(provability × value) ÷ risk**, not by section number. Syntactic
rules first (they cannot produce the statistical false positives that cost us
100+ findings across this project's adversarial hunts); inferential rules last,
after the cheap wins have built out shared helpers.

Every wave ends with the same gate that has governed every wave so far:

```
adversarial FP hunt → reconcile → regression tests → full suite
→ self-scan 100/100 → canary 100/100 → drift guards → determinism → docs
```

---

## Wave 1 — Test-suite analysis  ⚙️ zero new infrastructure

**§173 Assertion-Free & Vacuous Test Detection** · **§174 Flaky-Test Patterns** ·
**§176 Over-Mocking & Tautology**

The engine already parses every file, tests included. These are pure AST shape
checks with no cross-file reasoning — the same profile as the cron-expression
parser, which survived its hunt with zero grammar false positives.

**Build:** a shared `src/core/test-file.ts` — identify test files (path
convention + `describe`/`it`/`test` import or global), locate test bodies, and
classify assertion calls (`expect`, `assert`, `should`, `t.*`, `chai`). All three
rules consume it.

**Precision design (learned from this session's hunts):**
- Gate on *proven* test context: the file must import a known runner **or** match
  a test path convention **and** contain `describe`/`it`. Never fire on a
  non-test file that happens to define a function called `test`.
- §173 fires only when a test body contains **zero** assertion calls of any known
  form *and* no `await expect(...)`-style rejection helper *and* no custom
  assertion helper imported from the project (that last one is the FP trap: many
  suites wrap assertions — if the body calls a project-local function whose own
  body asserts, stay silent).
- §174 flags only mechanically-provable non-determinism: a literal
  `setTimeout(…, <number>)` used as a sleep, a bare `Date.now()`/`new Date()`
  compared against a literal, `Math.random()` in a fixture. Ordering assumptions
  and shared-state coupling need dataflow → defer to Wave 7.
- §176 needs a ratio (mocked surface vs. real surface). **Ship it opt-in and
  advisory**, never error severity — it is the one Wave-1 rule with a judgment
  call in it.

**Risk:** low. **Value:** high — directly undercuts the false comfort of a
coverage number.

---

## Wave 2 — Symmetry & reachability  ⚙️ pure AST

**§165 Missing-Symmetry Detection** · **§166 Unreachable-Guarantee Detection**

**Build:** §165 generalizes the existing leak family (`no-uncleared-module-interval`,
`no-listener-added-per-request`) into a table-driven paired-verb checker:
`acquire/release`, `open/close`, `lock/unlock`, `subscribe/unsubscribe`,
`startSpan/end`, `connect/disconnect`.

**Precision design:** only fire when the acquiring call's result is bound to a
**local** name whose scope ends without the paired call on *every* path, and the
binding never escapes (returned, stored, passed). That escape check is exactly
the one that made `no-unhandled-pipe-error` clean — reuse it. A `try/finally`
containing the release is silence. An unresolvable pair is silence.

§166 extends the existing `no-unreachable-code` machinery to protective
constructs specifically.

**Risk:** low-medium (escape analysis is the crux). **Value:** medium-high.

---

## Wave 3 — Git-history intelligence  ⚙️ machinery exists

**§159 Suspicious-Change-Shape** · **§160 Churn-Weighted Risk** ·
**§163 Blast-Radius Review Routing**

**Build:** promote the diff parser inside `git-history-secrets.ts` into a shared
`src/core/git-history.ts` (commits, per-file churn, blame-lite, hunks). Then:

- §159: a **table of hunk shapes** (auth-file one-liner, regex anchor deleted,
  `===` → `includes` on a permission check, dependency un-pinned, migration mixed
  with feature work). Each entry must be a syntactic diff match — no heuristics.
- §160: churn as a **weight on existing findings**, not a new finding. It changes
  ranking, never adds a claim, so it cannot produce a false positive at all.
  Ship first within this wave.
- §163: joins `computeImpact` (§120) + `ownership` (§89) — both shipped. Pure
  graph query.

**Precision design:** §159 reports **review priority**, never "bug." Different
severity vocabulary — this is the one place where a "maybe" is legitimate output,
provided it is labelled as attention-routing rather than a defect.

**Risk:** low for §160/§163, medium for §159 (shape table needs the same
adversarial hunt as any rule). **Value:** high — it makes the tool useful *during*
review, which is the moment people actually engage.

---

## Wave 4 — Fix-regression  ⚙️ small ratchet extension, highest trust payoff

**§161 Fix-Regression Detection (Boomerang Bugs)**

**Build:** bump `RATCHET_SCHEMA_VERSION` to 2 and add:

```ts
resolvedHistory: Array<{ key: string; resolvedAt: string; toolVersion: string }>
```

When `compareRatchet` sees a finding whose `evidenceKey` appears in
`resolvedHistory`, report: *"this was fixed on <date> and has returned."*

**Why now and not "Vision":** the identity (`evidenceKey`), the persistence file,
and the resolved-detection all exist. This is roughly a day of work for the single
most trust-building signal an analyzer can emit — and it is the reason to build
persistence at all, which every Wave-6 trend feature then inherits.

**Precision design:** `evidenceKey` is position-independent by construction, so a
line-number shift does not resurrect a finding. Schema migration must be
backward-compatible (a v1 ratchet loads with an empty history, never errors).

**Risk:** low. **Value:** very high. **Do this wave early — possibly before Wave 3.**

---

## Wave 5 — Cross-artifact consistency  🔧 infra exists, semantics are the work

**§178 Comment-Code Contradiction** · **§181 i18n Integrity** ·
**§179 Type-Runtime Divergence** *(requires `--typed`)*

**Build:** the parser already hands us comments with offsets — associate each
leading comment block with the node that follows it, then check only the
**machine-verifiable** subset:

- JSDoc `@param` names/count vs. the actual signature *(provable)*
- `@returns {null}` vs. a function whose every path throws *(provable)*
- `@deprecated` on a symbol still imported in-project *(provable via the import graph)*
- A magic-number comment (`// 30 second timeout`) adjacent to a numeric literal
  that contradicts it *(provable — parse the number out of the comment)*

**Explicitly out of scope:** any comment whose claim requires natural-language
understanding. That is an AI-layer feature, and the invariant says the
deterministic core does not guess.

§181 cross-references code against locale JSON — same shape as the existing
config/text-scan work.

**Risk:** medium — comment association is fiddly (trailing vs. leading, block vs.
line). **Value:** high, and squarely on-thesis: stale comments are exactly what a
coding agent reads and believes.

---

## Wave 6 — Composite operational scores  ⚙️ rolls up shipped signals

**§182 Operational-Readiness Score** · **§183 Debuggability Analysis**

§182 is almost entirely **aggregation** of things already computed: graceful
shutdown (§11 rules), health/readiness (§138), correlation IDs + logging (§151,
shipped as `observability`), outbound timeouts (§136, shipped), resource limits
(§25, shipped). New code is the scoring model and the report — not new detection.

§183 extends the error-taxonomy work: `catch (e) { throw new Error("...") }`
discarding `cause`, a swallowed rejection with no log, a generic message with no
context. All syntactic.

**Risk:** low. **Value:** high — "can this ship to production" is the question an
SRE actually asks, and no competitor answers it from evidence.

---

## Wave 7 — The hard one  🔧 needs real design work

**§164 Peer-Consistency Anomaly Detection**

The most valuable idea in the Horizon doc **and the most dangerous.** "19 of 20
siblings do X, one doesn't" is a *statistical* claim, and every statistical claim
in this project's history is exactly where false positives came from — the
`.validate()` name-match, the socket look-alike gate, the `Model.method()`
receiver guess. Shipping this badly would make it the noisiest rule in the
catalog rather than the smartest.

**Precision design — the whole feature is this:**
1. **Peer group must be provable, not fuzzy.** Same directory, same registration
   shape (all route handlers on the same router; all methods of one class), same
   arity/role. If the group cannot be established structurally, emit nothing.
2. **Minimum group size ≥ 5** and **conformity ≥ 90%**. One outlier among four is
   noise; one among twenty is a signal.
3. **The pattern must be a single, nameable, syntactic fact** — "calls
   `asyncHandler`", "passes `tenantId` in the where clause". Never a vector of
   soft features.
4. **Report as `info` first.** Ship it opt-in, advisory, for at least one release
   before considering warn severity.
5. **Adversarial hunt at 2× the usual fleet size**, with a category dedicated to
   legitimate outliers (the one handler that genuinely should differ — a health
   check among authed routes, a webhook among session routes).

**Risk: high.** **Value: very high** — it derives rules from the codebase, which
is the only way to reach the classes held back on precision (§114 multi-tenancy,
§117 idempotency).

**Recommendation:** build it last, after Waves 1–6 have hardened the shared
clustering helpers, and be genuinely willing to *not ship it* if the hunt says the
peer-grouping is not provable.

---

## Deferred — honestly blocked

| Section | Blocker |
|---|---|
| §162 commit-coupling | Needs deep history mining + a co-change statistical model |
| §167 absent-boundary | Needs sound interprocedural taint (§56 is partial) |
| §168 convention-absence | Project-level absence needs a conventions corpus |
| §169–§172 trend analysis | Need **sustained** history — many runs over weeks. Unblocked *after* Wave 4 builds persistence, but the data has to accumulate |
| §175 test-reality drift | Needs the type source **and** mock-shape modelling |
| §177 negative-path coverage | Needs branch-level coverage correlation |
| §180 config semantic drift | Unit inference ("is this seconds or ms?") is not provable syntactically |
| §184 bus-factor | Needs sustained authorship history |

§169–§172 become buildable roughly one release cycle after Wave 4 ships, once
real ratchet history exists in real repos.

---

## Recommended order

```
Wave 4  §161 fix-regression          ← smallest change, biggest trust payoff
Wave 1  §173/§174/§176 test analysis ← zero infra, syntactic, FP-safe
Wave 3  §160 churn weighting         ← ranking-only, cannot false-positive
        §163 review routing          ← pure graph query on shipped pieces
Wave 6  §183 debuggability           ← syntactic
        §182 operational readiness   ← aggregation of shipped signals
Wave 2  §165/§166 symmetry           ← escape analysis, medium risk
Wave 3  §159 change-shape            ← needs its own hunt
Wave 5  §178/§181/§179 cross-artifact
Wave 7  §164 peer-consistency        ← hardest, highest ceiling, ship advisory
```

Each wave is independently shippable and independently valuable. Nothing here
requires a rewrite; every wave extends machinery that already exists and is
already tested.

---

## Per-wave definition of done

1. Rule/command implemented with the precision model documented **in the source**
   (this catalog's convention — the "why silent" cases are the spec).
2. Test suite: fires + silent cases, including every FP class the hunt surfaces.
3. **Adversarial FP hunt** — independent agents probing for wrong claims, each
   finding independently reproduced against current code before it is accepted.
4. Full gate: suite green · self-scan 100/100 · canary 100/100 · determinism
   byte-identical · registry/schema/web drift guards current · dist builds.
5. Docs: `FEATURE.md` status → Detected/Core with the precision model stated,
   `README.md`, `CHANGELOG.md`.
6. `npm version minor && git push --follow-tags` — the release pipeline gates it.

---

## The one rule that governs all of it

Same as the previous 158 sections: **if the hunt says a rule cannot be made
precise, do not ship it.** §164 and §159 are the two most likely to fail that
test. Shipping either one noisy would cost more trust than both would earn — a
linter people disable is worth nothing, and this tool's entire differentiation is
that its findings are true.
