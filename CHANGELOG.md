# Changelog

All notable changes to node.doctor are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
semantic versioning. The JSON report's `schemaVersion` is bumped on any breaking
change to that shape.

## [Unreleased]

CLI, terminal UX, configuration, and the diagnostic set are substantially
expanded — closing the remaining parity gaps with react-doctor's tooling surface
while staying offline-first and deterministic.

### A sort comparator that provably cannot order the array

New diagnostic `no-broken-sort-comparator` (Bugs / `error` / confidence `high`).
`sort` needs three answers — negative for "a first", positive for "b first", zero
for equal — and a boolean supplies only two, because `ToNumber(true)` is `1` and
`ToNumber(false)` is `0`. Measured on `[5, 3, 9, 1, 7, 2, 8]`, running every form:

```
sort((a, b) => a > b)            → [5,3,9,1,7,2,8]   unchanged
sort((a, b) => a < b)            → [5,3,9,1,7,2,8]   unchanged
sort((a, b) => a >= b)           → [5,3,9,1,7,2,8]   unchanged
sort((a, b) => a === b)          → [5,3,9,1,7,2,8]   unchanged
sort((a, b) => a > b ? 1 : 0)    → [5,3,9,1,7,2,8]   unchanged
sort((a, b) => a.p - a.q)        → [2,1,3]           garbage
sort((a, b) => a > b ? 1 : -1)   → [1,2,3,5,7,8,9]   correct
sort((a, b) => a - b)            → [1,2,3,5,7,8,9]   correct
```

Nothing throws. The array comes back with the right length and the right
elements, and usually in *nearly* the right order — the rows came out of a query
that already had an `ORDER BY`, so the symptom is a few items misplaced on one
page rather than an obvious scramble. A test that checks `length`, or membership,
or sorts an already-ordered fixture, passes. TypeScript catches it in a typed file
and misses it wherever `any`, plain JS, or an untyped callback is involved.

Two independent proofs, both from syntax alone. **Clause 1 — every value the
comparator can return is provably non-negative:** a relational or equality
comparison, `!x`, a non-negative numeric literal, `true`/`false`, a `&&`/`||`/`??`
of those, or a conditional whose *both* branches qualify. `a > b ? 1 : 0` is the
defect; `a > b ? 1 : -1` is not. **Clause 2 — the body never reads one of the two
elements:** `rows.sort((a, b) => a.revenue - a.cost)` is scoring one element
against itself. References are matched by **binding**, not name.

Uncertainty resolves to silence throughout: a subtraction, a `localeCompare`, any
call, an identifier or a unary minus is not provably non-negative, which also
makes the `Math.random() - 0.5` shuffle idiom silent by construction. Zero-parameter
comparators, rest parameters, and any body touching `arguments` are excluded —
each reads the elements without going through the named parameters.

Validated by running the rule over every readable `.sort(`/`.toSorted(` call on
the machine — **166 files** including the TypeScript compiler, esbuild, rollup and
the Vite bundle. That sweep produced exactly one clause-2 hit: vite's lockfile
ordering, `.sort((_, { manager }) => …startsWith(manager) ? 1 : -1)`. It is
genuinely non-antisymmetric and therefore implementation-defined, but its author
wrote `_` to mean "ignored on purpose", and a rule that argues with an explicit
`_` is a rule people switch off — so a parameter named `_`/`_x` is now taken at
its word. Final sweep: **0 findings in 166 files, 0 parse failures.**

One recall gap is documented and pinned by a test rather than left to be
discovered: the scope resolver models module/function/`catch` scopes but not
nested blocks, so a `{ const b = … }` shadowing a parameter — the only legal way
to write that shadow, since a top-level `const b` beside a parameter `b` is a
SyntaxError — reads as the parameter and stays quiet. It under-reports rather than
reporting correct code.

> Same corpus caveat as the wave below: filesystem access outside the project
> directory still returns `Operation not permitted`, so population could not be
> measured across the ~29.6k-file local corpus. This rule was selected on the §201
> criterion — the claim has to be an always-wrong fact about the language — and
> its precision is established by executing every firing and silencing shape and
> by the 166-file false-positive sweep, not by corpus sampling.

### A `toFixed` result used as a number, so `+` concatenates

New diagnostic `no-tofixed-as-number` (Bugs / `error` / confidence `high`).
`Number.prototype.toFixed` returns a **string** — that is its entire purpose, and
it is the half everyone forgets. Verified by running each form:

```
(100).toFixed(2) + (18).toFixed(2)          → "100.0018.00"
(1.5).toFixed(2) + 5                        → "1.505"
let sum = 0; sum += (1.5).toFixed(2)        → "01.50"
(1.5).toFixed(2) + (2 * 3)                  → "1.506"
[1,2].reduce((a,b) => a + b.toFixed(2), 0)  → "01.002.00"
(1234.5).toLocaleString() + 1               → "1,234.51"
(100).toFixed(2) === 100                    → false, always
```

Nothing throws. MySQL will coerce `"100.0018.00"` into a DECIMAL column on the way
in, so the corruption surfaces later as a total that does not add up rather than
as an error anyone can trace. The leading zero from a `sum` seeded at `0` is the
tell.

The claim at every firing shape is a fact about the language rather than an
inference about the data: this operand is a string, the other is **provably** a
number, and `+` on that pair concatenates. Two clauses only — a `+`/`+=` whose
other operand is provably numeric (a numeric literal, an arithmetic expression, a
`Number`/`parseInt`/`parseFloat` call, a unary `+`/`-`, a binding initialized to a
numeric literal, or a `reduce` accumulator with a numeric seed), and `===`/`!==`
against a numeric literal. Two formatted operands also count, since digits jammed
together with no separator are meaningless as display.

`==`/`!=` and the relational operators are **excluded** because they coerce and
therefore work — verified: `(100).toFixed(2) == 100` is `true` and
`(100).toFixed(2) > 99` is `true`, so reporting either would be reporting correct
code. Silent on display formatting (a string literal or template operand; template
interpolation is not a `+` at all), on the standard unwraps (`Number(...)`,
`parseFloat`, `parseInt`, unary `+` — verified to give `6.5` where the raw form
gives `"1.505"`), and on any operand merely *unknown* — a bare identifier, a
member read, an arbitrary call — because it could be a string label, and then the
concatenation is correct. Uncertainty resolves to silence, never to a report.
`toString()` is deliberately not treated as a formatter: its name says what it
returns, so concatenating it is plausibly deliberate.

One hop of indirection is followed — `const t = tax.toFixed(2); … subtotal.toFixed(2) + t`
— because that is how the shape is actually written. The hop is keyed by
**binding**, not name, and requires `const`: a `let` reassigned elsewhere is not
provably a string at the use site.

Measured against every readable file in the repo tree (36 files use
`toFixed`/`toPrecision`/`toLocaleString`, including the TypeScript compiler and
the build toolchain): **0 findings, 0 parse failures**. The only real
concatenations there are `` `${(x * 100).toFixed(1)}` `` and `.toFixed(2) + "%"`,
both correctly silent.

> **Corpus caveat for this wave.** The usual population measurement across the
> ~29.6k-file local corpus could not be run: filesystem access outside the
> project directory now returns `Operation not permitted`, so only the repo's own
> tree was readable. This rule was therefore selected on the criterion the §201
> wave used — *the claim has to be an always-wrong fact about the language, not
> an inference about the data* — and its precision is established by executing
> every firing and silencing shape rather than by corpus sampling. An earlier
> probe in the same session measured `.toFixed(` at **3,733 occurrences across
> 475 corpus files**, so the surrounding population is large, but the share
> matching these two clauses is unverified.

### A month added by `setMonth` skips a month for end-of-month dates

New diagnostic `no-unclamped-month-shift` (Bugs / `warn` / confidence `high`).
`setMonth` writes the month field and leaves the day where it was, so a day the
target month does not have spills into the month **after** the intended one.
Measured by running each case rather than argued:

```
new Date(2024, 0, 31).setMonth(m + 1)   → Sat Mar 02 2024   (February skipped)
new Date(2024, 2, 31).setMonth(m - 1)   → Sat Mar 02 2024   (moves FORWARD)
new Date(2024, 4, 31).setMonth(m + 1)   → Mon Jul 01 2024   (June has 30 days)
```

Note the second line: subtracting a month from March 31 lands two days *later*
than it started. There is no direction in which the idiom is safe, and it is not
only a February problem.

**32 production sites across 8 corpus codebases**, and the true positives are
dates written to a database that then govern money — a service-period end and a
credit expiry (five sites in one service), a subscription expiry returned as
`toISOString().split("T")[0]`, and the next charge date of a MONTHLY autopay
mandate, so a mandate taken out on the 31st charges on the 2nd. Nothing throws,
the value is a well-formed date, and it is correct for 27 days of every month.

The rule ships because the same corpus contains **two hand-written correct
implementations of the fix**, in production code by the same organization, and
both stay silent: one normalizes the day to 1 before the shift and clamps back
with `setDate(Math.min(day, lastDayOfMonth))`, the other shifts first and repairs
after with `if (date.getDate() !== d) date.setDate(0)` (verified: Jan 31 plus a
month, then `setDate(0)`, is Feb 29). A literal day of 1–28 written *before* the
shift or any day write *after* it therefore silences the call, as do the
two-argument `setMonth(m, 1)` form, a provable day from `new Date(y, m, <1–28>)`
or from the literal text of `new Date("2026-03-01")` /
`` new Date(`${month}-01`) ``, and one hop of copy propagation for the
`monthStart.setDate(1); const monthEnd = new Date(monthStart)` idiom. Clamp
checks are keyed by **binding identity**, not name, so a normalized `d` in one
function cannot silence an unguarded `d` in another.

`setFullYear` has the identical defect on Feb 29 and the identical fix. It was
implemented, measured, and **cut**: 23 production sites, 16 of them year-over-year
reporting windows in a single controller where a one-day drift once every four
years governs nothing, against 5 that mattered — and three of those five sit
within four lines of a month site the rule already reports. The month case
triggers on three days of most months, the year case on one day in 1,461. A test
pins the exclusion so it is not re-added without re-measuring.

Complements `no-local-date-as-iso-datestring`, which deliberately removed its own
`setMonth`/`setFullYear` branch: that rule is about rendering a local-midnight
instant in UTC, this one is about the shift itself being wrong in any zone.

Measured and rejected on the way to it, each at zero or near-zero corpus
population: `findOneAndUpdate` without `new: true` (233 calls, 182 with the
result used, **0** missing a return-shape key), a Mongoose extension of
`no-untransacted-dependent-writes` (14 candidate first writes, **0** dependent
pairs), an unfiltered `deleteMany({})` (6 sites, 5 in tests and 1 in a migration
script), a moment-mutation aliasing rule (**0** occurrences of the aliasing shape
in 125 moment-importing files), and a cleartext-`http://`-request rule (1,115
files mention `http://`; the outbound-call sites are all `localhost`, `127.0.0.1`
or example hosts).

### Taint is now keyed by BINDING, not by name

The intra-file taint set was a file-global `Set<string>` of NAMES, and
`looksCallerControlled` asked only "does this expression mention such a name?".
One tainted binding therefore contaminated every same-named binding in the file.
Measured on a 28k-line controller: **908 of its 2,232 distinct identifiers (41%)
were tainted**, including bare `user`, `key`, `row`, `item` and `id`. A small,
well-factored file measured 0% — the pathology scales with file size.

Fifteen rules consume this, thirteen of them security rules, and the defect had
already been worked around three separate times rather than fixed:
`no-nosql-object-injection` (21 of 21 findings false), `no-open-redirect` (5
error-severity false positives, from a `state` local colliding with a `state`
destructured from `request.query` in a *different* handler), and
`no-prototype-pollution`. A fourth work-around would have been the wrong answer.

Taint is now keyed by the `Binding` a name resolves to at the use site, so
`req.query.state` in handler A taints only A's `state`. Names that resolve to no
binding at all keep a name-keyed fallback, because there is nothing better to key
them by. `looksCallerControlled` collapses to `tainted.hasRef(node)` — one
definition of "is this a caller-controlled read?" instead of logic duplicated
across two files.

The old `locallyDeclared` exclusion is replaced by a per-binding request-root
test, which closes both halves of a hole: it was file-global, so one
`const ctx = …` anywhere silenced every genuine `ctx` handler parameter in the
file; and it inspected only `VariableDeclarator`, so a `function f(request)`
signature still seeded the entire file.

**Measured across five corpus backends: 1,315 findings → 1,300.** Twenty-one lost,
six gained, hand-read:

- The three lost path traversals are provably false — one reads `filename`,
  declared a string *literal* on the line above and tainted only by collision with
  a `filename` in another function; another joins nothing but literals.
- The three gained are real, and are the argument for the change on its own:
  `path.join(public_folder, "orders/" + file.name)` on an **uploaded filename**,
  and the same shape on `removed_img` feeding a **delete** — arbitrary file
  deletion, invisible to the old substrate.

Performance improved rather than regressed — 7.8s against 8.3s on the largest
corpus project — because `ScopeResolver.enclosingScope` is now memoized in a
WeakMap. It is asked for every identifier on every fixpoint round, and the parent
chain never changes after `attachParents`, so the cache can only save work.

One companion propagation rule ships with it: `for (const x of req.body.items)`
taints the element binding. It is required, not optional — without it, scope
keying silently drops real findings the old substrate caught only by name
collision.

