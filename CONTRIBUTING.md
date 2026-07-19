# Contributing to node.doctor

Thanks for helping. node.doctor lives or dies on **trust**, so the bar for a
change is precision, tests, and determinism — not diagnostic count.

## Setup

```bash
git clone https://github.com/your-org/node-doctor
cd node-doctor
npm install
npm test          # runs the native node:test suite (no build needed)
npm run typecheck # tsc --noEmit
```

The tool is authored in TypeScript and run directly during development (Node ≥
22 strips types). The published package ships compiled ESM in `dist/` so it runs
on Node ≥ 20.19 with zero cold-start transpile cost.

## The golden principle of writing diagnostics

**Write the `valid` test first and make sure the diagnostic stays silent on correct
code.** A diagnostic that fires on good code gets the entire tool uninstalled. Then add
the `invalid` test. Both are mandatory.

Run the `good-app` canary after every diagnostic — it must stay at **zero findings**:

```bash
node bin/node-doctor.js tests/fixtures/good-app --blocking warning   # must exit 0
```

## Adding a diagnostic

1. Create one file: `src/diagnostics/<bucket>/<diagnostic-id>.ts`, exporting a single diagnostic
   built with `defineDiagnostic`. Buckets: `async`, `event-loop`, `db`, `security`,
   `http`, `reliability`, `maintainability`.
2. Give it a `recommendation` that **names the mechanism** ("Use `execFile` with
   an argument array"), never "sanitize input".
3. Declare gating (`requires` / `disabledWhen`) so it never fires on the wrong
   stack. FP-prone diagnostics should ship `defaultEnabled: false` (opt-in).
4. Regenerate the registry: `npm run gen:registry`.
5. Add a valid + invalid test pair (valid first) to the bucket's test file under
   `tests/diagnostics/`.
6. Run `npm test` and the canary. Add a regression test for every false positive
   ever found.

```ts
import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName } from "../../core/ast.ts";

export const myRule = defineDiagnostic({
  id: "my-diagnostic-id",
  title: "Short headline, no period",
  severity: "error",         // "error" | "warn"
  category: "Security",       // drives scoring weight
  tags: ["injection"],
  recommendation: "The specific fix, naming the mechanism.",
  create: (ctx) => ({
    CallExpression: (node: AstNode) => {
      // …analysis via the helpers in src/core/ast.ts…
      ctx.report(node, "What is wrong, concretely.");
    },
  }),
});
```

## Non-negotiables (checked in CI)

- **Determinism.** Identical input → byte-identical output. No `Date.now()`, no
  unsorted maps in output.
- **Diagnostic isolation.** A diagnostic that throws is skipped, never fatal.
- **Honest coverage.** A parse failure is a gap (`complete: false`), never a
  silent "clean".
- **Precision over recall.** Every heuristic resolves toward silence.
- **Small dependencies.** Every new production dependency is justified in the PR.

## Commit / PR checklist

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] `npm run check:registry` passes (registry regenerated)
- [ ] `good-app` canary stays clean
- [ ] New/changed diagnostics have a valid + invalid test
- [ ] Any new dependency is justified
