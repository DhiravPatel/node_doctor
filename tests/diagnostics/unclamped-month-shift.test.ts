/**
 * `no-unclamped-month-shift`.
 *
 * `setMonth` writes the month field and leaves the day alone, so a day the
 * target month does not have spills into the month AFTER the intended one.
 * Measured by running each case:
 *
 *   new Date(2024, 0, 31).setMonth(m + 1)   → Sat Mar 02 2024   (skips February)
 *   new Date(2024, 2, 31).setMonth(m - 1)   → Sat Mar 02 2024   (moves FORWARD)
 *   new Date(2024, 4, 31).setMonth(m + 1)   → Mon Jul 01 2024   (June has 30)
 *
 * The silence cases are not hypothetical. The corpus contains this defect AND
 * two hand-written correct implementations of the fix, by the same organization
 * — `ReconciliationService.addMonths` normalizes the day to 1 first, and
 * `RazorpayWebhookService.addMonths` repairs afterwards with `setDate(0)`. Both
 * are production code and both must stay silent, so both are pinned here.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noUnclampedMonthShift } from "../../src/diagnostics/bugs/no-unclamped-month-shift.ts";

const findings = (source: string, filePath = "/repo/src/billing.ts") =>
  lintSource({
    filePath,
    sourceText: source,
    diagnostics: [noUnclampedMonthShift],
    capabilities: new Set(["node", "esm", "typescript"]),
  }).findings.filter((f) => f.diagnostic === "no-unclamped-month-shift");

const fires = (source: string, filePath?: string) => {
  const found = findings(source, filePath);
  assert.ok(found.length > 0, `expected a FIRE on:\n${source}`);
  return found;
};
const silent = (source: string, filePath?: string): void =>
  assert.equal(findings(source, filePath).length, 0, `expected SILENCE on:\n${source}`);

describe("no-unclamped-month-shift", () => {
  describe("the defect", () => {
    test("a service period end, the canonical corpus shape", () => {
      // credit_payment_service.ts — the value is persisted as the period end.
      fires(`
        const today = new Date();
        const end = new Date(today);
        end.setMonth(end.getMonth() + item.service_duration_months);
        return this.formatDate(end);
      `);
    });

    test("a subscription renewal date computed from today", () => {
      // renewal_activation_service.ts — returned as toISOString().split("T")[0].
      fires(`
        function calcNewExpiry(durationMonths) {
          const base = new Date();
          base.setMonth(base.getMonth() + durationMonths);
          return base.toISOString().split("T")[0];
        }
      `);
    });

    test("the next charge date of a MONTHLY mandate", () => {
      // AutoPayController — a mandate taken out on the 31st charges on the 2nd.
      fires(`
        const now = new Date();
        const nextMonth = new Date(now);
        nextMonth.setMonth(nextMonth.getMonth() + 1);
        return nextMonth;
      `);
    });

    test("subtraction overflows too — March 31 minus a month lands LATER", () => {
      fires(`
        const cutoff = new Date();
        cutoff.setMonth(cutoff.getMonth() - 6);
      `);
    });

    test("the UTC pair is the same defect", () => {
      fires(`
        const maxUtc = new Date(raw);
        maxUtc.setUTCMonth(maxUtc.getUTCMonth() + months);
      `);
    });

    test("a Date arriving as a parameter", () => {
      fires(`
        function addMonths(date, months) {
          const d = new Date(date);
          d.setMonth(d.getMonth() + months);
          return d;
        }
      `);
    });

    test("the message names the mechanism and the fix", () => {
      const [found] = fires(`
        const d = new Date();
        d.setMonth(d.getMonth() + 1);
      `);
      assert.match(found!.message, /29th–31st/);
      assert.match(found!.recommendation ?? "", /setDate\(1\)|Math\.min/);
    });
  });

  describe("silence — the two correct implementations found in the corpus", () => {
    test("pre-normalized to day 1, then clamped back", () => {
      // ReconciliationService.addMonths, comment and all.
      silent(`
        function addMonths(date, months) {
          const d = new Date(date);
          const day = d.getDate();
          d.setDate(1);
          d.setMonth(d.getMonth() + months);
          const lastDayOfMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
          d.setDate(Math.min(day, lastDayOfMonth));
          return d;
        }
      `);
    });

    test("repaired afterwards with setDate(0)", () => {
      // RazorpayWebhookService.addMonths — shift first, roll the day back after.
      silent(`
        function addMonths(date, months) {
          const d = date.getDate();
          date.setMonth(date.getMonth() + months);
          if (date.getDate() !== d) date.setDate(0);
          return date;
        }
      `);
    });
  });

  describe("silence — a day that cannot overflow", () => {
    test("two-argument setMonth sets the day atomically", () => {
      silent(`
        const q = new Date(raw);
        q.setUTCMonth(q.getUTCMonth() - (q.getUTCMonth() + 3) % 3, 1);
      `);
    });

    test("new Date(y, m, 1)", () => {
      silent(`
        const cursor = new Date(year, month, 1);
        cursor.setMonth(cursor.getMonth() + 1);
      `);
    });

    test("any literal day through the 28th", () => {
      silent(`
        const d = new Date(y, m, 28);
        d.setMonth(d.getMonth() + 3);
      `);
    });

    test("a date string whose literal text carries the day", () => {
      silent(`
        const endDate = new Date("2026-03-01");
        endDate.setMonth(endDate.getMonth() + 1);
      `);
    });

    test("a template literal ending in the day — the corpus month-range idiom", () => {
      // user_attendance_controller.ts, four sites.
      silent(`
        const startDate = new Date(\`\${month}-01\`);
        const endDate = new Date(startDate);
        endDate.setMonth(endDate.getMonth() + 1);
      `);
    });

    test("one hop through a copy of a normalized date", () => {
      // monthStart.setDate(1); const monthEnd = new Date(monthStart); …
      silent(`
        const monthStart = new Date(selectedDate);
        monthStart.setDate(1);
        monthStart.setHours(0, 0, 0, 0);
        const monthEnd = new Date(monthStart);
        monthEnd.setMonth(monthEnd.getMonth() + 1);
      `);
    });

    test("test and fixture paths", () => {
      const src = `const d = new Date(); d.setMonth(d.getMonth() + 1);`;
      silent(src, "/repo/src/billing.test.ts");
      silent(src, "/repo/tests/fixtures/dates.ts");
      silent(src, "/repo/packages/testing/src/scenario.ts");
    });
  });

  describe("precision guards — each pins a way this could go wrong", () => {
    test("a day write in ANOTHER function does not silence this one", () => {
      // The name-collision trap that the scope-keyed taint work exists to close:
      // both functions have a `d`, only one is normalized.
      fires(`
        function safe(base) {
          const d = new Date(base);
          d.setDate(1);
          d.setMonth(d.getMonth() + 1);
          return d;
        }
        function unsafe(base) {
          const d = new Date(base);
          d.setMonth(d.getMonth() + 1);
          return d;
        }
      `);
    });

    test("a pre-normalizing setDate must be a day that actually cannot overflow", () => {
      fires(`
        const d = new Date(raw);
        d.setDate(31);
        d.setMonth(d.getMonth() + 1);
      `);
    });

    test("new Date(y, m, 31) proves an unsafe day, not a safe one", () => {
      fires(`
        const d = new Date(y, m, 31);
        d.setMonth(d.getMonth() + 1);
      `);
    });

    test("a day cannot be forged across a template interpolation", () => {
      // `${y}-${m}-` + `01` must not read as the literal tail "-01".
      fires(`
        const d = new Date(\`\${y}-\${m}-\${day}\`);
        d.setMonth(d.getMonth() + 1);
      `);
    });

    test("a month set from an independent value is not a self-relative shift", () => {
      // Deliberate recall choice: only `x.setMonth(x.getMonth() ± n)` is claimed.
      silent(`
        const end = new Date(raw);
        end.setMonth(start.getMonth() + 1);
      `);
    });

    test("an absolute month is not a shift", () => {
      silent(`
        const d = new Date(raw);
        d.setMonth(0);
      `);
    });

    test("setFullYear is deliberately out of scope", () => {
      // Same defect on Feb 29 and the same fix, but measured at 23 corpus sites
      // of which 16 were immaterial year-over-year reporting windows. See the
      // rule docblock; do not quietly re-add it without re-measuring.
      silent(`
        const d = new Date();
        d.setFullYear(d.getFullYear() + 1);
      `);
    });

    test("a non-identifier receiver is not claimed", () => {
      // Clamp checks are keyed by binding identity, which `this.date` has none of.
      silent(`
        class C {
          next() { this.date.setMonth(this.date.getMonth() + 1); }
        }
      `);
    });
  });
});
