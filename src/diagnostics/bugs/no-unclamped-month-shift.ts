import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { findAncestor, isFunctionLike } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";
import { isTestFile } from "../../core/test-file.ts";
import type { Binding } from "../../core/scope.ts";

/**
 * A month added by mutating the month field alone, with nothing bounding the
 * day-of-month.
 *
 *   ❌ const end = new Date(start);
 *      end.setMonth(end.getMonth() + durationMonths);   // Jan 31 + 1 → Mar 2
 *   ✅ const day = d.getDate();
 *      d.setDate(1);
 *      d.setMonth(d.getMonth() + n);
 *      d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
 *
 * `setMonth` writes the month field and leaves the day where it was. When the
 * target month is shorter than that day, the surplus spills into the month AFTER
 * the one intended. MEASURED, running each case:
 *
 *   new Date(2024, 0, 31).setMonth(m + 1)   → Sat Mar 02 2024   (skips February)
 *   new Date(2024, 2, 31).setMonth(m - 1)   → Sat Mar 02 2024   (moves FORWARD)
 *   new Date(2024, 4, 31).setMonth(m + 1)   → Mon Jul 01 2024   (June has 30)
 *
 * Note the second line: subtracting a month from March 31 lands two days LATER
 * than where it started. There is no direction in which this is safe, and it is
 * not only a February problem.
 *
 * The cost is not cosmetic. The true positives found in the corpus are dates
 * written to a database that then govern money: `credit_payment_service.ts`
 * computes a service-period end and a credit expiry this way (five sites),
 * `renewal_activation_service.ts` computes the new subscription expiry and
 * returns it as `toISOString().split("T")[0]`, and `AutoPayController` computes
 * the next charge date of a MONTHLY mandate — so a mandate taken out on the 31st
 * charges on the 2nd of the following month. Nothing throws, the value is a
 * well-formed date, and it is correct for 27 days of every month, which is
 * exactly why it survives review and then misbills in production.
 *
 * PRECISION MODEL. The corpus contains this defect AND two hand-written correct
 * implementations of the fix, in production code by the same organization. Both
 * correct ones must stay silent, and every silencer below is taken from a site
 * that was read rather than imagined:
 *
 *   - **Pre-normalized day.** `d.setDate(1)` before the shift makes the overflow
 *     impossible. `ReconciliationService.addMonths` does exactly this, with a
 *     comment naming the trap, then clamps back with
 *     `setDate(Math.min(day, lastDayOfMonth))`. Any `setDate`/`setUTCDate` with a
 *     literal day of 1–28 earlier in the same function silences the call.
 *   - **Post-clamped day.** `RazorpayWebhookService.addMonths` shifts first and
 *     repairs after — `if (date.getDate() !== d) date.setDate(0)`, which rolls
 *     back to the last day of the intended month (verified: Jan 31 plus one
 *     month, then `setDate(0)`, is Feb 29). Any day write on the same binding
 *     AFTER the shift, whatever its argument, is a deliberate day fixup.
 *   - **Two-argument form.** `setMonth(m, 1)` sets month and day atomically, so
 *     there is no intermediate day to overflow.
 *   - **A day that provably cannot overflow.** `new Date(y, m, <1–28>)`, or
 *     `new Date("2026-03-01")` / `` new Date(`${month}-01`) `` whose literal text
 *     carries the day — the `${month}-01` form appears four times in one
 *     controller. Followed one hop through a copy, because the month-boundary
 *     idiom is written `monthStart.setDate(1); const monthEnd = new
 *     Date(monthStart); monthEnd.setMonth(monthEnd.getMonth() + 1)`.
 *   - **Test and fixture paths**, where a date two days off misreports nothing.
 *
 * Deliberately NOT covered, each measured rather than assumed:
 *
 *   - **A receiver that is not a plain identifier** (`this.date.setMonth(...)`),
 *     because the clamp checks are keyed by BINDING identity rather than by name
 *     — the same choice, for the same reason, as the taint pass. Name-keyed
 *     matching would let a `d` in one function silence a `d` in another.
 *   - **`setFullYear`**, which has the identical defect on Feb 29 (verified:
 *     `new Date(2024, 1, 29)` shifted a year forward is Mar 1 2025) and the
 *     identical fix. It was implemented, measured across the corpus, and cut: 23
 *     production sites, of which 16 were year-over-year reporting windows in a
 *     single controller where a one-day drift once every four years governs
 *     nothing, against 5 that mattered. The month case triggers on three days of
 *     most months; the year case on one day in 1,461. Three of the five valuable
 *     year sites sit within four lines of a month site this rule already
 *     reports, so the file surfaces anyway.
 *
 * Complements `no-local-date-as-iso-datestring`, which deliberately removed its
 * `setMonth`/`setFullYear` branch: that rule is about rendering a local-midnight
 * instant in UTC, this one is about the shift itself being wrong in any zone.
 */

