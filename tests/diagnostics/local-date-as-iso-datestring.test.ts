/**
 * §13 — `no-local-date-as-iso-datestring`.
 *
 * `new Date(y, m, d)` is midnight LOCAL; `toISOString()` renders UTC. East of
 * Greenwich the truncated `YYYY-MM-DD` is the previous day. Measured on the
 * month-range idiom under five timezones:
 *
 *   UTC / America/Los_Angeles  → 2026-08-01 .. 2026-08-31   (intended)
 *   Asia/Kolkata / Europe/Berlin / Australia/Sydney
 *                              → 2026-07-31 .. 2026-08-30   (wrong)
 *
 * The silence cases are not hypothetical — each was found in the corpus, and the
 * `setDate` one killed an entire earlier branch of the rule after 25 such sites
 * were read and judged correct.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noLocalDateAsIsoDatestring } from "../../src/diagnostics/bugs/no-local-date-as-iso-datestring.ts";

const findings = (source: string, filePath = "/repo/src/reports.ts") =>
  lintSource({
    filePath,
    sourceText: source,
    diagnostics: [noLocalDateAsIsoDatestring],
    capabilities: new Set(["node", "esm", "typescript"]),
  }).findings.filter((f) => f.diagnostic === "no-local-date-as-iso-datestring");

const fires = (source: string, filePath?: string) => {
  const found = findings(source, filePath);
  assert.ok(found.length > 0, `expected a FIRE on:\n${source}`);
  return found;
};
const silent = (source: string, filePath?: string): void =>
  assert.equal(findings(source, filePath).length, 0, `expected SILENCE on:\n${source}`);

describe("no-local-date-as-iso-datestring", () => {
  describe("the defect", () => {
    test("month start, the canonical corpus shape", () => {
      fires(`const fromDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];`);
    });

    test("last day of the month — the bound that drops a day of data", () => {
      fires(`const toDate = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split("T")[0];`);
    });

    test("a three-argument construction", () => {
      fires(`const d = new Date(y, m, 15).toISOString().slice(0, 10);`);
    });

    test("reached through a binding", () => {
      fires(`
        const startDate = new Date(year, month, 1);
        const startDateStr = startDate.toISOString().split("T")[0];
      `);
    });

    test("every truncation form", () => {
      fires(`const a = new Date(y, m, 1).toISOString().slice(0, 10);`);
      fires(`const b = new Date(y, m, 1).toISOString().substring(0, 10);`);
      fires(`const c = new Date(y, m, 1).toISOString().substr(0, 10);`);
      fires(`const d = new Date(y, m, 1).toISOString().split("T")[0];`);
      fires(`const e = new Date(y, m, 1).toISOString().split("T").shift();`);
      fires(`const [f] = new Date(y, m, 1).toISOString().split("T");`);
      fires(`const g = new Date(y, m, 1).toISOString().replace(/T.*/, "");`);
    });

    test("toJSON renders UTC too", () => {
      fires(`const s = new Date(y, m, 1).toJSON().slice(0, 10);`);
    });

    test("the message names the timezones it was measured under", () => {
      const [finding] = fires(`const s = new Date(y, m, 1).toISOString().split("T")[0];`);
      assert.match(finding!.message, /Asia\/Kolkata/);
      assert.match(finding!.message, /Date\.UTC/);
    });
  });

  describe("correct code, each found in the corpus", () => {
    test("`Date.UTC` is the fix and never fires", () => {
      silent(`const s = new Date(Date.UTC(y, m, 1)).toISOString().split("T")[0];`);
    });

    test("four or more arguments pin end-of-day deliberately", () => {
      silent(`const to = new Date(y, m, d, 23, 59, 59, 999).toISOString().slice(0, 10);`);
    });

    test("a relative shift preserves the offset, so it is not a defect", () => {
      silent(`
        const end = new Date(y, m, 1);
        end.setDate(end.getDate() + 7);
        const s = end.toISOString().split("T")[0];
      `);
    });

    test("`new Date()` is deliberate UTC-today", () => {
      silent(`const s = new Date().toISOString().split("T")[0];`);
    });

    test("a parsed string is already an instant", () => {
      silent(`const s = new Date("2026-01-15").toISOString().split("T")[0];`);
    });

    test("adjacent lines are discriminated — the real EBillBirthdayModal shape", () => {
      // Line 1 is local-midnight and wrong; line 2 is UTC-today and correct.
      const found = findings(`
        const today = new Date();
        const maxDob = new Date(today.getFullYear() - 5, today.getMonth(), today.getDate())
          .toISOString()
          .split("T")[0];
        const maxAnniversary = today.toISOString().split("T")[0];
      `);
      assert.equal(found.length, 1, "exactly the local-midnight line, not the UTC-today one");
    });

    test("an untruncated toISOString is a full UTC instant", () => {
      silent(`const s = new Date(y, m, 1).toISOString();`);
    });

    test("a truncation that is not the date part", () => {
      silent(`const s = new Date(y, m, 1).toISOString().slice(0, 7);`);
    });

    test("a binding reassigned to something else is unknown", () => {
      silent(`
        let d = new Date(y, m, 1);
        d = new Date(raw);
        const s = d.toISOString().slice(0, 10);
      `);
    });

    test("a shadowed Date is not the built-in", () => {
      silent(`
        class Date { toISOString() { return ""; } }
        const s = new Date(y, m, 1).toISOString().slice(0, 10);
      `);
    });

    test("test and fixture files are excluded", () => {
      silent(`const s = new Date(y, m, 1).toISOString().split("T")[0];`, "/repo/src/reports.test.ts");
      silent(`const s = new Date(y, m, 1).toISOString().split("T")[0];`, "/repo/tests/fixtures/dates.ts");
    });
  });
});
