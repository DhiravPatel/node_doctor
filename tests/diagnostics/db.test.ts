import { describe, test } from "node:test";
import { expectFires, expectSilent } from "../helpers.ts";

describe("no-query-in-loop", () => {
  test("silent: eager load, single round trip", () => {
    expectSilent("no-query-in-loop", `const orders = await db.order.findMany({ include: { items: true } });`);
  });
  test("silent: Array.find in a loop is not a query", () => {
    expectSilent(
      "no-query-in-loop",
      `for (const o of orders) { const m = lookupTable.find((r) => r.id === o.id); }`,
    );
  });
  test("silent: batched Promise.all, not a for/while loop", () => {
    expectSilent(
      "no-query-in-loop",
      `const results = await Promise.all(ids.map((id) => db.item.findUnique({ where: { id } })));`,
    );
  });
  test("regression: `items.find()` must not match the `em` hint", () => {
    expectSilent("no-query-in-loop", `for (const x of xs) { const found = items.find((i) => i.id === x); }`);
  });
  test("fires: findMany once per iteration", () => {
    expectFires(
      "no-query-in-loop",
      `for (const o of orders) { o.items = await db.orderItem.findMany({ where: { orderId: o.id } }); }`,
    );
  });
  test("fires: EntityManager query in a while loop", () => {
    expectFires("no-query-in-loop", `while (hasMore) { const row = await em.findOne(User, id); }`);
  });
});