const MONTH_SET = new Set(["setMonth", "setUTCMonth"]);
const MONTH_GET = new Set(["getMonth", "getUTCMonth"]);
const DAY_SET = new Set(["setDate", "setUTCDate"]);

/** Paths where an off-by-two calendar date misreports nothing. */
const TEST_OR_FIXTURE =
  /(^|[/\\])(__tests__|tests?|spec|fixtures?|mocks?|seed|seeds|testing)[/\\]|[.-](test|spec|fixture|mock|seed)\.[cm]?[jt]sx?$/i;

/** A day-of-month that exists in every month, so it can never overflow. */
const isSafeDay = (value: unknown): boolean =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 28;

const literalNumber = (node: AstNode | null | undefined): number | null =>
  node?.type === "Literal" && typeof node.value === "number" ? node.value : null;

/** The non-computed method name of a member call, or null. */
const memberMethod = (callee: AstNode | null | undefined): string | null => {
  if (!callee || callee.type !== "MemberExpression" || callee.computed) return null;
  const property = callee.property as AstNode | undefined;
  return property?.type === "Identifier" ? String(property.name) : null;
};

/**
 * The day-of-month carried by a date STRING, or null.
 *
 * `new Date("2026-03-01")` and `` new Date(`${month}-01`) `` both pin the day in
 * their literal text. Only the static quasis are read, and they are joined with a
 * separator so a day can never be forged across an interpolation — `` `${y}-${m}-` ``
 * followed by `01` must not read as "-01".
 */
const stringLiteralDay = (node: AstNode | null | undefined): number | null => {
  let text: string | null = null;
  if (node?.type === "Literal" && typeof node.value === "string") text = node.value;
  else if (node?.type === "TemplateLiteral") {
    const quasis = (node.quasis as AstNode[] | undefined) ?? [];
    text = quasis.map((q) => String(q.value?.cooked ?? q.value?.raw ?? "")).join(" ");
  }
  if (text === null) return null;
  const match = text.match(/-(\d{1,2})(?:[T\s]|$)/);
  return match ? Number.parseInt(match[1]!, 10) : null;
};

interface DayWrite {
  call: AstNode;
  argument: AstNode | undefined;
}