Three propagation variants were measured and REJECTED, and are pinned as tests so
they are not re-added: `for…in` (adds 75 false `no-prototype-pollution` findings
in one file, because it binds `"0"`, `"1"`, `"2"`); iteration-callback propagation
(recovers 0 lost detections, adds 3 false positives on `new RegExp(escapeRegex(v))`
— the pattern that rule's own docblock lists as the safe one); and call-site
parameter propagation (recovers 2 of 3 lost detections but adds 1 false positive,
and one is a release blocker).

The honest cost is one real detection: a prototype-pollution sink in
`order.save.js` reached through a call-site parameter. It was only ever found by
name collision rather than by analysis, and recovering it properly needs the
argument→parameter rule, which cannot ship until `no-unsafe-regexp-from-input`
stops firing on the escaping it recommends.

### New: `no-static-cipher-iv` — an initialization vector that never changes

An IV exists to make the same plaintext encrypt differently every time. Fix it and
the cipher becomes a deterministic function of the plaintext. Measured on the same
key, the same plaintext, twice:

```
CBC, fixed IV:  2bb3f4f2bd6704d2e52480cca69d3ecf…
                2bb3f4f2bd6704d2e52480cca69d3ecf…   identical
CBC, random IV: different every time
```

That leaks equality — an observer learns which records hold the same value, enough
to de-anonymise a column of statuses or salaries — and because CBC chains block by
block, two messages sharing a prefix share a ciphertext prefix: measured, 32
identical hex characters for `"transfer 100 to alice"` and `"transfer 100 to bob"`.

For GCM and any counter mode it is a break rather than a leak. A repeated nonce
repeats the keystream, so `ct1 XOR ct2` equals `pt1 XOR pt2` exactly — measured,
both sides came out `030303030303030303030303` — and the authentication key can be
recovered from two messages under one nonce.

Found at three corpus sites, all the same helper copied across a monorepo's
variants: a `static encrypt()` holding a hardcoded key AND a hardcoded
16-character IV, so every value the application ever encrypts uses the same pair.
**node.doctor reported nothing on that file before this rule** — `no-weak-cipher`
judges the algorithm, and `aes-256-cbc` is a fine algorithm.

The IV must be provably constant: a literal, `Buffer.from(<literal>)`,
`Buffer.alloc(n)`, or a `const` bound to one of those. A parameter, a call result
or a property read is undecidable and stays silent, as does a `let` that may be
reassigned. `crypto.randomBytes` is never reported. Only ENCRYPTION is judged —
`createDecipheriv` must be given the very IV the ciphertext was produced with, so
a literal there is a consequence of the defect rather than the defect. A `null` IV
is ECB, which is `no-weak-cipher`'s subject.

**A correction to an earlier measurement.** I previously reported this family as
having zero corpus population — "5 `createCipheriv` call sites, 0 with a constant
IV" — and concluded it could not clear the population bar. That probe was wrong:
the real first-party count is roughly 20 call sites, four of which have a literal
IV, across two distinct defects. The rule ships because the population is real.

The second defect needed the rule extended, and it is a shape no amount of binding
resolution reaches — the IV lives on an object literal and is read back through
`this`:

```js
var crypt = {
  iv: "<16 characters>",
  encrypt: function (data, key) {
    var iv = this.iv;                     // ← one hop
    var cipher = crypto.createCipheriv(algo, key, iv);
```

It is as fixed as a literal argument, and worse: every method on the object shares
it. Resolving it means a property lookup on the object literal the method is
defined in. Reaching it also meant accepting non-`const` bindings — the corpus
writes `var iv = this.iv` — so a binding is now followed when it is `const`, or
when nothing in the file ever assigns to it. A `var` that is later reassigned
stays silent.

### Scoped and rejected: `no-spoofable-ip-allowlist`

Proposed as the survivor of two IP-spoofing rules, narrowed to the leftmost
`X-Forwarded-For` entry reaching an allowlist or quota decision, and reported as
"2 findings, 2/2 precision, 0 false positives on 38,820 files".

The vulnerability is real and I verified the mechanism — proxies APPEND to
`X-Forwarded-For`, so `split(",")[0]` is precisely the entry the client sent while
`.pop()` is your own proxy's view:

```
header the app sees:  10.0.0.99, 203.0.113.7, 198.51.100.4
leftmost split(",")[0] -> 10.0.0.99      ← the attacker chose this
rightmost .pop()       -> 198.51.100.4   ← added by your own proxy
```

But the population does not reproduce. Across **25,952 first-party files there is
exactly ONE leftmost-XFF extraction, and it reaches no allowlist or quota
decision** — it is used for a log record, which the proposal itself excluded as a
noise source. Two of the four originally claimed true positives rest on
`X-Real-IP`, which the same review had already ruled undecidable because it would
flag correct Cloudflare code.

So the rule would fire on nothing, which this project treats as a failure in its
own right. Not shipped — the fifth candidate rejected on measured population
rather than on taste.

### `no-prototype-pollution` was built on a false premise

A single-level computed write cannot pollute anything. Run it:

```js
const o = {}; o["__proto__"] = { polluted: 1 };
({}).polluted   // undefined — `o` was merely RE-PARENTED

const b = {}; b["__proto__"]["p2"] = 42;
({}).p2         // 42 — THIS is the vulnerability
```

`obj[key] = value` sets an own property. If the key is `__proto__` the assignment
goes through the setter and changes **that object's** prototype; it adds nothing
to `Object.prototype`, and no other object in the process is affected.

Flagging that shape was essentially the rule's entire output. A hand-audit of all
76 findings in one backend found **1 true positive and 75 false**, while the rule
was more than half of every Security finding in that project. The dominant false
classes were a group-by accumulator keyed on a database row field (45), an array
element written at a `findIndex` result (7), and a key normalised to one of a few
string literals (6) — none of which can pollute anything even if the key were
`__proto__`.

The rule now fires only where the write reaches the prototype:

- **The recursive merge gadget** — a function taking two objects, walking the
  source's keys, and recursing into `(target[k], source[k])`. This is the shape
  behind the lodash.merge / deep-extend / merge-deep CVEs, because the recursion
  supplies the second level a single write lacks. Confirmed by running the
  corpus's own `_deepMergeInto` against `{"__proto__":{"pp_polluted":"yes"}}`.
- **An escalating write** — a caller-controlled computed key with at least one
  further member link after it. Stated as "a link AFTER the computed one" rather
  than "two or more links", because the looser form readmits `a.b[k] = v`, which
  is still single-level and still inert.
- **The walked pointer** — `base[k] = v` where `base` is reassigned from
  `base = base[...]`, the `lodash.set`/`dot-prop`/`set-value` shape. This clause
  exists because an adversarial review proved that narrowing to escalating writes
  alone would silence that entire CVE class.
- **A deliberate literal sink** — only a *computed* `obj["__proto__"] = v`.
  `prototype` is dropped from the dangerous set, since `Foo.prototype = {...}` is
  how pre-class JavaScript defines methods.

Two discriminators were measured rather than guessed. A merge gadget recurses into
computed reads of **both** parameters; `json2.js`'s JSON reviver is recursive,
walks keys and writes computed keys — every surface trait of a merge — but passes
a value and a *key*. Requiring both parameters removed 72 library-internal
findings. And a numeric key can never be the string `__proto__`, which removed the
loop-counter and `findIndex` classes; `+` is deliberately excluded from the
numeric operators, since string concatenation is exactly how a `__proto__` key
gets assembled.

**403 findings across five projects → 33**, with the one real gadget kept.

The residual are escalating writes whose keys come from server-side rows. Closing
those needs scope-keyed taint — the file-global, name-keyed set is what marks them
— and that is a substrate change affecting a dozen rules, so it is deliberately
not bundled here.

Two shipped tests asserted the old, false premise and were corrected rather than
worked around; a third (the ratchet CLI test) was decoupled from this rule
entirely, since it only needed *some* new finding and keying it on one rule's
precision made it fail when that rule was corrected.

**Also: obfuscated bundles are no longer scanned.** The vendored-library gate now
also recognises a file that is both one-lined and bundle-scale — the corpus has an
obfuscated 688,354-byte single-line file with no licence banner and no UMD wrapper,
whose "variables" are `_0x34e2f2`. Both conditions are required: a *small* file with
one long line is not a bundle but something pathological, and this tool's posture is
that "I did not look" must never be reported as "there is nothing", so such a file is
still surfaced as a coverage gap rather than silently dropped.

### Security wave: four false-positive classes closed, one recall gap opened

A six-lens security pass over the corpus, with every survivor adversarially
refuted. The refuters earned their keep — they **rejected** a proposal to teach
`no-open-redirect` about sanitizer functions by showing its regex would have
silenced `res.redirect(unescape(req.query.next))`, the textbook vulnerable form.
Authorization/IDOR was also rejected, on its proposer's own measurement: 18%
precision ungated, and every gate that reached shippable precision collapsed it
to two findings in one handler — overfitting with no held-out data.

**Vendored libraries are no longer analysed.** `node_modules` and `*.min.js` were
already ignored, but a copy of jQuery committed under `webroot/` or `public/js/`
is invisible to both, and a finding inside one is unactionable — the fix is to
upgrade the dependency, not edit the file. One CakePHP app reported **1,871
findings, every single one from vendored copies** (six separate `jquery.js`,
plus `highcharts.src.js`, `datatables_do_not_delete.js`, `fusioncharts.js`) and
none from its own code; it now reports 155, all first-party. The test is on
CONTENT — a license banner or a UMD preamble in the first 4KB — not on the path,
and that is load-bearing: ignoring `webroot/**` would have been simpler and wrong,
because CakePHP's document root also holds the app's own scripts. Verified
against those: none matches, and the gate excludes 0 files in a normal Node repo.

**`require-secure-cookie-flags` fired on cookie READS.** It matched any
`<x>.cookie(name, …)` with an auth-shaped name, catching AdonisJS
`request.cookie("refresh_token")` and client-side `$.cookie(...)`. A read cannot
be missing `httpOnly`. Gated on the receiver being a response object rather than
on argument count — which matters, because `request.cookie(key, default)` is a
legal two-argument read.

**`no-mass-assignment` reported a single destructured field as the whole body.**
`ScopeResolver` attaches the declarator's initializer to every name a pattern
binds, so `const { id } = req.body` records `initNode = req.body` for `id`, and
`User.update(id, {…})` was flagged as passing the body — the recommended fix,
reported as the bug. The binding's own position discriminates it, and `...rest`
still fires: `const { id, ...rest } = req.body` leaves `rest` carrying every
attacker-settable key but one, which IS the defect. Fixed in the rule, not in
`ScopeResolver`, whose 23 other consumers depend on current behaviour.

**`no-nosql-object-injection` branch (b) was 21-for-21 false.** It gated on the
file-global, name-keyed taint set, so every locally-built filter object in a file
that touched the request anywhere was reported. What matters for injection is
provenance of the KEYS — `$ne` reaches the driver only if the caller decided which
keys exist — so the gate is now syntactic, and a PREFIX test: `req.body.filter`
and `req.query.where.inner` count, not just `req.body` exactly. Corpus findings
for this rule went 21 → 0, with the genuinely vulnerable spreads still firing.

**`no-timing-unsafe-secret-compare` was quietest on the code it exists for.**
Requiring BOTH operands to look secret-shaped missed every real webhook HMAC
check, because those compare a header against a computed value:

```js
if (headerData["x-hub-signature-256"] !== `sha256=${computedSignature}`)   // n8n
if (apiKey !== env.get("INTERNAL_API_KEY"))                                // Adonis middleware
if (headersList.get("x-webhook-signature") !== computed_signature)         // cal.com
```

One operand may now be a closed set of counterpart shapes instead — a template
literal wrapping a secret, a header/env/query getter named for one, a
word-bounded `pass` token, or an `expected`/`provided` name. **17 real sites
recovered**, and n8n's nodes-base went from 0 findings to 12. The `pass` token is
three alternations rather than one case-insensitive pattern on purpose:
`/[a-z]Pass/i` would match `bypass`.

In the other direction it now stays silent on password-confirmation pairs — 15
corpus findings where both operands come from the same submitter in one request,
so there is no stored value to recover and no oracle to leak. Both a password word
in BOTH names and structural siblinghood are required, which keeps
`user.passwordHash !== req.body.password` and `confirmationToken !== token`
firing.

### Fixed: `--typed` could never work, so the only type-aware rule never ran

`no-floating-promise` is the sole `requiresTypes` diagnostic, and it reported
nothing on any project, ever. Two independent bugs stood between it and a
finding, and fixing either alone leaves it silent.

**It loaded the wrong compiler.** `createTypeSource`'s default loader was
`(s) => import(s)`, and a bare specifier resolves relative to the importing
module — node.doctor's own tree, never the scanned project's. The doc comment
three lines above already promised the opposite ("the default resolves TypeScript
from the *scanned project*"). node.doctor dev-depends on TypeScript 7, whose
native build ships no `createProgram`, so `--typed` answered *"the resolved
TypeScript (7.0.2) does not expose the JavaScript compiler API"* on every project
— including ones sitting on a perfectly good TypeScript 5.9 of their own.
Resolution is now rooted at the scanned directory via `createRequire`, with the
bare import kept as a fallback so a globally installed node.doctor still works.

**And the node index handed out the wrong node.** `r.save("a");` begins an
`ExpressionStatement`, a `CallExpression`, a `PropertyAccessExpression` and an
`Identifier` at the very same column. The index was first-wins over a pre-order
walk, so the statement claimed the offset — and a statement has no call
signature, so `promiseKindAt` answered `unknown`. Last-wins is not the fix
either: that hands the offset to the `Identifier`, whose type is the receiver
rather than the call's return. The call expression now claims the offset outright
and everything else keeps first-wins.

Verified end to end on a real TypeScript 5.9 project: exactly one finding on the
floating call, with awaited, `void`-ed, `.catch()`-ed, returned and non-promise
calls all correctly silent. The existing stub could never have caught the index
bug — it emits one node per offset — so the regression test now reproduces the
real collision, and was confirmed to fail when the fix is reverted.

### Fixed: `no-open-redirect` flagged fixed-destination URLs at error severity

The rule asked only whether the URL expression was caller-controlled, and never
looked at its SHAPE. A template literal whose first quasi already spells out an
absolute origin and a path —
`` `https://accounts.google.com/o/oauth2/v2/auth?${params}` `` — has a
destination no interpolation can reach; everything dynamic lands in the query or
fragment, and the browser goes to Google either way.

It fired at `error` severity on the OAuth start handler of a real API, where the
interpolated `state` was `crypto.randomBytes(32).toString("hex")` — about as far
from caller data as a value gets. It looked tainted only because taint is
file-global: the *other* exported handler in the same file destructures a `state`
from `request.query`, and the two locals share a name. Shape is decidable where
that provenance is not.

Two shapes now end the claim: an absolute origin followed by at least one path
character, and a site-root-relative path whose second character is not a slash.
The second condition is load-bearing — `` `/${x}` `` still fires, because `x`
could be `/evil.com` and make it protocol-relative.

Measured: **5 false positives removed across two projects, no true positive
lost.** `` `https://${host}/x` `` still fires (the origin is dynamic), and so do
the fully dynamic `` response.redirect(`${redirect_url}`) `` sites in another
backend.

### AdonisJS controllers are request handlers — eight rules were dead on the stack

`collectRequestHandlers` recognized **zero** AdonisJS controller methods, so all
eight request-path-gated rules were silent no-ops on the corpus's dominant backend
stack: `no-sync-io-in-request-path`, `no-sync-bcrypt-in-request-path`,
`no-process-exit-in-request-path`, `no-large-json-parse-in-request-path`,
`no-db-connection-per-request`, `no-listener-added-per-request`,
`no-cross-request-state-mutation`, `no-shared-cache-authenticated-response`.

Adonis registers routes in a *different* file, as a tuple naming a class and a
method by string — `router.post("/x", [AuthController, "encrypt"])`. Nothing in
the controller marks the method, and nothing in the route file contains a
function, so neither handler-argument analysis nor the Express-signature fallback
could reach it. Recognition now keys on the **type annotation** of the first
parameter (`HttpContext`, or Adonis 5's `HttpContextContract`), plus an actual
Adonis import — not on the destructured parameter names, because
`{ request, response }` is a shape plenty of ordinary helpers have. On one real
controller that took recognition from 0 to 107 methods.

**Recognition alone was not shippable, and this is the more important half.** It
surfaced 119 findings in one backend, of which **116 were false positives** in
three classes — every one found by reading the findings rather than trusting the
count:

*`JSON.parse` of a value the request merely influenced (94).* The rule is about
SIZE, so "caller-controlled" in the taint sense is the wrong test:

```js
const row = await locationsCollection.findOne({ location_id: id })
const details = JSON.parse(row.location_details)   // ← was reported
```

Taint reaches `row` legitimately — a request field chose which row — but the bytes
come from the database, and no caller can make a stored column megabytes by
sending a large request. The argument must now BE the request payload, the same
correction `no-mass-assignment` needed when it went from 743 false positives to 0.
Taint through a database round-trip still matters for injection rules (stored XSS
is real), which is why this is fixed in the rule rather than by weakening
`computeTaint` for everyone.

*Listeners on emitters created per request (17 + 5).* The rule excluded
per-request emitters by NAME, so it could not see one that has no telling name:
`fs.createReadStream(p).pipe(csv()).on("data", …)` roots at `fs`, a module, and
`const archive = archiver("zip"); archive.on("error", …)` roots at a local whose
name says nothing about its lifetime. Both build a fresh emitter that dies with
the request. An emitter is now treated as per-request when it is a construction,
or a binding declared inside that handler from a construction; a long-lived
`bus.on(…)` still fires.

Net on the measured backend: **119 → 8 findings, all eight hand-verified** as real
`fs.existsSync`/`mkdirSync`/`unlinkSync` calls blocking the event loop on a
request path — defects that were completely invisible before.

### Fixed: a shipped rule that could never fire, and the invariant that lets it recur

`no-missing-websocket-error-handler` was gated `requires: ["ws"]`, and **nothing
grants a `ws` token** — `DEP_TOKENS` has no entry for it. So the rule could not
fire on any project, on any machine, not even when a user explicitly enabled it:
`capabilitiesSatisfied` is checked before the explicit-config escape hatch. In a
report, a rule that never ran is indistinguishable from a clean result.

It stayed invisible for its entire shipped life because diagnostic tests hand
capabilities straight to `lintSource`, which bypasses gating — the same blind
spot that hid the monorepo Prisma bug. An audit of all 173 diagnostics found this
was the *only* ungrantable gate in the catalog.

The gate is deleted rather than the token added. The rule's own comment says the
capability "does not make THIS file websocket code" — it was never load-bearing,
because the file-level import gate underneath it is strictly stronger. The
sibling opt-in import-gated rule, `no-invalid-cron-expression`, carries no
`requires` at all; the websocket rule was the anomaly. A manifest token would
also have missed `ws` reached through a wrapper package.

**The instance is the smaller half.** `GRANTABLE_CAPABILITIES` is now exported
from `src/core/project.ts`, and a test asserts that every `requires` and
`disabledWhen` token across every shipped diagnostic is actually grantable. The
test was confirmed to have teeth by reintroducing the bug and watching it fail
with the exact offender named. This class cannot ship again.

### Fixed: two false-positive sources that produced 183 of one project's 184 findings

**Generated output was being analysed.** `BUILTIN_IGNORES` covered `.next/**` but
not `out/_next/**` — the `next export` destination — so the same artifact was
skipped under one name and scanned under another. Measured on a Next.js static
export: **183 of 184 findings came from generated bundles**, 167 of them from a
single rule. Also added: `.vite/**` (Vite's pre-bundled dependency cache),
`prisma/generated/**`, `*.bundle.js` and `*.vendor.js`. Every entry is machine
output — nobody can act on a finding in a file they do not write.

**And the reason minified code produced findings at all.** `looksCallerControlled`
and `computeTaint` both searched an expression for any Identifier whose NAME sat
in the file's tainted set — including positions where an Identifier is not a
variable read:

```js
row.user_id            // a property NAME, not the variable `user_id`
{ token: "literal" }   // a KEY, not the variable `token`
```

Since the tainted set is file-global, one tainted binding contaminated every
matching name in the file. In minified bundles, where single letters are rebound
hundreds of times, it manufactured findings wholesale. Both functions now reject
Identifiers in non-computed member-property and object-key position; a computed
`obj[key]` is still a read, and the genuine
`target[req.body.key] = …` defect still fires. Fixing only `looksCallerControlled`
is not enough — taint re-enters through `computeTaint` on the next round and undoes
it, which a test written for the first fix caught.

Net effect on the measured project: **184 findings → 1**, and that one is a real
finding in hand-written source. Security recall is intact: the same corpus backend
still reports 150 security findings.

### Recall: `no-timing-unsafe-secret-compare` missed the abbreviated `sig`

Webhook verification is where this rule matters most, and it is routinely written
with one operand spelled out and one shortened:

```js
if (signature !== expectedSig) return { valid: false };
```

Because BOTH operands must look secret-shaped before the rule fires, the
abbreviation on either side silenced the whole comparison — so the rule was
quietest on exactly the code it exists for. Measured on the corpus, a single
word-boundary-anchored `sig` token recovers **5 real sites**: four
`signature !== expectedSig` webhook checks across one backend, plus cal.com's
Help Scout handler (`hsSignature !== calculatedSig`).

The boundaries are what make it safe. A bare substring `sig` would match
`config`, `design`, `assign`, `signal`, `signIn`, `sigma`, `origSize` and
`significant`; none of them match, verified against the list.

One correction to the change as originally proposed: the token is tested against
the **original** identifier, not the `-`/`_`-stripped one the existing
`SECRET_RE` uses. Stripping turns `expected_sig` into `expectedsig` and destroys
the very word boundary the pattern depends on — the proposal tested the regex
standalone and would have silently lost every snake_case spelling.

### Fixed: capability gating was blind in monorepos, silencing whole rule families

Capabilities decide which diagnostics run, and they were derived from a single
`package.json`. In a monorepo that is the wrong manifest. The database client is
usually declared by ONE member and re-exported to the rest: cal.com declares
`@prisma/client` only in `packages/prisma/package.json`, and every consumer
imports `@calcom/prisma`. The root manifest's sole prisma-ish entry is
`@prisma/internals`, which is not a client.

So a manifest-only reading of cal.com produced **no `prisma` capability at any
level** — root, `packages/features`, `packages/trpc` and `apps/web` all reported
NO — and every Prisma-gated diagnostic silently never ran on one of the largest
open-source Prisma codebases in existence. `no-untransacted-dependent-writes`,
shipped days earlier and hand-verified against three real defects *in that very
repo*, fired zero times there through the CLI. In the report that is
indistinguishable from a clean result, which is the dangerous part: the scan says
nothing is wrong, and it is not that nothing is wrong, it is that nothing ran.

This was invisible to the corpus sweeps because they call `lintSource` with
capabilities supplied directly, which bypasses the gate entirely. The sweep
proved the rule's logic and proved nothing about whether it would ever execute.

`discoverProject` now unions the dependencies declared by workspace members
(npm/yarn `workspaces` and `pnpm-workspace.yaml`) before detecting capabilities,
and climbs to the enclosing workspace root when a MEMBER is scanned directly —
the common CI invocation, where the member declares no `workspaces` of its own.
The root's own entries still take precedence, so a version pinned at the root
continues to decide tokens like `express:5`. `node_modules` is never mistaken for
a member, member reads are bounded at 400 manifests, and a plain single package
globs nothing and is unaffected (measured: 26 ms for cal.com's 114 packages,
&lt;1 ms for a single package).

This repairs every dependency-gated diagnostic in monorepos, not only the Prisma
ones — `mongoose`, `typeorm`, `sequelize`, `jsonwebtoken`, `nest`, `next` and the
whole `ai` family gate the same way.

### A local-midnight Date rendered as a UTC calendar date

`no-local-date-as-iso-datestring` — `new Date(y, m, d)` builds an instant from
**local** wall-clock components; `toISOString()` renders **UTC**. East of
Greenwich local midnight is still the previous day in UTC, so truncating to
`YYYY-MM-DD` yields yesterday.

Measured on the month-range idiom under five timezones rather than argued:

```
UTC                  2026-08-01 .. 2026-08-31   ← intended
America/Los_Angeles  2026-08-01 .. 2026-08-31
Asia/Kolkata         2026-07-31 .. 2026-08-30   ← wrong
Europe/Berlin        2026-07-31 .. 2026-08-30   ← wrong
Australia/Sydney     2026-07-31 .. 2026-08-30   ← wrong
```

The upper bound is the expensive half. `new Date(y, m + 1, 0)` is the standard
"last day of this month" idiom, and the emitted bound silently **excludes the
last day** — a month-to-date report that drops its final day, every month, on
every host with a positive offset. Nothing throws, the string is well-formed, and
it is correct on a UTC or US-hosted CI box, which is why it survives review.

Both halves are required to fire: a 2–3 argument construction (which pins 00:00
local), and truncation to exactly the date part — `slice(0, 10)`,
`substring(0, 10)`, `split("T")[0]`, `.shift()`, array-destructuring, or
`replace(/T.*​/, "")`. The truncation is the proof of intent: the author threw the
time away, so the value is a calendar date.

Silent on `Date.UTC(…)` (414 uses in the corpus, the correct idiom sitting next
door to a defect in the same codebase); on four-or-more-argument constructions,
which pin end-of-day deliberately and are correct under a positive offset; on
`new Date()` and parsed strings, which are deliberate UTC; and on relative shifts
via `setDate`/`setMonth`/`setFullYear`, which preserve whatever offset the base
had — 25 of those were flagged by an earlier pass, read, and the whole branch
removed. The discrimination is fine-grained enough to fire on one line of a real
file and stay silent on the next: `new Date(y - 5, m, d).toISOString()...` fires
while `today.toISOString()...` two lines below does not.

**The rule was refuted before it settled, and the refutation shaped it.** An
adversarial review produced a counter-example rather than an argument: two of its
findings sat in a project whose own `.env` line 1 is `TZ=UTC`, where the emitted
string is correct — so the rule was reporting working code, which this project
treats as a release blocker. Capability detection now reads `TZ=` from a root
`.env`/`Dockerfile`/compose file, and `disabledWhen: ["tz:utc"]` turns the rule
off entirely on a project that declares a UTC deployment. Conflicting
declarations prove nothing and count as undeclared — both corpus projects that
pin `ENV TZ=Asia/Kolkata` in a Dockerfile also ship a `.env` saying `TZ=UTC`, and
which wins at runtime depends on whether the dotenv loader runs before the first
`Date` is constructed.

On a project that declares nothing it still fires, deliberately. Unlike a value
that is simply correct, this code is *contingently* correct: it produces the right
string on today's host and the wrong one the moment the service moves east. The
defect is latent, not absent. Severity `warn`, not `error`, says exactly that.

### A dotenv file copied into an image layer

`dockerfile-copies-dotenv-into-image` — `COPY .env` puts live credentials into an
immutable, distributable layer. `docker history`, `docker save` and any registry
mirror hand them to anyone who can pull the image; a later `RUN rm` deletes the
file in a *new* layer while the old one still carries it; and the values cannot
be rotated without a rebuild.

**The reason this needed its own rule is that nothing else can see it.** A `.env`
is gitignored — that is what it is for — so every check that reasons about
committed content passes cleanly, this project's own `no-committed-env-secret`
included, since it is `committedFilesOnly`. The sibling
`dockerfile-secret-in-build-stage` does not cover it either: that fires on an
`ENV`/`ARG` whose *value* is key material, and a `COPY` carries no value in the
Dockerfile at all. The Dockerfile is the only artifact where the leak is visible,
and it is visible as a filename.

Found at 17 of 224 `COPY`/`ADD` instructions across 35 corpus Dockerfiles,
naming files that contain `OPENAI_API_KEY=sk-pro…`, `GOOGLE_CLIENT_SECRET=GOCSPX…`,
`JWT_SECRET` and a ClickHouse password.

The source basename must match a positive allowlist — `.env`, `.env.production`,
`.env.prod|staging|stage|live|release` — so `.env.example`, `.env.template`,
`.env.test` and `.env.local` are never matched, and an unseen `.env.whatever`
stays quiet too. **Any stage counts, not just the final one:** restricting to the
final stage would look tidier and miss three real leaks, where a builder copies
the dotenv, a `RUN cp` launders the path, and the runner copies the directory —
so no final-stage `COPY` ever names a dotenv. Templated sources (`${ENV_FILE}`)
and globs (`COPY .env* ./`, `COPY . .`) are undecidable from the Dockerfile and
stay silent.

### Fixed: the install-script check counted hooks that never run (§69)

`supply-chain` reported every declared `preinstall`/`install`/`postinstall`/
`prepare`/`prepublish` hook as "code that runs when you install". Three of those
five do not.

Measured, by packing a manifest declaring all five hooks and installing it both
ways rather than reading the docs:

```
tarball install (what a registry install is) → preinstall, install, postinstall
directory install (git-style)                → preinstall, install, postinstall, prepare
--ignore-scripts                             → nothing at all
```

npm does not run `prepare` or `prepublish` for a published tarball — those fire
on publish, and on installs from git or a local directory. So a registry
dependency declaring `prepare: "npm run build"` executes nothing on your machine.

The scale of the overstatement is why this matters rather than being a footnote.
Across 14 real projects, **705 of 730 declared hooks were dormant against 25 that
actually execute** — one project reported 178 and executes 3. The section that
was supposed to show you which third-party code runs before your own was, in
practice, 28× noise, and the packages that genuinely run code — `bcrypt`
building natively, `esbuild` fetching a binary, `@scarf/scarf` phoning home —
were buried in a list nobody would read to the end.

`InstallScript` now carries `executes`, decided per package from the hook and,
for `prepare`, from whether the lockfile resolves that package outside the
registry. Dormant hooks are still reported — "this package declares a
postinstall-shaped hook" is worth seeing — but they are counted and rendered
separately, as a single trailing line rather than a wall. With no lockfile the
source is unknown, and unknown resolves to "does not execute": the registry is
the common case and overstating is the failure being fixed. New summary field
`withExecutingInstallScripts`.

### Dependent writes with no transaction (§14)

`no-untransacted-dependent-writes` — a second write that uses what the first
returned, with nothing holding the two together.

Outside a transaction every statement is its own committed transaction, so if the
second write fails the first is already durable and nothing rolls it back. Shown
at the driver level rather than asserted — the same two writes, run with and
without `BEGIN`:

```
write2 threw: CHECK constraint failed
orders rows after failure (NO tx):   1     ← the first write is COMMITTED
orders rows after failure (WITH tx): 0
```

What survives is a row the rest of the system believes cannot exist: a workflow
with no steps, a booking with no meeting token, a credit expense logged against a
balance that was never debited. Nothing errors at the time and the request has
already returned, so it surfaces later as a NOT NULL violation or a number that
does not add up, arbitrarily far from the cause.

**This rule was refuted once before it shipped, and the refutation is what it is
built from.** Two earlier framings were thrown out for being defended by naming
accident rather than by proof:

- *Receiver name hints do not prove a database.* The repo's own
  `DB_RECEIVER_HINTS` matches `client`, `conn`, `repo` and `repository`, and so
  returns true for all 20 SDK clients tested — Stripe, Twilio, S3, Elasticsearch —
  plus a real `retellRepository.createLLM(…)` → `createAgent(…)` pair and jsforce's
  `conn.sobject(Lead).create(…)` → `.update(…)`, both correct code one rename from
  firing. The rule now requires positive proof of Prisma: a `prisma`-prefixed path
  segment, a `new PrismaClient()` binding, or an import from a Prisma module.
- *`await` does not prove a write happened.* TypeORM's `repository.create()` builds
  an entity in memory and writes nothing — verified, 0 rows — and awaiting a
  non-promise is legal. The write set is Prisma's, enumerated explicitly, and is
  deliberately not `QUERY_METHODS`, which contains `findMany`, `count` and
  `aggregate`.

The dependence test is what makes a pair provably one unit of work: **W2 must
reference the value W1 returned.** Every true positive has that shape. Two writes
sharing no value are not shown to be related, and are silent.

Then, each from a case the refutation surfaced: a **guarded** second write is a
conditional refinement whose failure leaves a usable record; a **destructive**
second write is a compensating rollback; the **same model twice** is a status
transition; a `tx`/`trx`/`queryRunner` segment or an explicit
`transaction`/`session` option means a transaction is already in play; and
test, seed and fixture trees were the largest noise class at ~246 hits.

New capability token `ambient-transaction` (`cls-hooked`, `typeorm-transactional`,
`nestjs-cls`) disables the rule outright. Those packages open a transaction in
AsyncLocalStorage, so a write can be inside one with no evidence at the call site
at all — lexical analysis is unsound there, and silence is the only correct
response. None appeared in the corpus; the unsoundness is real regardless.

Measured: **3 findings across 2,106 Prisma producing-write call sites in 595
files — 0.14%**, every one hand-verified in cal.com. Prisma-only for now; the
Mongo equivalent is deliberately withheld because a `this.someCollection` field
cannot yet be proven to be a database, and an unprovable receiver is what the
refutation was about.

### Caught errors returned with a 2xx status (§9)

`no-error-response-with-success-status` — the handler threw, and the response says
everything is fine.

Every layer that reads the status instead of the body then agrees. `fetch` sets
`res.ok === true` and axios resolves rather than rejects, so the client's error
branch is dead code. APM, load balancers and uptime checks record a success, so the
endpoint reports a 100% success rate while it is failing and no alert ever fires —
the outage is invisible in exactly the dashboard someone would look at. Retry and
circuit-breaker middleware treat 200 as terminal.

The bug is self-concealing, which is why it survives: the body carries
`status: false` and a message, so it reads correctly in review and in manual
testing. Only the machinery that reads status codes is misled, and that machinery
is silent by nature.

Two things must both be true, and either alone is not enough. **The status must be
provably 2xx** — a literal `status(200)`/`code(2xx)`, or none at all, where Express,
Adonis and Fastify all default to 200; a computed `status(err.statusCode)` is
unknown, and unknown is silence. **The payload must evidence failure** — carrying
the caught error, an `error`/`errors` key that actually holds one, or an explicit
`success`/`status`/`ok: false`. The second condition is what keeps a legitimate
fallback silent: a catch that recovers and returns real data on 200 is correct, and
it is correct precisely because its payload makes no failure claim. An `error: null`
kept only to stabilise the response shape is not a failure claim either.

Three exclusions, each from something the sweep turned up rather than something
imagined: GraphQL's `{ data, errors }` envelope, where HTTP 200 is what the spec
requires; webhook and OAuth-callback handlers, where a 2xx is a deliberate
acknowledgement that stops the provider retrying; and string or template bodies,
which are pages for a browser to render rather than API error envelopes — the corpus
had an OAuth popup returning an HTML error page to `window.opener`.

Measured on a 220,042-file sweep: **138 findings across 32 files, and zero in
`node_modules`** — the profile of a team convention rather than a library mistake.
Sampled by hand, the pattern was consistent: the handler logs the error, fires an
SNS alert about it, and then returns 200.

### Fix-regression detection — boomerang bugs (§161)

- **`node-doctor ratchet check` now reports REGRESSIONS.** The ratchet's committed
  sidecar gains `resolvedHistory` (schema v2): every finding this project has been
  observed to fix, with the date. A finding that comes back — reverted, lost in a
  merge, reintroduced by a copy-paste — is reported as *"previously fixed, and
  back"* rather than as anonymous new debt. Identity is evidence-based, so a line
  shift or a moved file never resurrects a finding; still-accepted debt is
  absolved before the regression check; a malformed history rejects the file
  rather than fabricating a claim. `compareToRatchet` remains a pure function (the
  CLI owns the clock). A v1 ratchet loads unchanged and is rewritten only when the
  ratchet genuinely tightens.
  Hardened against an adversarial hunt that found seven ways a finding disappears
  *without being fixed* — each of which wrote a permanent false claim into the
  committed file. A resolution is now recorded only when the scan ran the **same
  ruleset** (persisted as a hash, so `--ignore-tag` or a config change no longer
  reads as a fix), **completed** (a parse failure proves nothing), and left **no
  surviving copy** of the key, and **was not suppressed** — an inline
  `node-doctor-disable` directive removes a finding from the report exactly as a
  fix does, so `ScanReport.project.suppressedKeys` now carries what the directives
  silenced (the scan cache is versioned to v2 to carry it too) and the ratchet
  excludes those keys. Suppressing a finding is acknowledging debt, not paying it,
  and removing the directive later must not read as a regression. Insufficient
  evidence declines to write history and says so. The cap no longer evicts the resolution it just recorded, and
  `ratchet init` carries the fix record forward instead of erasing it.

### Diagnostics — test-suite quality (§173)

- **`no-assertion-free-test`** (Maintainability, §173, opt-in) — a test that
  exercises production code and never asserts. It passes forever, proves only that
  nothing threw, and still counts toward coverage. Recognizes assertions across
  jest/vitest, `node:assert`, chai `should`, ava `t.is` and supertest. Delegation
  is resolved by **provenance**, not by name: a callee local to the file, reached
  through a local binding, or imported from a helper module may assert out of
  sight and is silent — the design that took this rule from 674 false positives on
  this repo's own suite to zero.

### Diagnostics — test-suite quality, continued (§174/§176)

- **`no-flaky-test-pattern`** (Maintainability, §174, opt-in) — the mechanical
  causes of non-determinism, caught before the test starts failing intermittently:
  a hard-coded `setTimeout` sleep, an assertion against `Date.now()`/`new Date()`,
  and `Math.random()` in the case body. A file that controls time
  (`useFakeTimers`/`setSystemTime`) silences the sleep and clock cases; a
  `setTimeout` that schedules real work is not a sleep. Order assumptions, shared
  state and real I/O are deliberately out of scope — they need dataflow this rule
  does not have.
- **`no-tautological-mock-assertion`** (Maintainability, §176, opt-in) — a test
  that asserts its own mock's configured return value back to itself, exercising
  none of the code under test while counting toward coverage. Only the provable
  sub-case ships (the section's "mocked surface dwarfs real surface" ratio is a
  judgement call): the assertion subject must be a direct call to a mock this file
  configured, with a value matcher. Silent when real code wraps the value, on
  behavioural assertions like `toHaveBeenCalledWith`, and on unconfigured spies.

### Test-quality rules hardened against an adversarial hunt

A 33-agent hunt against §173/§174/§176 confirmed 28 false positives, all now
closed and pinned. The dominant class was existential for a Node-focused tool:
**modern `node:test` style was flagged as vacuous on every test**, because the
assertion recognizer could not see `t.assert.strictEqual(...)` (the receiver is a
nested member expression) or a destructured `import { strictEqual } from
"node:assert"` called bare. Also fixed: tape's `t.equal`, `bench()` benchmarks
being treated as test cases (a benchmark asserts nothing by design), and —
worst — **production code importing `node:assert` for runtime invariants being
analyzed as a test file**. An assertion-library import now only marks a test when
real test declarations accompany it.

The §174/§176 fixes all follow one principle: the shape alone is never the bug,
it needs the shape *plus* proof it is actually wrong. A sleep must be the
awaited-Promise idiom; a clock read must be a direct assertion operand, not
wrapped in a predicate; `Math.random` is silent when stubbed; and a mock must
come from a namespaced factory in a never-reassigned `const`.

### Diagnostics — streaming correctness (§128)

- **`no-unhandled-pipe-error`** (Reliability, §128, opt-in) — a `.pipe()` whose
  source has no `error` listener. `.pipe()` neither forwards errors nor destroys
  the destination, so a failing source leaks the destination's file descriptor
  and hangs the response; an unhandled `error` event also crashes the process.
  Precision: the source must be provably a Node stream (rooted at
  `createReadStream`/`createGzip`/`new PassThrough`/…), so RxJS's `.pipe()`
  operator composition is never touched; silent when an `error` listener exists
  on the binding in any order, is attached inline in the chain, when a
  `pipeline(...)` wrapper handles teardown, on a dynamic event name, or when the
  stream escapes into a helper that could attach the handler.

### Three more migration lock hazards, measured (§15)

Five candidates were evaluated against a live Postgres 14; three shipped and two
were rejected, and in every case the measurement is the reason.

- **`migration-foreign-key-without-not-valid`** (Reliability, warn) —
  validating a new foreign key inline holds a write-blocking lock on **both**
  tables for the whole scan. The parent is the part nobody expects: measured on
  a 600,000-row child against a 200,000-row parent, an `INSERT` into the
  *referenced* table — which the statement never names as its target — waited
  **2,065 ms**.

- **`migration-volatile-column-default`** (Reliability, warn) — and here the
  received wisdom is **wrong**. "Adding a column with a default rewrites the
  table" has been false since Postgres 11, and the fast path turns out to be
  wider than "constant": it covers every non-VOLATILE default. Measured on
  400,000 rows, `DEFAULT 5` did not rewrite and took **18 ms**, while
  `DEFAULT gen_random_uuid()` rewrote and took **244 ms**. The rule therefore
  flags only genuinely volatile defaults, and `now()`/`CURRENT_TIMESTAMP` are
  deliberately absent — they are STABLE, take the fast path, and are the
  commonest default of all.

- **`migration-column-type-rewrite`** (Reliability, warn) — the heaviest lock in
  the set: `ACCESS EXCLUSIVE`, which blocks **reads** as well as writes.
  Measured on 2.4M rows, the lock was held **2,464 ms**, a concurrent indexed
  `SELECT` waited **2,400 ms** against a 2.08 ms baseline, and the statement
  emitted **401 MB** of WAL.

**The type rule's target list is short because the file cannot see the current
type.** The decisive experiment: two 400,000-row tables given the byte-identical
statement `ALTER COLUMN c TYPE varchar(100)` — free at 19 ms from `varchar(50)`,
a rewrite at 144 ms from `text`. Same bytes, opposite cost. Every target carrying
a modifier is therefore excluded, so varchar widening — the commonest such
statement in real migrations — is never reported. What remains are modifier-free
targets, minus three near-misses with measured free paths in: `integer` (from
`oid`), `inet` (from `cidr`), and `timestamptz` (from `timestamp` under a UTC
session, a runtime GUC that is in no file).

The Postgres-evidence and created-in-this-migration guards were **extracted**
into the migration context rather than copied a fourth time; the shipped
`migration-index-without-concurrently` was moved onto them and its tests pass
unchanged.

Validated against 593 real migration files from cal.com: 20 findings, all from
the foreign-key rule, spot-checked against the SQL.

### Index migrations that lock the table (§15)

- **`migration-index-without-concurrently`** (Reliability, warn) — a Postgres
  `CREATE INDEX` on a table that already exists, without `CONCURRENTLY`. The
  plain form holds a lock that blocks **every write** to the table until the
  build finishes.
  Measured on Postgres 14 against a 600,000-row table rather than quoted from
  the manual: a concurrent `INSERT` waited **3,093 ms** against a plain
  `CREATE INDEX` and **21 ms** against `CONCURRENTLY`. A factor of 147, and it
  scales with the table rather than with the migration. The migration succeeds
  either way, so nothing in CI or the deploy log marks it — the symptom is a
  write stall at deploy time.

Two guards matter more than the trigger. **A table created in the SAME migration
is never reported**: it has no rows to scan and no traffic to block, and
`CONCURRENTLY` would only forbid running it in a transaction. And **Postgres must
be proven from the file** — `CONCURRENTLY` is Postgres-only syntax, so on MySQL
or SQLite the advice is unfollowable; without positive in-file evidence of the
dialect the rule says nothing.

Validated against 593 real migration files from cal.com: 20 findings, with the
guard proving itself inside a single file — `create_internal_notes_tables`
creates `BookingInternalNote` and indexes both it and the pre-existing
`Impersonations`, and only the latter was reported.

### Missing indexes — `node-doctor schema-drift` (§14)

- **Filters on a column with no declared index** are now a section of the
  schema-drift report. Both halves were already in the repository — the schema
  says what is indexed, the query says what it filters on — so this needed no
  new infrastructure, only for the Prisma parser to stop discarding index
  metadata.

**The leftmost-prefix rule is the whole precision story.** `indexedFields`
records field-level `@id`/`@unique` plus the **leading** field of each
`@@index`/`@@unique`/`@@id`, and nothing else. A composite on `(tenantId,
status)` serves a filter on `tenantId` and does not serve one on `status` alone.
Recording every member of the list would have silently licensed exactly the scan
this exists to find — and the real-world run proved it matters, reporting
`PrReview.status`, which sits inside an index.

**It reports facts, not defects.** Nothing in either file says how many rows a
table has, and on a small table a sequential scan is correct and cheaper than an
index, so the section is framed as "a fact, not a defect" in the same way
`supply-chain` presents copyleft. A relation key is a join rather than a
single-column filter and is never reported; `select`/`orderBy` are not filters.

Validated against a real Prisma project rather than only fixtures, since none of
the usual corpus uses Prisma: 8 models over 49 files produced 3 findings, each
confirmed against the schema by hand.

### Conflicting dependency declarations (§19)

- **`no-conflicting-dependency-declaration`** (Reliability, error) — a package
  declared in both `dependencies` and `devDependencies`. It reads like a
  harmless duplicate, and npm prints no warning.
  Measured against real npm rather than assumed, twice: with **different**
  ranges the devDependencies range wins (`^7` + `^6` resolves `semver@6.3.1`),
  and with **identical** ranges it still resolves as dev. In both cases the
  lockfile carries `"dev": true`, and after `npm install --omit=dev` the package
  is **absent from `node_modules` entirely** — verified by looking for the
  directory afterwards.
  The failure is therefore production-only and total: locally the package is
  installed, the tests pass, the types resolve; the deployed image runs
  `--omit=dev` and the first `require` gets `MODULE_NOT_FOUND`, for a dependency
  the manifest plainly calls a runtime one.
  `peerDependencies` and `optionalDependencies` overlapping `dependencies` are
  both ordinary patterns and are never reported.

Scope is stated in the rule rather than left implicit. The text scan excludes
`node_modules`, so this only reads FIRST-PARTY manifests — exactly where the
behaviour was measured. A published package's own dual declaration is a
different question, since a consumer never installs its devDependencies, and the
rule makes no claim about it because it never sees one. Across eight projects: 0
findings in 27 first-party manifests, with the 14 instances in their dependency
trees correctly out of scope.

### Weak crypto parameters, and a TypeScript evasion hole (§6, §7)

- **`no-weak-crypto-parameters`** (Security, error) — two literal options that
  weaken something already correct by default. Neither produces an error, a
  warning, or a failing test: the handshake completes, the key generates, and
  the weakness is invisible until somebody reads the parameter.
  Both premises are pinned as executable facts, and they rest on **different
  ground**, which the messages state. `tls.DEFAULT_MIN_VERSION` is `TLSv1.2` and
  Node accepts a downgrade to `TLSv1` **without throwing** — the same shape as
  `tar`'s `preservePaths`, an option that switches off a protection you already
  had. The RSA floor is the opposite: Node generates a 512-bit key **without
  objecting**, so the 2048-bit floor is a standards claim (NIST SP 800-57, 2013)
  and is reported as one rather than as an error Node would raise.
  Literal-only, and only an object passed as an argument is judged — a
  standalone profile fixture is not a live TLS context. Swept over 111,566
  files: 0 findings.

- **`no-mass-assignment` had an evasion hole, now closed.** All seven TypeScript
  assertion spellings bypassed it — `as T`, `as any`, `satisfies`, `!`, `<T>x`,
  aliased, and spread-of-cast — leaving it close to blind on TypeScript, where
  `create({ data: req.body as UserDto })` is the idiomatic form and the
  assertion is exactly what makes the author confident the data was validated.
  The cause was the precision fix that removed 743 false positives: making the
  match exact let every erased wrapper through. The repair is the underlying
  fact rather than a patch list — a TypeScript assertion is erased at compile
  time, so `req.body as UserDto` IS `req.body`. The other taint-based security
  rules (SQL, exec, eval, SSRF, open redirect) do not share the hole; they walk
  descendants. Re-swept: 133,123 files, 0 findings, with every false-positive
  shape from the original sweep still silent.

### Zip slip — `no-unsafe-archive-extraction` (§7)

An audit of the existing security surface found the basics already covered by 61
diagnostics — injection in four forms, XSS, SSRF, path traversal, four JWT rules,
secrets, TLS, weak crypto, cookie flags, CORS, mass assignment. The one
OWASP-classic genuinely absent was archive extraction.

- **`no-unsafe-archive-extraction`** (Security, error) — an archive entry carries
  its own path, and that path is attacker-chosen:
  `join("/srv/app/uploads", "../../../etc/cron.d/pwn")` resolves to
  `/etc/cron.d/pwn`, pinned as an executable test rather than asserted. The
  upload arrives as a legitimate archive, the extraction succeeds, and the file
  lands outside the directory the application believes it owns.

  Two shapes, deliberately not held to the same standard. **The `tar` flag** was
  read out of the installed library's own source rather than its docs:
  `unpack.js` gates three separate protections on `preservePaths` — stripping
  `/` from absolute paths, rejecting `..`, and refusing to extract through a
  symlink. It is a literal, so the claim is exact. **The hand-rolled join** needs
  all three of an entry-path property, a filesystem write, and no containment
  check anywhere in the function; any `relative`/`startsWith`/`isAbsolute`
  silences it, because whether a check is correct is not a claim this makes.

  Only entry properties verified against a shipped implementation are matched:
  `fileName` (yauzl's source) and `path` (tar's `read-entry.js`). `adm-zip`'s
  `entryName` is documented but was not installed to check, and this analyzer
  does not assert an API it cannot verify.

Swept over 111,566 files: 0 findings, and every constructed shape still fires.

**Not shipped, with reasons.** *XXE* is library-specific — Node ships no XML
parser — and `libxmljs`'s `noent` semantics could not be verified offline.
*CSRF*, *security headers* and *rate limiting* are absence claims at project
scope rather than facts at a call site, which is a different design and a
different false-positive profile.

### Bodiless statuses and pre-push hooks (§3, §42)

- **`no-body-on-bodiless-status`** (Bugs, error) — a response body sent with 204,
  205 or 304. HTTP defines those as bodiless and Node enforces it: verified
  against a live server, the payload is silently discarded and the client
  receives `""`.
  Nothing fails on the server, which is why this survives — the breakage lands
  in the CALLER's codebase, where `await res.json()` throws
  `Unexpected end of JSON input`, or the field being read is `undefined`. The
  line is written for a real reason ("there is no content, and here is what I
  did") and those two halves contradict each other.
  Both halves of the trigger are literal, so nothing is inferred.
  `res.status(204).end()`, `.send()` with no argument, and `res.sendStatus(204)`
  are the correct spellings and stay silent.

- **`node-doctor install --git-hook pre-push`** — the flag now takes an optional
  kind. The two hooks get **deliberately different** scans: `pre-commit` stays
  staged-only, because a commit happens dozens of times a day and a full scan
  there is a tax people uninstall rather than pay; `pre-push` scans the whole
  project at `--blocking error`, because a push is rare and is the last point
  before the code becomes somebody else's problem. Both stay advisory, both say
  in a comment how to enforce, and a bare `--git-hook` behaves exactly as before.

**A 133,123-file sweep found the one shape the unit cases missed.**
`@adonisjs/cors` ends a preflight with `response.status(204).send(null)`, under
a comment saying exactly that. A provably empty argument — `null`, `undefined`,
`""` — is how people spell "no body" when the signature wants one, and it sends
nothing, so there is nothing to discard. Kept as a regression test. That is the
fourth consecutive wave where the corpus caught something the hand-written cases
did not.

### License analysis — `node-doctor supply-chain` (§19)

- **Licenses are now a section of the supply-chain report** — the distribution
  across the installed tree, the packages under a copyleft license, and the
  packages that declare nothing at all. No network needed: every package's terms
  are declared in its own manifest, which the supply-chain walk already read, so
  this costs one extra `stat` per undeclared package and nothing else.
  Everything reported is a DECLARED fact. The report never says you are
  violating anything — whether an obligation binds you depends on how you
  distribute, which a manifest cannot say — so copyleft is presented as *an
  obligation to decide about, not a defect*.

**Two precision rules came from running it against real dependency trees rather
than fixtures**, and each would otherwise have produced a wrong claim:

- **An SPDX `OR` is a CHOICE.** `jszip` ships `(MIT OR GPL-3.0-or-later)` — you
  take the MIT branch and owe nothing, so reporting it as copyleft is false. A
  dual license binds only when EVERY alternative binds; `AND` is the opposite,
  where one copyleft term is enough.
- **An absent `license` field is not "unlicensed".** The terms may sit in a
  LICENSE file the field never names, so that is checked first, and a
  `private: true` package needs no license by npm's own convention — that case
  was the workspace's own package, not a dependency.

After both fixes the two real trees report exactly what they should: an LGPL
dependency and a genuinely termless `buffers@0.1.1`, with the dual-licensed and
private packages correctly silent.

### GraphQL coverage and mass assignment (§3, §6)

Both came out of a full audit of the catalog's 63 `Planned` markers against the
actual codebase — **51 unblocked, 55 already shipped, 26 partial, 66 genuinely
blocked**. The catalog had drifted much further than spot-checks suggested.

- **GraphQL resolvers are now request handlers.** The engine was close to silent
  on a GraphQL backend: `collectRequestHandlers` knew method-call registrations,
  the Fastify object form, HTTP decorators and convention exports, and nothing
  about a resolver. Matching a resolver map's `Query`/`Mutation`/`Subscription`
  fields and the `@Query`/`@Mutation`/`@ResolveField` decorators makes **every**
  request-path rule cover GraphQL at once — `no-query-in-loop`,
  `no-sync-io-in-request-path`, `no-large-json-parse-in-request-path`,
  `no-error-leak-to-client`. `@ResolveField` runs per parent row, so an N+1
  there is worse than in a REST handler.
  Deliberately narrow: only the three root operation types, and only when the
  value is an object of functions. Treating any capitalized key as a GraphQL
  type would sweep in every namespace object in the file.

- **`no-mass-assignment`** (Security, error) — the whole request body written
  into a record, so the caller sets every column the model has:
  `POST {"email":"…","role":"ADMIN"}`. Privilege escalation with no exploit
  required. It survives tests (they post the fields the form posts) and type
  checking (`req.body` is `any`).
  It asks one syntactic question — does the body OBJECT reach a write
  un-narrowed — and never what a field MEANS, because "`isAdmin` is privileged"
  is a claim about a name.

**The first version of `no-mass-assignment` was wrong, and the corpus caught it:
743 findings across 106,851 files.** It treated any request-DERIVED binding as
the body, so `mongoHelper.create(session)` — where `session` was assembled field
by field from request fields — was reported. That assembled object is the
correct pattern the rule recommends; a rule that punishes its own fix is worse
than no rule. The value must now be the body *syntactically*: `req.body` written
out, a binding whose initializer is exactly that, or a spread of either. No taint
involvement. Re-swept: **743 to 0**, with every true-positive shape still firing,
and all three real-world false positives kept as regression tests.

### Finding blame — `node-doctor blame` (§42)

- **`node-doctor blame [dir]`** (aliases `finding-age`, `age`) — how old is each
  finding, and who last touched the line? Filed as **Vision** and shipped
  without new infrastructure, for the second time in this catalog: §159/§160/
  §163 brought `git-history.ts`, §110 added a porcelain blame parser, and that
  was the whole dependency.
  A finding list answers "what is wrong". It does not answer the question triage
  asks first — **"is this new?"** A hardcoded credential introduced last Tuesday
  is an incident; the same finding untouched for three years is debt. The report
  leads with what landed inside the recent window and sorts oldest-first, so the
  tail is what changed.
  **The precision story is one distinction:** `git blame` reports the commit
  that LAST TOUCHED a line, not the one that introduced the finding — a reformat
  or a refactor re-attributes it. So every surface says "last touched" and an
  age is a **lower bound**; claiming "introduced" would invent a precision blame
  does not have. A **shallow checkout suppresses the report** rather than dating
  every finding to the graft commit, which matters because `actions/checkout`
  clones `--depth 1` by default. An uncommitted line is reported as uncommitted
  rather than dated, and an unblameable file yields an unattributed finding
  rather than a wrong one. Exits 0 always.

- **`blameFile`** is now shared git plumbing in `git-history.ts`, parsing
  sha, author, timestamp and subject in a single pass — so no follow-up
  `git log` is needed. `ai-attribution` was moved onto it and its 11 tests pass
  unchanged, which is what makes the extraction safe rather than hopeful.

Two stale statuses corrected alongside: §40 marked watch mode, HTML output and
the auto-fix command as Planned when all three ship, and §42 marked diff
analysis and pre-commit hooks as Planned for the same reason.

### Two false positives in shipped rules, found by a scoping pass that shipped nothing

An adversarial pass scoped four candidate AI-security rules and **rejected all
four**. The rejections are recorded in FEATURE.md; the useful output was two
false positives it found in already-shipped, default-on rules while probing.
Both were reproduced by hand before being fixed.

- **A loop's HEAD is not the loop.** `ai-call-in-loop` and `no-query-in-loop`
  both climbed to the nearest enclosing loop without asking WHICH part of it the
  call sat in. A `for…of` iterable and a `for` statement's `init` are each
  evaluated exactly once, so four idiomatic shapes were reported as running per
  iteration — including `for await (const chunk of await client.chat.completions
  .create({ stream: true, … }))`, the canonical streaming idiom, and
  `for await (const row of prisma.user.findMany(…))`, a single cursor query
  reported at **error** severity. Fixed with one shared predicate,
  `runsPerIteration`. A `for` statement's `test` and `update` DO re-run and
  still fire, as does anything in a loop body.

- **A locally-declared request-root NAME is not caller data.** `computeTaint`
  deliberately excludes a file's own `const context = …` from the request-root
  set — its comment cites a diff utility's "lines of context" — but
  `looksCallerControlled` re-derived the check from the NAME and defeated that
  exclusion for all sixteen files that call it, thirteen of them security rules.
  A diff utility's `const context = lines.slice(0, 3).join("\n")` interpolated
  into a prompt was reported as untrusted input. The exclusion now lives in one
  place: `computeTaint` seeds the taint set with the roots a file genuinely has,
  and every consumer inherits the answer.
  A **parameter** named `context` or `event` still counts as a request root, and
  that is deliberate rather than an oversight — AWS Lambda's handler is
  `(event, context)`, where `event` genuinely is the caller-controlled payload.

### Diagnostics — parsing model output (§107)

- **`no-unguarded-llm-json-parse`** (Reliability, `requires: ai`) — `JSON.parse`
  of model output with nothing to catch a `SyntaxError`. A model returns TEXT:
  asking for JSON, even with a schema and a JSON mode, changes the odds and not
  the type. Every shape a model emits when it goes wrong throws, and each was
  measured rather than assumed — a response **truncated at the token cap**
  (`{"name":"Ada","bio":"a very long bi`), one wrapped in a ```` ```json ````
  fence, one prefaced with "Sure! Here is the JSON:", a trailing comma, single
  quotes.
  Unhandled, the throw rejects the handler: a 500 at whatever rate the model
  malforms its answer, which is neither zero nor visible in the code. It is
  `require-llm-token-limit`'s failure mode arriving one layer down.
  Both halves of the claim are proven: the argument must be model output traced
  to a recognized call or an alias of one — a bare identifier is never assumed
  to be model text — and there must be no enclosing `try`/`catch`. A `try` with
  only a `finally` catches nothing and still fires; a `try` outside the function
  does not catch a throw from a later invocation of it, and also still fires.
  Whether an existing handler is *good* is not a claim this makes.

The model-taint model §105 and §107 share was **extracted rather than copied**
(`collectModelBindings`, `isModelDerivedExpression` in the AI pack's `shared.ts`).
A duplicated taint definition is worse than a shared one that is wrong, because
only the shared one gets fixed once. `no-llm-output-in-sink` is unchanged and its
165 tests pass against the extracted version.

### Report drift — `node-doctor drift` (§104)

- **`node-doctor drift --baseline <f> --current <f>`** (aliases `why-changed`,
  `explain-drift`) — answers "why did this pass yesterday and fail today?" from
  the two artifacts alone, offline and after the fact.
  The provenance record had shipped some time ago; the catalog entry calling it
  Planned was stale. What had genuinely never been built is the part that reads
  it back. **Nothing consumed `provenance`**, so the question it was recorded
  for still had to be answered by hand.
  That question has one useful shape: **did the code change, or did the tool
  change?** A finding diff cannot tell you — `delta` reports six new findings
  identically whether they came from six new bugs or from one new rule, and a CI
  failure means something very different in each case.
  `drift` attributes the difference to the tool version, the **ruleset** (naming
  the rules added, removed or re-graded), the config, the **capabilities**
  (adding a Prisma dependency silently switches on every `requires: ["prisma"]`
  rule, and nothing about that looks like a tooling change), or the coverage.
  When none of those moved it says the code changed — the one case where the
  finding delta means what it appears to mean. Exits 0 always.

- **`provenance.ruleset`** — the report now records the exact `id:severity` list
  its `rulesetHash` is computed from, so the artifact is self-describing and
  `drift` can NAME the rule that changed rather than only reporting that
  something did. Additive; `schemaVersion` is unchanged and the ratchet reads
  provenance exactly as before.

Two honesty rules it keeps. A scan that did not finish is reported as making the
comparison **unsound** rather than merely different — a finding absent from an
incomplete scan was not necessarily fixed. And an artifact predating the recorded
rule list reports the comparison as **unavailable**, because treating a missing
list as "unchanged" would be precisely the wrong answer.

Four catalog statuses were corrected in the same pass: §104's provenance record
was already shipped, and §189, §193, §203 and §208 are marked scoped-and-rejected
rather than Planned, matching the pass that actually rejected them.

### AI-authored-code trust boundary — `node-doctor ai-attribution` (§110)

- **`node-doctor ai-attribution [dir]`** (aliases `ai-trust`, `authored-by`) — a
  §110 flagship the catalog had filed as **Vision**, shipped without adding any
  infrastructure. Its stated blocker was "git-metadata attribution"; §159/§160/
  §163 brought `git-history.ts` for their own reasons, and that was the entire
  dependency. No model, no network, byte-identical across runs.
  It measures commits that **declare** AI assistance — a `Co-Authored-By:`
  trailer naming a known agent identity, or a generated-with marker — and then
  `git blame` attributes surviving lines to them, so the report is about code
  still in the tree rather than about commits that happened.
  A trailer is a **claim, not proof**: an agent not configured to write one
  leaves no trace, and a human can add one by hand. Every surface says
  "declared", never "written by", and the number is stated as a floor on AI
  involvement rather than a measurement of it — rounding that off to "34% of
  your code is AI-written" would invent a precision it does not have.
  The report leads with the **intersection** rather than the percentage: a
  finding on a line from an AI-assisted commit that no human has touched since
  is a review decision, where a per-file percentage is trivia. Blame therefore
  runs only over the files carrying findings. A shallow checkout suppresses line
  attribution and says so, because `git blame` would otherwise credit every
  pre-graft line to the boundary commit. Exits 0 always — attribution describes
  provenance, it does not assert a defect.

Two bugs were caught by running it against this repository's own history instead
of a fixture, and both are now regression tests. A `git log --format` string
whose first byte is a raw NUL fails outright, so the record separator moved to
the end as git's own `%x00`. And porcelain blame emits one header per LINE, the
first of each group carrying an extra `<count>` field — honouring that count
double-counts every group, which is how the first version reported 50,195
attributed lines for a 330-line file.

### AI pack completed, and two facts from a full scoping pass (§109, §205, §188, §200)

Five new rules. Three complete the AI pack's open items; two come from scoping
every remaining `⚙️ Now` section in the catalog, which mostly established that
they cannot ship.

- **`no-unbounded-agent-loop`** (Reliability, §109, `requires: ai`) — a
  syntactically infinite loop containing a proven model call, whose only exit is
  the model deciding to stop. A tool that keeps returning an error the model
  keeps trying to fix runs until the request times out or the spend cap does.
  The claim is the narrow syntactic one — *this loop counts nothing* — so any
  counter at all silences it.

- **`require-llm-token-limit`** (Performance, §109, `requires: ai`, **opt-in**) —
  a model call with no output cap. Opt-in deliberately: a token cap is a policy
  choice, not a language fact, so it is not held to the always-wrong bar the
  default-enabled rules meet. Claims about an absent key, so it is made only
  where every key is visible — an object literal, no spread.

- **`no-unimplemented-stub`** (Maintainability, §205) — a function body with zero
  statements whose comment admits it was never written. It returns `undefined`
  silently, passes type checking, and passes a test written against the same
  misunderstanding.

- **`no-namespace-object-write`** (Bugs, §188-adjacent) — `import * as NS` binds
  a sealed module namespace object, and ES module code is always strict, so
  `NS.member = x` is an unconditional `TypeError`. It arrives with a migration:
  `require("node:fs").readFile = wrapped` is legal CommonJS and is how a
  generation of APM shims was written.

- **`no-sparse-array-iteration`** (Bugs, §200-adjacent) — `new Array(5)` creates
  five holes, not five `undefined`s, and every callback-taking method on
  `Array.prototype` skips holes. `new Array(5).map((_, i) => i)` returns five
  holes; `new Array(3).forEach(seed)` runs the callback zero times. Both
  measured. `.length` is still the number the author expected, which is why it
  survives review.

**The scoping pass rejected thirty of thirty-seven sub-cases**, each with the
specific thing it would need to know that syntax does not say, all recorded in
FEATURE.md. Three rejections corrected the catalog's own premise: `export *`
chains do not defeat modern bundlers, `fs.watch` firing twice is not the
invariant assumed, and an absent `.map` file does not make a stack trace
unreadable. Notably `Buffer.allocUnsafe` was rejected despite the disclosure
being real — 7 of 20 non-pooled 64KB allocations came back holding previous
contents when measured — because "was this buffer filled before it escaped" is
flow analysis, not syntax.

`no-namespace-object-write` carries the same class of trap the Worker findings
did, and it is why the rule proves the module system rather than assuming it:
**loaded from a CommonJS caller — sloppy mode — the identical write on the
identical sealed object does not throw, it silently does nothing.**
`Object.isSealed` is `true` in both worlds; only the caller's strictness decides.

`no-unimplemented-stub` was corrected by a 76,701-file corpus sweep before it
shipped. Its first version matched the bare words `implement`, `stub` and
`placeholder` anywhere in a comment, and fired on correct code explaining
itself — Next's `voidCatch()` ("the underlying **implementation** to forward
errors") and React Navigation's `removeListener` ("**placeholder** screens").
Matching a domain word in prose is the style-linter failure §205 explicitly
warns against, so a conventional tag must now be written as a tag. The sweep also
established that an inline callback argument is never residue: `req.on("error",
() => {})` is a required idiom, and Next ships exactly that with a
`// TODO: log socket errors?` beside it. Findings fell 47 → 19, and the 19 are
genuine.

### Diagnostics — signals, exit codes, and encoding (§196, §197, §202)

Four new rules on the same criterion as the previous wave — the claim has to be an
always-wrong fact about the runtime — with one addition to the method: **every
runtime claim was confirmed by running Node**, not by reasoning about it. That
caught two places where the received description of the bug was wrong.

- **`no-uncatchable-signal-handler`** (Reliability, §196) — `SIGKILL` and
  `SIGSTOP` are handled by the kernel, and the usual description of this bug is
  "a handler that never fires". It is worse than that: `process.on("SIGKILL", …)`
  reaches `uv_signal_start`, which fails, and the **`EINVAL` is thrown at the
  point of registration**. The line crashes the process at exactly the moment it
  is wiring up its shutdown path — at module scope, that is a boot failure. The
  intent behind it is unreachable by construction, which is why orchestrators
  send `SIGTERM` first and `SIGKILL` only after the grace period. Only the
  registration methods on the global `process` with a literal signal name are
  judged; `process.kill(pid, "SIGKILL")` sends the signal and is correct.

- **`no-out-of-range-exit-code`** (Bugs, §197) — a process exit status is one
  byte, so Node keeps `code & 0xFF`. `process.exit(256)` reports **success** to
  the shell and to CI, so the pipeline goes green and the deploy proceeds;
  `process.exit(300)` reports 44, a different failure entirely. Both confirmed by
  running them. The code must be a numeric literal, and `process.exit(-1)` is
  deliberately not reported — it masks to 255, a nonzero failure, which is what
  everyone who writes it means.

- **`no-string-length-as-content-length`** (Bugs, §202) — `String.length` counts
  UTF-16 code units; `Content-Length` counts bytes. They agree for ASCII, which
  is why this survives every test written in English, and when they disagree the
  header is always too small: the client stops reading mid-body, truncating the
  response or desynchronising a keep-alive connection so the remaining bytes are
  parsed as the next one. An emoji in a display name is enough. The operand must
  be provably a string — a literal, `JSON.stringify(…)`, `String(…)`, a
  `.toString()`-family call — because a bare identifier could be a Buffer, whose
  `.length` IS the byte count and is correct.

- **`no-chunk-string-concat`** (Bugs, §202) — the commonest body-collection
  snippet in circulation. A `data` chunk is a Buffer sized by the network, so
  `+=` decodes each one on its own and a character straddling the seam becomes
  replacement characters. Verified end-to-end against a real HTTP server: a body
  split across two TCP segments arrives as
  `{"name":"café \uFFFD\uFFFD\uFFFD naïve"}`.
  It does **not** surface as a parse failure, which is how this bug is usually
  described — `U+FFFD` is legal inside a JSON string, so `JSON.parse` succeeds
  and the corrupted value is written to the database. Silent data loss on a
  fraction of requests, not an error anybody gets paged for. Any mention of an
  encoding in the file (`setEncoding`, a stream option, an explicit
  `toString("hex")`) drops the claim, and the accumulator must be provably
  initialised to a string.

Gated on corpus sweeps totalling over **half a million real files** across
twenty-six project trees, and an adversarial hunt of 318 cases whose 43 claimed
false positives were every one reproduced by hand. All 43 are now closed.

The hunt's most valuable finding is that two of these rules asserted runtime
behaviour that is true on the main thread and **false inside a Worker** — neither
discoverable from the documentation, both settled by ten lines of Node:

- `process.on("SIGKILL", …)` does **not** throw in a worker thread. Workers never
  install the hook that reaches `uv_signal_start`, so registration is a plain
  `EventEmitter.on` and the listener is merely dead. The finding is entirely
  about the crash, so a file that touches `worker_threads` is no longer judged —
  as are a `try`/`catch` around the registration (the throw is caught and the
  process survives), a file that replaces the global with
  `globalThis.process = fake`, an `import process = require(…)` binding the scope
  resolver cannot see, and a test pinning the documented throw.
- A worker's exit code never reaches `wait(2)`. It is a plain JavaScript number
  handed to the parent's `exit` event, so `process.exit(1001)` in a Worker really
  does deliver 1001 and nothing is masked.

The other two rules were narrowed on the same principle:

- `no-string-length-as-content-length` now decides a LITERAL by **arithmetic** —
  computing both counts and comparing — so a canned `"Not Found"` body, a hex
  digest and a base64 token, all of which are pure ASCII, are correct code and
  stay silent. Everything decided by a method NAME came out: `String(n)`,
  `Date#toISOString()` and `join()` over numbers all produce ASCII, and telling
  them apart from a non-ASCII case needs the value, not the name. `set` and
  `header` came out too — a `Map` of column widths keyed by a header name is not
  a response.
- `no-chunk-string-concat` now **proves the receiver** instead of assuming it.
  Eighteen of the hunt's claims were streams whose chunks are already strings —
  `Readable.from(["a"])`, any `objectMode` stream, `split2()`, `through2.obj()`,
  a `serialport` `ReadlineParser`, an `iconv-lite` `decodeStream`,
  `Readable.fromWeb` over a `TextDecoderStream` — and `+=` is correct on every
  one. The rule now fires only on `process.stdin`, a `net`/`tls` socket, an
  `http`/`https` request or response, a `child_process` handle's
  `.stdout`/`.stderr`, or an `fs.createReadStream` opened with no encoding, each
  traced to the builtin it came from.
  That costs real recall, measured rather than assumed. On a 525,810-file corpus
  the shipped rule reports 28 findings across four packages —
  `@electron/windows-sign`, `json5`, `pstree.remy` and `simple-update-notifier`.
  A stream that arrives as an opaque function parameter — how Metro, Next and
  Cloudinary all write it — cannot be traced to a builtin inside one file, so
  those are no longer reported; neither is a transpiled interop shape nor a
  `cross-spawn` handle. They are real bugs this rule will not find, and they are
  the price of never reporting the eighteen string-emitting stream shapes the
  hunt produced.

Across 2,962 first-party source files in twenty projects, all four rules are
silent.

### Diagnostics — five always-wrong facts (§194, §199, §201, §204)

Five new rules, chosen on one criterion: the claim has to be an always-wrong fact
about the language or the runtime, not an inference about the data. All five are
`error`, enabled by default, and gated on a **466,000-file corpus sweep** across
eighteen real projects and their dependency trees.

- **`no-nan-comparison`** (Bugs, §201) — `NaN` is the only value not equal to
  itself, so every comparison against it has a constant answer. `=== NaN` is a
  validation branch that never runs, so the `NaN` flows onward and surfaces three
  layers away as a `null` in JSON or an `Invalid Date`; `!== NaN` is a guard that
  never rejects anything while reading like a check that was performed. Both
  shapes are silent, and they fail in opposite directions.
  A file that declares its **own `Number`** — a value namespace, an interpreter
  class, a schema object — is comparing object identity and is never reported;
  applying this rule's advice inside such a file is a `TypeError`. TypeScript
  `namespace`/`enum` declarations are matched by syntax because the scope
  resolver does not record them. A test file is inert: `expect(NaN === NaN)`
  pins the constant down on purpose and has no branch at all.

- **`no-oversized-timer-delay`** (Bugs, §204) — Node stores a timer delay in a
  signed 32-bit int, so anything above 2,147,483,647 ms (24.85 days) is clamped
  to **1 ms**: the session expiry meant for next month runs on the next tick, and
  a monthly `setInterval` becomes a 1 ms hot loop. `1000 * 60 * 60 * 24 * 30`
  reads as obviously correct, which is why it survives review, and nothing but
  production ever waits long enough to notice.
  The delay must fold from numeric literals and `+ - * / **` ALONE — a variable,
  a config read or a call is never folded, however plainly its name says
  `THIRTY_DAYS` — and the callee must be a global timer or a `node:timers`
  import that still resolves to that import at the call site.

- **`no-dirname-in-esm`** (Bugs, §199) — `__dirname`/`__filename` are CommonJS
  wrapper parameters, so in an ES module the first line that reads one throws
  `ReferenceError` at module evaluation, before any of the module's own code
  runs. This is the commonest breakage when a package flips `"type": "module"`,
  and a lazily-imported route file can carry it to production untouched.
  The module system is **proven, never inferred**: a `.mjs`/`.mts` extension, or
  `import.meta` in the file (which does not parse in CommonJS), or a `.js` file
  in a `"type": "module"` package that really has `import`/`export`. A `.ts` file
  is not judged that last way — its emitted format is a `tsconfig` question.
  Silent on: a local `__dirname` (the `fileURLToPath` shim), a `typeof __dirname`
  guard anywhere in the file, a tool **config** (`*.config.js`, which the tool's
  own loader bundles with `__dirname` defined), and a **bundler marker**
  (`import.meta.env`, `import.meta.hot`, which do not exist in Node at all).
  Only a *reference* counts — an interface member, a class field, a re-export
  specifier, an import alias and a TypeScript parameter property merely spell it.

- **`no-url-as-filesystem-path`** (Bugs, §199) — `import.meta.url` is a `file://`
  URL string, not a path. Narrowed to the four `node:path` members that actually
  break it: `join` and `normalize` collapse the scheme's slashes, `resolve` and
  `relative` measure against `process.cwd()`. `basename`, `dirname`, `extname`
  and `parse` are pure segment arithmetic that works correctly on a URL, so a
  module name for a logger or a sibling URL for a dynamic import is never
  reported. `fs` is judged in argument 0 only, and `fileURLToPath(…)`/`new URL(…)`
  exclude themselves by construction.

- **`no-literal-listener-removal`** (Reliability, §194) — `removeListener`/`off`/
  `removeEventListener` match by reference identity, so a function literal
  written at the removal site removes nothing. `.bind(…)` is the subtler half:
  it returns a NEW function every time it runs, so the bound listener added and
  the bound listener removed are two different objects with identical source
  text. The listener stays attached holding everything it closes over, until
  `MaxListenersExceededWarning` shows up attributed to something else.
  A test file is inert — the harm is a long-lived process, which a test does not
  have, and every real-world instance found was a suite asserting the no-op.

Hardened against an adversarial hunt whose **42 claimed false positives were each
reproduced by hand** (the hunt's own verification pass lost 26 of 47 agents to
infrastructure errors, so its verdicts were not trusted). Between the hunt and
the corpus sweep, six genuine precision defects were found and closed: a rule
that checked whether `NaN` was rebound but not whether `Number` was; two rules
that bound imported names without re-checking them at the call site, where
`resolve` is a Promise executor's own parameter and `import-meta-resolve`'s
second argument really is a URL; a `typeof` guard read as a reference; a
bundler-loaded config read as a Node module; and four `path` functions that work
fine on a URL. The sweep also turned up three real bugs in published code —
`@tiptap/core`'s `ResizableNodeView` adds and removes a listener with two
different `.bind(this)` results, the Chrome DevTools frontend bundled into
`@react-native/debugger-frontend` does the same, and `@swc/helpers` ships a build
script that reads `__dirname` from an ES module.

### Package-exports resolution — `node-doctor exports-check` (§185)

- **`node-doctor exports-check [dir]`** (aliases `exports-map`, `dual-package`) —
  a `package.json` `exports` map is a resolution program, and every way it can be
  wrong fails for a *consumer* while succeeding for the author, who has the whole
  source tree and never loads through the map. Seven problems: a target that is
  not on disk (`ERR_MODULE_NOT_FOUND`, and `npm publish` does not check), a
  `require` condition pointing at ESM (`ERR_REQUIRE_ESM` for every CommonJS
  consumer while ESM consumers work, so it passes the author's own test), an
  `import` condition pointing at `.cjs`, a `types` condition ordered after
  `default` (never reached: the package silently resolves to `any`), `types`
  after any other runtime condition, `main` and `exports["."]` resolving to
  different files, and a wildcard that matches nothing.
  The bar is the runtime's own bar, so anything the resolver treats as "maybe" is
  a silence. A file's module system comes from its extension first, then from
  **ESM syntax, which is conclusive either way** — whether the nearest `type`
  field says `module` or `commonjs`, `require()` cannot load that file, which is
  exactly the claim. A bundled file with neither import/export nor `require` is
  *unknown* and judged not at all. Conditions are tracked **structurally** as the
  map is walked, so a subpath named `./require` is never read as a condition.
  Bare-specifier targets belong to the package they name, `null` targets are
  deliberate blocks, `types`/`typings` targets are never judged for module system,
  and a `.` export carrying only `types` cannot disagree with `main` — it names no
  runtime file. Exits 1 on any finding. Zero findings on this project's own
  manifest.

### Diagnostics — detached child processes (§195)

- **`no-detached-child-without-unref`** (Reliability, warn, opt-in) —
  `detached: true` without `unref()`. Detaching puts the child in its own process
  group so it can outlive the parent, but the parent's event loop still holds a
  reference to it: the parent **cannot exit** until the child does. A CLI that
  spawns a detached background worker and then finishes its work simply hangs —
  no error, no output, and in CI a job that runs to its timeout. It is the exact
  opposite of what the author asked for.
  The claim is "this handle is never unref'd", so every way it could be is a
  silence. The spawner must be **proven by import** (`spawn` is also `cross-spawn`,
  test helpers, and userland process pools), `detached` must be **literally**
  `true` — a variable, a ternary, or a spread *after* the key that could overwrite
  it all abstain — and the result must be bound to a plain local. `unref()`
  anywhere on that binding ends the claim: a later line, a callback, a guard, a
  `finally`, optional chaining, or a computed member that could *be* it. A binding
  that escapes (returned, passed, stored, aliased) may be unref'd out of sight and
  is never reported.

### Hallucinated-API detection — `node-doctor api-check` (§206)

- **`node-doctor api-check [dir]`** (aliases `hallucinated`, `check-api`) — a
  member used on a package that the package does not export. `import { readJson }
  from "fs-extra"` when the export is `readJSON` is **not a compile error** in
  JavaScript: the import is `undefined` and the failure is a `TypeError` on the
  first request that reaches the line. It is the commonest way agent-written code
  is wrong, and no existing check sees it — the type checker only if the package
  ships types *and* the project is strict, the linter never, the test suite only
  if that path is covered.
  Reuses §175's export-surface comparison and §155's `complete` flag. **Abstains
  for the whole package** the moment the surface is not fully readable — a
  partially-read surface makes every absent name suspect — with a stated reason
  for each: not installed (so "I did not look" never reads as "clean"), an
  unfollowable `export *`, a runtime-built `module.exports`, a types-only entry
  (a `.d.ts` is a claim about the runtime, not the runtime), a **dual ESM/CJS
  package whose entries export different names**, and any computed access.
  Aliased imports are checked under their source name, a local binding shadows
  the namespace import it collides with, and members off a *default* import are
  not the named-export set. Exits 1 on a finding. Zero false claims across this
  project's 407 files.

### Diagnostics — worker-thread clone boundary (§190)

- **`no-unclonable-worker-message`** (Bugs, error, opt-in) — a function literal
  in a `postMessage` payload. `postMessage` runs the structured clone algorithm,
  which throws `DataCloneError` on a function — synchronously, at the call, on
  whichever path carries the callback.
  The algorithm's rules are mostly undecidable from syntax (a `Map` clones, a
  `Proxy` throws, a class instance loses its prototype), so the rule claims only
  the decidable case. The receiver must be a **proven worker-thread port** — a
  binding from `new Worker(…)` imported from `node:worker_threads`, or
  `parentPort` — because `postMessage` is also on a `BroadcastChannel`, a
  `MessagePort`, a browser `window` and userland emitters, and the browser's has
  a different remedy. A bare identifier in the payload is never flagged, and the
  walk stops at any nested function's body, which is not part of the cloned
  structure. Zero findings across this project's 430 files.

### Diagnostics — peer-consistency (§164)

- **`no-peer-inconsistent-handler`** (Reliability, opt-in, `confidence: medium`) —
  a route handler that skips the wrapper its peers on the same router all use.
  The codebase states its own convention nineteen times; the twentieth handler
  that breaks it is a finding no fixed ruleset could anticipate. An unwrapped
  async handler that rejects never reaches the error middleware, and on Express 4
  the request hangs until the client times out.
  This is **the only statistical rule in the catalog**, and an adversarial hunt
  confirmed **fifteen** ways the first version got it wrong — every one tracing
  to the same root, that the population was not actually provable. The corrected
  model: the receiver must be a **proven Express router** (bound from `Router()`
  or `express()`, so Koa, Fastify and any `.get(path, fn)`-shaped HTTP client or
  cache are excluded); the group is keyed on the **resolved binding, never the
  name** — the hunt's sharpest repro had four route factories holding 3+3+3+1
  routes merge into a *fabricated* population of ten in which no individual
  router qualified at all, and the flagged route had zero peers; the minimum
  group is **10**, because at 90% conformity a smaller one can never produce a
  deviant (the documented 5 was arithmetic that could not happen); the wrapper
  must take **exactly one argument that is a function**, so `makeHandler(db,
  path)` — a handler factory, not an error wrapper — no longer turns every
  factory-style router into a wall of findings; and the outlier must be
  **provably able to reject**, which excludes a bare identifier (may be wrapped
  where it is defined), a synchronous handler, and one whose whole body is a
  `try`/`catch`. Reported at `confidence: medium` because it is strong evidence
  rather than proof. Zero findings across this project's 426 files.
  The middleware variant (`requireAuth` on 19 of 20) is **deliberately not
  shipped**: it has legitimate outliers by design, and "everyone else
  authenticates" is exactly the wrong thing to say about the login endpoint.

### Supply chain — `node-doctor supply-chain` (§69)

- **`node-doctor supply-chain [dir]`** (aliases `deps`, `install-scripts`) — two
  supply-chain facts readable with no network and no vulnerability feed.
  **What runs when you install:** a `preinstall`/`install`/`postinstall`/`prepare`
  script executes arbitrary commands on every developer laptop and CI runner
  before any of your code does, and `npm ls` will not tell you which packages have
  one. Read from `node_modules`, because the manifest declares ranges and *which
  version actually got installed* is the fact that matters — and **when
  `node_modules` is absent the report says the check did not run**, never "none
  found". **Where it came from:** a lockfile entry resolved from a git ref or an
  http tarball skips the registry's immutability and integrity guarantees.
  Neither is an accusation — a postinstall script is how `esbuild` fetches its
  binary — so the rendering deliberately avoids the finding vocabulary. Exits 0.
  Typosquatting is **not** shipped: it is an edit-distance guess against a
  popularity list, the exact class of statistical claim this project has
  repeatedly found to be its own worst false-positive source.

### Diagnostics — test-reality drift (§175)

- **`no-mock-of-missing-export`** (Maintainability, project scope, opt-in) — a
  `jest.mock`/`vi.mock` factory that stubs a member the real module does not
  export. A test mocks `./services/user` and stubs `getUser`; the real export is
  renamed to `fetchUser`; nothing fails, the suite stays green, and the test now
  exercises a stub of a function that does not exist.
  The claim is "that module does not export this name", so the rule abstains for
  the **whole mock** whenever the export surface cannot be enumerated: a
  non-relative specifier, a target not in the graph, an `export * from` (a barrel
  is nothing but those), a CommonJS surface built at runtime, a module with no ESM
  exports, or a factory that spreads — which is exactly how a partial mock is
  written. Silent across this project's own 431 files.

### Fixed — `--cache` had never hit

- `scanProject` wrote its cache store with a hardcoded `version: 1` while
  `loadCache` accepts only `CACHE_VERSION`, which became `2` when suppression keys
  were added. Every `--cache` run therefore wrote a store the next run silently
  discarded, and the cache had been a no-op since. Found by the §83 adversarial
  hunt; `CACHE_VERSION` is now exported and used at both ends, and a round-trip is
  covered.

### Fixed — a nonexistent scan target scored 100/100

- `node-doctor /typo` globbed nothing, analyzed nothing, and printed **100/100
  healthy with exit 0** — the most dangerous output the tool can produce. Same for
  `architecture` and every command routing through `resolveScanTarget`. A target
  that is not a readable directory is now a usage error (exit 2, no stack trace),
  and in `--json` mode a well-formed `ok:false` report.

### Hardening from the §83 adversarial hunt

- **Wrong facts in the deprecation table, again.** `util.debug` was listed as
  removed in Node 12 — it exists and works on Node 20 and 22 (the name survives as
  an alias of `util.debuglog`), so the entry is **removed**. `url.parse` and
  `url.resolve` are DEP0169 **Application** scope, not Runtime, so the message no
  longer claims they "print a warning on every call". The two `crypto.createCipher`
  entries carried their documentation-only date in a field documented as "when the
  current status began". `domain.create` now carries DEP0032 rather than an empty
  string.
- **The matcher ignored lexical scope.** Resolving the receiver only through the
  top-level import map meant `function f(util) { util.isString(x) }` and a local
  `const fs = makeFs()` both fired — a parameter named like a builtin is somebody
  else's object. It now resolves the binding at the node. Conversely,
  `import process from "node:process"` silently disabled *every* `process.*` entry;
  that import binds the same object and is now accepted.
- **`node-upgrade`'s redundancy gate had nine holes**, each turning a real usage
  into a confident "safe to delete": a re-export (`export { v1 } from "uuid"`, and
  the `export *` forms), a dynamic `await import("uuid")`, a computed
  `import(name)`, a member-call require (`require("dotenv").parse(…)`), an options
  object hoisted into a variable, a glob built from a template literal, a negation
  pattern inside an array, `dotenv-expand` sitting alongside `dotenv`, and a file
  that failed to parse. Enumerating usage forms is a losing game, so **the gate is
  inverted**: any file that mentions the package in a form the collector did not
  positively parse abstains for the whole package, and the report names the file.
  An argument that cannot be evaluated is now "unknown options", not "no options".
  A workspace root says its packages were not assessed; a `--target` past the
  newest known release says the answer is "nothing known to have been removed so
  far", not "nothing breaks".
- **`architecture.modules` states what it counts.** Fan-in/fan-out are static ESM
  `import … from` edges — the same graph `hubs` and `no-circular-imports` use — so
  they under-count `require`, dynamic `import()`, bare side-effect imports and
  `export … from`. Under-counting is the safe direction for a ranking, but a
  consumer treating them as a complete census would be wrong, so the limit is
  stated rather than implied.

### Node upgrade planning — `node-doctor node-upgrade` (§83)

- **`node-doctor node-upgrade [dir] [--target <major>]`** (aliases `upgrade`,
  `node-version`) — the two questions a team asks before bumping the runtime.
  **What breaks:** which APIs this code calls are *gone* at the target major.
  Delegated to `no-deprecated-node-api`, and only its `end-of-life` entries
  count — a runtime deprecation warns, it does not break, and reporting it as a
  break is how a team decides not to upgrade for a reason that is not real.
  **What you can delete:** which dependencies the target runtime ships natively.
  Every entry carries a **version window rather than a `>=`** (Node backports
  stabilizations to the previous LTS, so `--env-file` is stable on 22.21 and
  24.10 but *not* on 23.x), **call-site evidence** (`uuid` only if every import
  is v4, `rimraf` only if no call passes options or a glob, `dotenv` only if
  nothing calls `parse`), a **direct-dependency requirement** (`glob` and
  `abort-controller` are transitive in a huge share of tooling), and a **caveat
  that always prints** — "you can delete node-fetch" is only true with
  "…unless you pipe `res.body`" attached. A browser or React Native target
  suppresses the `fetch`/`AbortController` entries outright. Exits 1 on a break,
  0 on an opportunity.

### Fixed — `no-deprecated-node-api` was making wrong version claims (§83)

- An audit against Node's own `doc/api/deprecations.md` found the shipped table
  **overstating four different ways**, each of which put a false claim in front of
  a user with a version number attached:
  - **`new Buffer()` was described as "deprecated and removed".** It has never
    been removed and is alive on `main`; it is application-scope deprecated
    (DEP0005) and warns outside `node_modules`.
  - **`crypto.createCipher` was dated "Node 10"** — its *documentation-only*
    date. The removal was **Node 22**, which is the fact that matters.
  - **`util.isFunction` / `util.isNullOrUndefined` were dated "Node 4"** and are
    removed as of **Node 23**.
  - **`url.parse` cited a deprecation Node later REVOKED** (DEP0116). The current
    citation is DEP0169, runtime as of Node 24.
  Every entry now carries a **status** — `end-of-life`, `runtime`, `application`,
  or `documentation-only` — and the message says which. Only an end-of-life entry
  may claim "this breaks when you upgrade"; a documentation-only one now states
  that no removal is scheduled. The table grew from 13 entries to 39, all
  verified against Node's deprecation list, and the receiver is resolved through
  the **binding** rather than assumed from the local name, so
  `import nodeUtil from "node:util"` is no longer silently missed.

### Report data — per-module analysis without a new command (§35)

- **`ScanReport.project.files`** — per-file line counts (**schema v3**, additive).
  The scan summed them away, so a consumer could group findings by directory but
  had no denominator: "which module is worst" was unanswerable from the report.
- **`ArchitectureReport.modules`** — every module's fan-in *and* fan-out.
  `hubs` deliberately cuts at a threshold and a top-10 slice, which makes it
  unusable as a data source; both numbers were already in scope.
- A `metrics` **command was assessed and deliberately not shipped**: every
  per-module claim about findings is already derivable from `scan --json` plus
  the exported weight constants, and a 33rd command that repackages existing JSON
  is not a feature. A per-module *score* is also withheld — at 100 weighted
  points/kLOC one Security error in a 60-line file scores 0/100, and without a
  minimum-lines floor that is a false positive wearing a number.

### Assessed and not shipped — Bun/Deno runtime diagnostics (§94)

- Researched against both vendors' current compatibility pages and rejected on
  three grounds: the `bun` capability turns on from a lockfile, and Bun's largest
  use is as an npm client *for apps that ship on Node*, so the rule would tell the
  majority of Bun users their runtime is broken; both compatibility tables are
  regenerated continuously toward *closing* gaps, so a table baked into a release
  decays into false positives (Node's deprecation list, by contrast, is
  append-only history); and the two runtimes differ on the same module in opposite
  directions — `cluster` and `trace_events` work on Bun and are stubs on Deno — so
  any merged message is wrong about half the time. Detection stays Core; the
  diagnostics stay unshipped rather than shipped stale.

### Suspicious change shapes — `node-doctor change-shape` (§159)

- **`node-doctor change-shape [--diff <base> | --staged]`** (aliases `diff-shape`,
  `risky-edits`) — some edits deserve a second pair of eyes because of their
  *shape*, regardless of whether the code is correct, and a reviewer cannot spot
  them in a 400-line diff. Four shapes: a **`.env.example` key removed** (every
  developer who clones tomorrow is missing a variable nobody told them about), a
  **dependency un-pinned** (the build stops being reproducible and a compromised
  release lands without a code change), a **very small edit to the auth path**
  (the shape most changes to a security boundary actually take), and a
  **migration edited alongside feature work** (reverting the commit takes the
  schema change with it).
  **It emits no findings and does not score.** The output vocabulary is a third,
  separate one — *review priority* — because "this edit is unusual" and "this
  code is wrong" are different claims, and conflating them would make every
  finding in the tool mean less.
  Shapes that cannot be decided from diff text were cut rather than approximated:
  "this character class got wider" is regex-language containment, "the auth check
  got weaker" needs both sides parsed (which is what §87's baseline delta already
  does), and an N≠M hunk has no sound line pairing.
  Built on a new `src/core/git-history.ts` — shared git plumbing plus a unified-
  diff parser, the module §160/§163/§184 have each been open-coding.

### Diagnostics — comment-code contradiction (§178)

- **`jsdoc-param-mismatch`** (Maintainability, §178, opt-in) — a JSDoc block that
  documents a `@param` the function does not have. The rename happened; the doc
  did not. It matters more every year: a coding agent cannot tell a stale doc from
  a current one and will generate calls that match the comment rather than the
  signature.
  Almost all the precision is in the *association* between a comment and the node
  it documents. The block must sit immediately above the declaration, separated by
  at most one newline (a module header two blank lines up is not the first
  function's documentation), with no other comment between, and not on the same
  line as the previous statement. Every parameter must be a plain identifier, every
  `@param` name a bare identifier, and the function's name unique in the file —
  a TypeScript overload set puts one JSDoc above several declarations that differ
  in parameters. A parameter with *no* `@param` is deliberately not reported: that
  is incomplete documentation, not a contradiction. Silent across this project's
  own 428 files.
  `DiagnosticContext` gains a `comments` field (public API, additive) — comments
  are not part of the AST, so a rule comparing what a comment claims against what
  the code does has to be handed them separately.
  The other four §178 sub-cases were assessed and **dropped**: `@returns {null}`
  versus "every path throws" needs path-sensitive completion analysis; the
  magic-number comment is unfalsifiable (the same `// 30 second timeout` is correct
  beside `30_000` under ms and beside `30` under seconds); `// TODO: remove after
  v2` needs a project version the analysis path does not carry; `@deprecated` still
  imported is a migration-progress signal rather than a contradiction.

### Locale integrity — `node-doctor i18n` (§181)

- **`node-doctor i18n [dir]`** (aliases `locales`, `l10n`) — a key referenced with
  no entry ships a blank string, or the raw key, to a user, and nothing in the
  build fails. A placeholder renamed in the translation but not at the call site
  renders `Hello {{userName}}` verbatim in production. Neither is visible in a
  review of either file alone.
  Three proof obligations before a key is called missing: **the file must be proven
  i18n code** (`t("x")` is the most ambiguous call shape in JavaScript — a test tap,
  a tagged template, a Lodash chain), **the key must be static**, and **the locale
  file must be proven a locale file** (`**/*.json` would swallow tsconfig,
  package.json, fixtures and OpenAPI specs). Namespaces, plural and context
  suffixes, string and object defaults all resolve first.
  **Dead-translation detection is deliberately not shipped**, and the report says
  so rather than returning an empty list: a key is reachable from `<Trans i18nKey>`,
  from a `.vue`/`.svelte` template, from a prop-drilled `t`, and from `$t()` nested
  inside another string — none of which this can see, and the action on a wrong
  claim is to delete copy a user reads.
  **"Hardcoded user-facing strings" is dropped and will not ship.** No static
  property distinguishes a user-facing string from a log message, an error code, a
  SQL fragment or a test fixture; every candidate gate misfires in both directions.
  Whether a string is user-facing is a natural-language judgement.

### Hardening from the §159/§178/§181 adversarial hunt

- **`change-shape`**: the auth vocabulary flagged twelve of eighteen ordinary paths
  — a retry *policy*, a Vue route *guard*, a *session*-storage helper, an *admin*
  dashboard — so `policy`, `session`, `guard`, `admin`, `role`, `permit` and `can`
  were cut; git's `@@` heading is a *guess* at the enclosing function and no longer
  gates anything; `dependency-unpinned` fired on npm scripts, `engines` and
  `repository` metadata, so the manifest is now read and the section is a fact;
  un-pinning two dependencies at once is now reported (positional pairing when the
  counts match); a key moved between template files or commented out is no longer
  a "removal"; a migration and its own test are one change, not mixed work; and
  untracked files are counted so a green working-tree result cannot read as
  "everything was looked at".
- **`git-history`**: an unresolved merge produces a combined diff whose body is not
  unified format — it was parsed as zero hunks and reported as a clean change set,
  and is now refused explicitly; a diff over the buffer limit was returned as a
  *successful* truncated diff, and now fails loudly; `diff.mnemonicPrefix`,
  `diff.noprefix` and `diff.srcPrefix` are pinned, because any of them silently
  corrupts every path; a file with no `---`/`+++` lines keeps its path; and a bare
  repository is reported as "not a git work tree" rather than "not a repository".
- **`jsdoc-param-mismatch`**: `@callback`, `@typedef`, `@event` and the *named*
  forms of `@function`/`@name`/`@method` declare a subject of their own — a
  `@callback` typedef placed directly above its single consumer is ordinary style,
  and its `@param` tags described the consumer's signature, which made the message
  literally false and its recommendation ("delete the tag") destructive. Also:
  indented nested `@param` tags describe properties, and a computed method key is
  no longer used as the function's name.
- **`i18n`**: `{{count}}` — the commonest i18next placeholder — was reported as
  never supplied on every plural string, because reserved options were filtered out
  of the *supplied* set instead of the *required* one. i18next v4 plural
  catalogues (`item_one`/`item_other` with `t("item")` at the call site — the
  default layout since v21) reported *missing* and reported the real plural keys
  *unused* in the same report. A string second argument (`t(key, "Fallback")`) is a
  default, not options. One array value discarded an entire catalogue file. Single-
  brace `{name}` matched ordinary prose. Any `x.t(...)` was asserted to be a
  translation. `useTranslation(ns, { keyPrefix })` reported every key in the file
  as missing. `en` was forced as the source of truth even when it was a partial
  translation. All fixed; unused-key detection removed entirely.

### Operational readiness — `node-doctor readiness` (§182)

- **`node-doctor readiness [dir]`** (aliases `ops`, `launch-review`) — "can this be
  run in production", which is not the question the health score answers. Nine
  dimensions (graceful shutdown, health/readiness probes, request correlation,
  failure logging, outbound timeouts, route error handling, no hard exit on a
  request path, container resource limits, retry/timeout policy) rolled up from
  diagnostics and reports that already ship. **It adds no new detection**; what is
  new is the aggregation and the honesty model around it.
  That model is the whole design. A checklist where "no finding" means "pass" is a
  lie: `require-sigterm-handler` only fires in a file that binds a port, so a repo
  with no server produces zero findings, and rendering that as *graceful shutdown:
  PASS* tells an SRE the opposite of the truth. Each dimension therefore carries
  four verdicts — **ready**, **gap**, **not applicable**, **not proven** — and only
  the first two touch the score. The other two are excluded from the denominator
  and printed with their reason, applicability is established independently of any
  finding (a pass that looks for the port binding, the signal handler and the
  manifests directly), and a repository where nothing could be assessed scores
  **`null`, not 100**. A rule the user disabled makes its dimension *not proven*
  rather than silently passing — `scanProject` gained an `onDiagnosticsSelected`
  hook so the report can tell "found nothing" from "never ran".
  Deliberately not the health score's arithmetic: that is a per-kLOC density model,
  and a five-line service and a 500-kLOC service with no SIGTERM handler are equally
  unshippable. Passed-over-applicable instead, with the same 75/50 label thresholds.
  Always exits 0 — it rolls up opt-in heuristics, and a heuristic must not fail
  somebody's build on its own.
  An adversarial hunt then found ten ways the first version broke its own honesty
  rule, each fixed: §151 returns `na` for a check it could not evaluate, and those
  were folded into "ready" — an Express app with zero logging, zero error handling
  and zero timeouts scored **100/100**, so a dimension now needs at least one route
  to actually PASS. Evidence was read from test files and fixtures, so a SIGTERM
  handler in a supertest file made a handler-less server "ready" — evidence now
  skips non-production paths and requires the handler and the port binding **in the
  same file**, and the engine's own gap finding outranks positive evidence found
  elsewhere. The gap finding is in turn corroborated against a port-shaped
  `.listen(...)`, so a worker whose only `listen` is an in-process bus
  subscription is no longer told its server cannot drain. Probe routes come from
  the route extractor rather than the observability table, because that table
  omits handlers written `(_req, res)` — which produced the categorical claim "no
  probe endpoint" for a repo that had one. `/live` and `/status` moved from the
  probe vocabulary to an *ambiguous* tier (a video app's `/live/:channel` scored
  100/100 on that alone). A dimension whose proving rule was disabled no longer
  flips gap→ready. Unparseable files turn "we found no server" into *not proven*.
  The `onDiagnosticsSelected` hook now fires for the whole-tree text phase too, or
  the k8s resource-limits dimension reported "did not run" even when the rule ran
  **and fired**. And a path that is not a directory exits 2 instead of printing a
  page of confident negatives about a repository nobody read.

### Diagnostics — resource lifecycle (§165)

- **`no-unreleased-resource`** (Reliability, §165, opt-in) — a pooled Postgres
  client checked out and never returned, a Mongo session never ended, an
  OpenTelemetry span never closed, a mutex permit never given back. The pg case is
  the canonical silent outage: ten error paths skip `release()`, and the eleventh
  request — and every one after it — waits forever for a connection that is not
  coming back. Nothing crashes and nothing logs.
  **Not the paired-verb checker the plan called for.** A table of verbs
  (`acquire`/`release`, `open`/`close`) is a false-positive machine: `close` is
  files, modals, dropdowns and RxJS subjects; `end` is `res.end()` on every Express
  route; `connect` is React-Redux; `release` is semver. A verb is a word, not a
  contract. Every firing is instead anchored to a **documented library contract,
  proven by binding from the import down** — the package is imported in this file
  under whatever alias, the receiver is bound from that import, the acquire is the
  contract's method on that receiver, and the release appears nowhere in the
  binding's lifetime. Silent on escape (any use other than `binding.<prop>` means
  the release may happen out of sight — a whitelist, not an enumeration), silent at
  module scope, and silent on *any* mention of the release anywhere: proving it runs
  on every path needs a control-flow graph this engine does not have, while proving
  it is absent needs nothing but syntax. Zero findings across this project's 410
  source and test files.
  An adversarial hunt found the first version doing exactly what its own header
  forbade: it kept a flat name→contract map, so one `const pool = new Pool()`
  anywhere in a file made **every** `pool` in that file a pg pool — a parameter of
  another type, a `for (const pool of pools)` loop variable, a local in an
  unrelated function — each producing a message naming a library the code did not
  use. The receiver, the factory and the acquired value are now each resolved to a
  `Binding` and compared by reference, which also stops a lazy `require("pg")`
  inside one function from binding the name file-wide. Four more fixes from the
  same hunt: the lifetime region is the enclosing **function** rather than the
  nearest block (a `var` acquired in a `try` and released in the matching
  `finally` was reported as a leak — the rule firing on the exact fix it
  recommends); `using` / `await using` dispose by language rule and are silent;
  the `Semaphore` contract was **removed** because its `acquire()` resolves to a
  `[value, releaser]` tuple, so the `release()` the message prescribed would throw;
  and per-region reference indexing replaced a per-declarator rescan that took 35
  seconds on a 180 KB file (now 246 ms).

### Diagnostics — unreachable guarantees (§166)

- **`no-floating-promise-in-try`** (Bugs, §166, opt-in) — a `try`/`catch` that
  structurally cannot catch what it appears to guard. An `async` function never
  throws; it returns a promise and signals failure by rejecting it. So
  `try { sendReceipt(order); } catch (err) { … }` is not error handling — the call
  returns immediately, the `try` completes normally, and the later rejection finds
  no handler on the stack, so Node raises `unhandledRejection`, which terminates the
  process by default. The worst kind of defect: it *looks* handled.
  Precision: the callee must be a plain identifier resolving through the scope chain
  **in this file** to a declaration marked `async` — a `const` or a function
  declaration, never a parameter, an import, a method call, or a `let` that may hold
  something else by the time the line runs. The result must be discarded (awaited,
  returned, assigned, `void`-ed and `.catch`-chained are all deliberate), and the
  statement must sit in the `try` block with no function boundary between. The
  message names the specific call rather than calling the catch dead — the `try` may
  be protecting its other statements perfectly well.
  Three hunt fixes: the name must be declared **exactly once** in the file, because
  the scope resolver models no block scopes and defines first-wins, and a
  block-scoped `const send = async …` made the rule flag a call that invoked a
  synchronous `send` from another scope; a callee whose entire body is one
  `try`/`catch` that swallows everything **cannot reject**, so claiming its
  rejection escapes would be false; and the message no longer says the `try`
  "completes before it settles" (untrue when the block awaits afterwards) — the
  accurate claim is that the failure is never *propagated into* the try.

- **`no-unreachable-cleanup-after-exit`** (Bugs, §166, opt-in) — statements after
  `process.exit()`, which never run. `no-unreachable-code`'s terminator table is
  keyed on statement *type*, so it structurally cannot express a call-shaped
  terminator, and extending it would shift a default-on rule's findings and evidence
  keys for every existing user. The dead statements here are almost always the
  cleanup — `server.close()`, `await db.end()`, `logger.flush()` — so the cost is
  truncated responses on every deploy and logs that stop just before every incident.
  Reuses `no-unreachable-code`'s hoisting and TypeScript-erasure exemptions verbatim
  from the same exported helper, so the two cannot drift apart.
  **It found a real one in node.doctor itself on its first run:** the Windows UTF-8
  console fix sat below `process.exit()` in `exitAfterFlush` and had never once
  executed. Moved to `hardenProcess()`, where it runs before anything is written.
  Six hunt fixes, each a case where the statements below the call do run: a local
  or dependency-injected binding named `process` is not the global; a file that
  reassigns `process.exit` has stubbed it, and test files are skipped outright for
  the same reason; a `return`/`throw` above the exit means the exit itself never
  runs and `no-unreachable-code` owns the tail; `break`/`continue` after an exit
  are dead but are not cleanup, so "move it above the exit" is wrong advice; the
  message quotes the call that is actually written (`abort`, not `exit`); and class
  `static {}` blocks are now scanned.

- The four sub-cases §166 also named were **dropped rather than shipped soft**: "a
  `finally` after a `return`" is semantically backwards, "a retry after a `throw`"
  is already `no-unreachable-code`, and "a validation downstream of an early return"
  and "a default parameter always supplied by callers" need every-path reachability
  and whole-program call-site enumeration respectively — proofs this engine does not
  have. Shipping any of them would have meant guessing.

### Engine hardening

- **CODEOWNERS files with CRLF line endings no longer invent owners.** JavaScript's
  `.` does not match `\r`, so the comment-stripping `#.*$` could not anchor on a
  Windows-authored line — the comment survived and every `@handle` mentioned
  inside it (`@core # was @legacy, do not ping them`) was resolved as a real
  owner, routing findings and review requests to people deliberately named as
  *not* responsible. Lines are now split on both endings.

- **A file nested past the parser's stack limit no longer kills the scan.** A
  stack overflow inside the native parser is a SIGSEGV: the process dies with no
  output, no partial report, and no `try`/`catch` that can intercept it — one
  machine-generated file took the whole run with it. Depth is now measured on the
  raw text before the parser sees it, and such a file is reported as an ordinary
  parse failure (named, with its reason, and `complete: false`) while the rest of
  the project is analyzed normally. The pre-scan skips strings, template literals
  and comments so brackets that are not structure cannot trip it.

### Diagnostics — debuggability (§183)

- **`no-error-cause-discarded`** (Reliability, §183, opt-in) — a catch that binds
  its error and then throws a new one without it, destroying the stack and type
  of the real failure. The log ends up saying "failed to load user" with no
  thread to pull at 3am. Silent whenever the author kept the evidence in any
  form: `{ cause: err }`, the error in any constructor position, interpolated
  into the message, or simply logged before the re-throw — and on a bare
  `catch {}`, which never had a cause to lose. Zero findings across this
  project's own 339 files.

### Blast-radius review routing — `node-doctor review` (§163)

- **`node-doctor review <files…> | --diff <base>`** (alias `routing`) — turns
  "who should review this?" from a guess into a graph query. Joins the import
  graph (§120) with CODEOWNERS (§89) and hub detection (§33) to report the blast
  radius, the handler-bearing files downstream, the reviewers — owners of the
  change **and of everything downstream**, so people whose code it can break
  actually see it — and a review level (light / standard / senior). The level is
  derived from counted facts (reach ≥ 5 → standard; reach ≥ 25 or any hub module
  → senior) and every threshold that fired is printed, so escalations are
  auditable. Adds no findings. A changed file the graph cannot see is reported as
  *unknown* reach, never as safe.
  A follow-up hunt caught the one soft input: request-handler detection matches
  the `(req, res)` **shape**, so a middleware factory counts as readily as a
  route, and ten of them used to force a *senior* escalation — a claim on a
  person's time made on a guess. Handler-bearing files now raise a light review
  to standard and never escalate further on their own; reach and hub status,
  both exact graph facts, remain the senior triggers. The field is renamed
  `handlerBearingFiles` to say what it counts (`routesAtRisk` is kept as a
  deprecated alias so existing JSON consumers keep working).

### Churn-weighted risk — `node-doctor churn` (§160)

- **`node-doctor churn`** (alias `hotspots`) — git history answers what the
  snapshot cannot: which findings sit in code that many hands have edited
  recently, which is where regressions cluster. Reports churn hotspots, flags
  **refactor magnets** (source churning far above the project baseline), and
  re-ranks findings by the churn of their file. **Structurally incapable of a
  false positive**: it adds no findings and removes none — the ranking is a
  permutation of the analyzer's own output. (The *magnet* list needed a fix an
  adversarial hunt found: in a shallow checkout — the `actions/checkout` default
  — every file has one commit, ties at score 100, and the whole tree was named a
  hotspot. Magnets now require an unshallow repo with ≥ 10 commits scanned and
  ≥ 3 commits in the file; a thin history suppresses the claim and says why.) Scores normalize volume, author
  spread and recency against the project's own distribution; recency is in
  commits-ago, not days, so output is deterministic. Docs, lockfiles and
  generated artifacts are excluded from magnets (they churn by design). With no
  git or no history, scores are 0 and the original order is preserved exactly.
  Also fixed: `git log` prints repository-root-relative paths while findings are
  scan-root-relative, so pointing the tool at a subdirectory
  (`node-doctor churn packages/api`) joined nothing — every weight silently
  became 0 while the report still called itself available. Paths are now rebased
  via `git rev-parse --show-prefix`, and history outside the scanned directory is
  excluded rather than mis-attributed.

### Architecture analysis — `node-doctor architecture` (§33)

- **`node-doctor architecture`** (aliases `arch`/`layers`) — import cycles, layer
  violations and hub modules from the project import graph. Cycles are found
  exactly (iterative Tarjan SCC) and exit non-zero: under ESM a cycle means a
  module observes another mid-initialization — an `undefined` import at module
  scope, a class extending `undefined`, a TDZ `ReferenceError` that surfaces only
  when the entry point changes — and it defeats tree-shaking. Layer violations
  cover a service/domain module importing back *up* into routes and a route
  skipping the service layer into a repository; they fire only when both files
  sit in an unambiguous layer directory, so a project without a layered
  convention (or a path naming two layers, like `services/db/`) produces no
  claims at all. Hub modules (high fan-in) are informational. Deterministic.

### OpenAPI generation — `node-doctor openapi` (§77)

- **`node-doctor openapi`** (aliases `swagger`/`spec`) — an OpenAPI **3.1** spec
  generated from the actual route registrations (same collector as `data-map` and
  `surface`, so all three agree on what a route is). Derives path parameters,
  query parameters (`req.query.x`, `req.query["x"]`, destructured), request-body
  presence, response status codes from `res.status(N)`/`res.sendStatus(N)`, and
  security from the auth middleware chain. Honest by construction: a body is a
  free-form object rather than an invented schema, a dynamic status code or route
  path is skipped and *counted* rather than guessed, and duplicate registrations
  union their facts. Deterministic output (paths sorted, methods in fixed order)
  so the spec can be committed and diffed — which is what keeps docs from drifting
  from the code in CI. Prints to stdout by default; `--json-out <f>` writes the
  spec and prints a coverage summary.

### Diagnostics — scheduled jobs & websockets (§30/§31)

Both rules were hardened against an adversarial false-positive hunt before
shipping: `no-invalid-cron-expression` now resolves the call **receiver** to a
binding a cron package was imported into (a Joi/zod/ajv `.validate("2026-01-01")`
and a domain object's `.schedule()` are no longer scheduler calls), understands
node-schedule's `scheduleJob(name, spec, fn)` overload so a job **name** is never
read as an expression, anchors the BullMQ `{ repeat: { pattern } }` shape to a
proven queue binding, and accepts month `0` (the `cron` package used zero-based
months before v3). `no-missing-websocket-error-handler` now requires the **file**
to import `ws` (an `http.Server` connection, a socket.io handler, a pg client and
a test double are otherwise indistinguishable), follows chained registrations
(`socket.on(a).on("error", h)`), accepts `socket["on"]("error", h)` and
`socket.onerror = fn`, and stays silent when a second connection handler on the
same server could attach the listener.

- **`no-invalid-cron-expression`** (Bugs, §30, opt-in) — a scheduled job whose cron
  expression can never fire: an out-of-range field (`"0 25 * * *"`), the wrong
  field count, a reversed range, or a zero step. Most schedulers throw at startup
  (taking the process down on deploy); the rest silently never run the job, and
  neither review nor the type checker catches it because it is a string. Parsed
  only at recognized scheduler call sites (node-cron, node-schedule incl. the
  `(name, expr, fn)` form, `new CronJob`/`{ cronTime }`, croner, BullMQ/Bull
  `{ repeat: { pattern | cron } }`) behind an import gate, and only a static
  string. `@daily` macros, month/day names and the Quartz extensions
  (`L`/`W`/`#`/`?`) are deliberately unmodelled and never claimed invalid.
- **`no-missing-websocket-error-handler`** (Reliability, §31, opt-in) — a `ws`
  connection handler that registers `message`/`close` but no `error` listener. A
  socket is an EventEmitter, so an `error` event with no listener is re-thrown as
  an uncaught exception: one client vanishing mid-frame kills the process and
  every other connected socket. Fires only when the socket parameter is a plain
  binding with at least one statically-named registration here and no `error`
  one, and never when the socket escapes (passed to a helper, stored, returned)
  or uses a dynamic event name — the error path may then live out of sight.

### Package API semver lint — `node-doctor semver` (§155)

- **`node-doctor semver`** (aliases `api-semver`/`exports`) — semver linting for
  internal package exports. Extracts each workspace package's name-level export
  surface (ESM incl. recursive relative `export *` and structure-aware
  destructuring; CJS `exports.x` / `module.exports = {…}`; `dist/` entries fall
  back to their `src/` twin), snapshots it with `--baseline`, and lints changes:
  a removed export without a major bump (or a 0.x minor) exits 1; additions with
  an unchanged version are advisory. Hardened against an adversarial hunt: the
  surface is `complete` only when every export mechanism in the module was
  understood, so an unfollowable `export *`, an ambiguous two-star name, an
  opaque/spread `module.exports`, `Object.assign(module.exports, …)`, tsc's
  `__exportStar`, `Object.defineProperty(exports, …)`, and chained or
  block-nested `exports.x =` all mark it partial — and a partial surface never
  yields a removal claim. A *declared* entry that will not resolve leaves the
  package unanalyzed instead of falling through to a conventional guess,
  directory-form `main` resolves to its `index.*` as Node does, and a
  `types`/`.d.ts` condition never wins over a runtime one — so a packaging-only
  refactor is never reported as a breaking release. A removed package is info
  (no version left to lint). Deterministic, offline.

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
