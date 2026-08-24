/**
 * `no-tofixed-as-number`.
 *
 * `toFixed` returns a STRING, so `+` concatenates. Every shape below was
 * executed before it was encoded here:
 *
 *   (100).toFixed(2) + (18).toFixed(2)          → "100.0018.00"
 *   (1.5).toFixed(2) + 5                        → "1.505"
 *   let sum = 0; sum += (1.5).toFixed(2)        → "01.50"
 *   (1.5).toFixed(2) + (2 * 3)                  → "1.506"
 *   [1,2].reduce((a,b) => a + b.toFixed(2), 0)  → "01.002.00"
 *   (1234.5).toLocaleString() + 1               → "1,234.51"
 *   (100).toFixed(2) === 100                    → false, always
 *
 * And the shapes that must stay silent, also executed:
 *
 *   "Total: " + (1.5).toFixed(2)                → "Total: 1.50"   correct
 *   Number((1.5).toFixed(2)) + 5                → 6.5             correct
 *   +(1.5).toFixed(2) + 5                       → 6.5             correct
 *   (100).toFixed(2) == 100                     → true            coerces
 *   (100).toFixed(2) > 99                       → true            coerces
 *
 * The last two are why `==` and the relational operators are excluded: they
 * coerce, so reporting them would be reporting correct code.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noTofixedAsNumber } from "../../src/diagnostics/bugs/no-tofixed-as-number.ts";

const findings = (source: string, filePath = "/repo/src/invoice.ts") =>
  lintSource({
    filePath,
    sourceText: source,
    diagnostics: [noTofixedAsNumber],
    capabilities: new Set(["node", "esm", "typescript"]),
  }).findings.filter((f) => f.diagnostic === "no-tofixed-as-number");

const fires = (source: string) => {
  const found = findings(source);
  assert.ok(found.length > 0, `expected a FIRE on:\n${source}`);
  return found;
};
const silent = (source: string): void =>
  assert.equal(findings(source).length, 0, `expected SILENCE on:\n${source}`);

describe("no-tofixed-as-number", () => {
  describe("concatenation where addition was meant", () => {
    test("two toFixed results — the canonical money bug", () => {
      fires(`const total = subtotal.toFixed(2) + tax.toFixed(2);`);
    });

    test("a toFixed result plus a numeric literal", () => {
      fires(`const total = amount.toFixed(2) + 5;`);
    });

    test("a numeric literal plus a toFixed result", () => {
      fires(`const total = 5 + amount.toFixed(2);`);
    });

    test("a toFixed result plus an arithmetic expression", () => {
      fires(`const total = amount.toFixed(2) + qty * rate;`);
    });

    test("`+=` onto a binding seeded with a number", () => {
      fires(`
        let sum = 0;
        for (const item of items) sum += item.price.toFixed(2);
        return sum;
      `);
    });

    test("a reduce accumulator seeded with a number", () => {
      fires(`const total = items.reduce((acc, item) => acc + item.price.toFixed(2), 0);`);
    });

    test("reduceRight is the same shape", () => {
      fires(`const total = items.reduceRight((acc, item) => acc + item.price.toFixed(2), 0);`);
    });

    test("toPrecision has the same contract", () => {
      fires(`const total = a.toPrecision(3) + b.toPrecision(3);`);
    });

    test("toLocaleString is worse — it also inserts group separators", () => {
      fires(`const total = revenue.toLocaleString() + 1;`);
    });

    test("optional chaining does not hide it", () => {
      fires(`const total = amount?.toFixed(2) + 5;`);
    });

    test("one hop through a const — how the shape is actually written", () => {
      fires(`
        const t = tax.toFixed(2);
        const total = subtotal.toFixed(2) + t;
      `);
      fires(`
        const t = tax.toFixed(2);
        const total = t + 5;
      `);
    });

    test("the hop is keyed by binding, not by name", () => {
      // `t` in `display` is a string; `t` in `compute` is a number. Only the
      // string one may be reported, and only in its own scope.
      const found = findings(`
        function display() {
          const t = tax.toFixed(2);
          return "Tax: " + t;
        }
        function compute() {
          const t = 5;
          return t + 1;
        }
      `);
      assert.equal(found.length, 0);
    });

    test("a `let` is not provably a string at the use site", () => {
      silent(`
        let t = tax.toFixed(2);
        t = rawTax;
        const total = t + 5;
      `);
    });

    test("the message names the mechanism and shows the wrong value", () => {
      const [found] = fires(`const total = subtotal.toFixed(2) + tax.toFixed(2);`);
      assert.match(found!.message, /returns a STRING/);
      assert.match(found!.message, /100\.0018\.00/);
      assert.match(found!.recommendation ?? "", /Math\.round|Number\(/);
    });
  });

  describe("a comparison that can never hold", () => {
    test("strict equality against a number is always false", () => {
      fires(`if (balance.toFixed(2) === 0) { settle(); }`);
    });

    test("strict inequality too, either way round", () => {
      fires(`if (balance.toFixed(2) !== 0) { settle(); }`);
      fires(`if (0 === balance.toFixed(2)) { settle(); }`);
    });

    test("loose equality COERCES and works — verified true, so it is silent", () => {
      silent(`if (balance.toFixed(2) == 0) { settle(); }`);
      silent(`if (balance.toFixed(2) != 0) { settle(); }`);
    });

    test("relational operators coerce and work — silent", () => {
      silent(`if (balance.toFixed(2) > 99) { settle(); }`);
      silent(`if (balance.toFixed(2) <= 99) { settle(); }`);
    });

    test("comparing the string to a string is the correct form", () => {
      silent(`if (balance.toFixed(2) === "0.00") { settle(); }`);
    });
  });

  describe("silence — display formatting is correct", () => {
    test("a string literal on either side", () => {
      silent(`const label = "Total: " + amount.toFixed(2);`);
      silent(`const label = amount.toFixed(2) + "%";`);
    });

    test("a template literal operand", () => {
      silent(`const label = \`Total: \` + amount.toFixed(2);`);
    });

    test("template interpolation is not a `+` at all", () => {
      silent(`const label = \`Total: \${amount.toFixed(2)}\`;`);
    });

    test("String(...) on the other side", () => {
      silent(`const label = String(prefix) + amount.toFixed(2);`);
    });
  });

  describe("silence — the standard unwraps yield a number", () => {
    test("Number(...)", () => {
      silent(`const total = Number(subtotal.toFixed(2)) + Number(tax.toFixed(2));`);
    });

    test("parseFloat(...) and parseInt(...)", () => {
      silent(`const total = parseFloat(subtotal.toFixed(2)) + qty;`);
      silent(`const total = parseInt(subtotal.toFixed(0), 10) + qty;`);
    });

    test("unary plus", () => {
      silent(`const total = +subtotal.toFixed(2) + 5;`);
    });
  });

  describe("precision guards — uncertainty must resolve to silence", () => {
    test("an unknown operand could be a string label", () => {
      silent(`const label = prefix + amount.toFixed(2);`);
      silent(`const label = row.currency + amount.toFixed(2);`);
      silent(`const label = getPrefix() + amount.toFixed(2);`);
    });

    test("`+=` onto a binding with no numeric proof", () => {
      silent(`
        let out = prefix;
        for (const item of items) out += item.price.toFixed(2);
      `);
    });

    test("`+=` onto a binding seeded with a string is deliberate concatenation", () => {
      silent(`
        let out = "";
        for (const item of items) out += item.price.toFixed(2);
      `);
    });

    test("a reduce accumulator seeded with a string is deliberate", () => {
      silent(`const csv = items.reduce((acc, item) => acc + item.price.toFixed(2), "");`);
    });

    test("a reduce with no seed proves nothing about the accumulator", () => {
      silent(`const total = items.reduce((acc, item) => acc + item.price.toFixed(2));`);
    });

    test("only the FIRST reduce parameter is the accumulator", () => {
      // `item` is seeded by nothing; the numeric seed applies to `acc`.
      silent(`const total = items.reduce((acc, item) => item + other.toFixed(2), 0);`);
    });

    test("toString is deliberately not a formatter here", () => {
      silent(`const label = a.toString() + b.toString();`);
      silent(`const total = a.toString() + 5;`);
    });

    test("a computed member call is not claimed", () => {
      silent(`const total = a["toFixed"](2) + b["toFixed"](2);`);
    });

    test("plain numeric addition is untouched", () => {
      silent(`const total = subtotal + tax;`);
    });

    test("a nested `+` is only numeric when both halves are", () => {
      // `prefix + 1` may itself concatenate, so it proves nothing.
      silent(`const label = (prefix + 1) + amount.toFixed(2);`);
      fires(`const total = (2 + 3) + amount.toFixed(2);`);
    });
  });
});