export const noUnclampedMonthShift = defineDiagnostic({
  id: "no-unclamped-month-shift",
  title: "Month shifted without bounding the day, so end-of-month dates overflow into the next month",
  severity: "warn",
  category: "Bugs",
  confidence: "high",
  tags: ["correctness", "date", "billing"],
  recommendation:
    "Bound the day around the shift. Set it to 1 first so the overflow cannot happen, then restore it clamped to the target month's length: `const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + n); d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()))`. The shorter repair-after form works too: `d.setMonth(d.getMonth() + n); if (d.getDate() !== day) d.setDate(0)`. `new Date(y, m + n, d)` is NOT a fix — it overflows identically.",
  create: (ctx) => {
    let inert: boolean | null = null;
    /** Every `setDate`/`setUTCDate` in the file, keyed by the binding it targets. */
    const dayWrites = new Map<Binding, DayWrite[]>();

    const ownerOf = (node: AstNode): AstNode => findAncestor(node, isFunctionLike) ?? ctx.program;

    /**
     * Does this binding's initializer prove a day that cannot overflow?
     *
     * `depth` bounds the copy chain — `new Date(monthStart)` where `monthStart`
     * is itself normalized is the month-boundary idiom, and one hop covers it
     * without turning this into an unbounded alias analysis.
     */
    const provesSafeDay = (binding: Binding | null, depth: number): boolean => {
      if (!binding || depth > 2) return false;
      const init = binding.initNode;
      if (!init || init.type !== "NewExpression") return false;
      const callee = init.callee as AstNode | undefined;
      if (callee?.type !== "Identifier" || callee.name !== "Date") return false;

      const args = (init.arguments as AstNode[] | undefined) ?? [];
      if (args.length >= 3) return isSafeDay(literalNumber(args[2]));
      if (args.length === 1) {
        const day = stringLiteralDay(args[0]);
        if (day !== null) return isSafeDay(day);
        if (args[0]?.type === "Identifier") {
          const source = ctx.scope.resolveIdentifier(args[0]);
          if (!source) return false;
          // A copy of a binding that was itself normalized before the copy.
          for (const write of dayWrites.get(source) ?? []) {
            if (write.call.start < init.start && isSafeDay(literalNumber(write.argument))) return true;
          }
          return provesSafeDay(source, depth + 1);
        }
      }
      return false;
    };

    return {
      Program: (root) => {
        inert = isTestFile(ctx.program, ctx.normalizedFilePath) || TEST_OR_FIXTURE.test(ctx.normalizedFilePath);
        if (inert) return;
        for (const call of collectDescendants(
          root,
          (n) => n.type === "CallExpression" && DAY_SET.has(memberMethod(n.callee as AstNode) ?? ""),
        )) {
          const receiver = (call.callee as AstNode).object as AstNode | undefined;
          if (receiver?.type !== "Identifier") continue;
          const binding = ctx.scope.resolveIdentifier(receiver);
          if (!binding) continue;
          const entry: DayWrite = { call, argument: ((call.arguments as AstNode[] | undefined) ?? [])[0] };
          const list = dayWrites.get(binding);
          if (list) list.push(entry);
          else dayWrites.set(binding, [entry]);
        }
      },

      CallExpression: (node) => {
        if (inert !== false) return;
        const callee = node.callee as AstNode | undefined;
        const method = memberMethod(callee);
        if (method === null || !MONTH_SET.has(method)) return;

        const args = (node.arguments as AstNode[] | undefined) ?? [];
        // `setMonth(m, 1)` writes month and day together — nothing overflows.
        if (args.length >= 2) return;

        const shift = args[0];
        if (!shift || shift.type !== "BinaryExpression") return;
        if (shift.operator !== "+" && shift.operator !== "-") return;

        const receiver = (callee as AstNode).object as AstNode | undefined;
        if (receiver?.type !== "Identifier") return;
        const binding = ctx.scope.resolveIdentifier(receiver);
        if (!binding) return;

        // One side must read the SAME binding's own month: this is a shift
        // relative to itself, not an assignment of an independently computed month.
        const readsOwnMonth = (side: AstNode | null | undefined): boolean => {
          if (!side || side.type !== "CallExpression") return false;
          if (!MONTH_GET.has(memberMethod(side.callee as AstNode) ?? "")) return false;
          const from = (side.callee as AstNode).object as AstNode | undefined;
          return from?.type === "Identifier" && ctx.scope.resolveIdentifier(from) === binding;
        };
        if (!readsOwnMonth(shift.left as AstNode) && !readsOwnMonth(shift.right as AstNode)) return;

        // A day write on the same binding in the same function: a literal 1–28
        // BEFORE makes the overflow impossible, and anything AFTER is a repair.
        const owner = ownerOf(node);
        for (const write of dayWrites.get(binding) ?? []) {
          if (ownerOf(write.call) !== owner) continue;
          if (write.call.start > node.start) return;
          if (isSafeDay(literalNumber(write.argument))) return;
        }

        if (provesSafeDay(binding, 0)) return;

        ctx.report(
          node,
          "`setMonth` writes the month and leaves the day where it was, so a date on the 29th–31st overflows into the month AFTER the one intended — Jan 31 plus one month is Mar 2, and March 31 minus one month is also Mar 2. Nothing here bounds the day, so this shift is wrong for three days of most months.",
        );
      },
    };
  },
});
