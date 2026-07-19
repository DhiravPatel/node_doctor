import { describe, test } from "node:test";
import { expectFires, expectSilent } from "../helpers.ts";

describe("no-async-executor", () => {
  test("silent on a synchronous executor", () => {
    expectSilent(
      "no-async-executor",
      `
      function load(id) {
        return new Promise((resolve, reject) => {
          fetchUser(id).then(resolve, reject);
        });
      }
      `,
    );
  });

  test("fires on an async executor", () => {
    expectFires(
      "no-async-executor",
      `
      function load(id) {
        return new Promise(async (resolve, reject) => {
          const user = await fetchUser(id);
          resolve(user);
        });
      }
      `,
    );
  });
});

describe("no-missing-catch-on-async-iife", () => {
  test("silent when .catch is chained", () => {
    expectSilent(
      "no-missing-catch-on-async-iife",
      `
      (async () => {
        await runMigrations();
      })().catch((err) => console.error(err));
      `,
    );
  });

  test("silent when the body has a try/catch", () => {
    expectSilent(
      "no-missing-catch-on-async-iife",
      `
      (async () => {
        try {
          await runMigrations();
        } catch (err) {
          console.error(err);
        }
      })();
      `,
    );
  });

  test("fires on a floating async IIFE with no handling", () => {
    expectFires(
      "no-missing-catch-on-async-iife",
      `
      (async () => {
        await runMigrations();
      })();
      `,
    );
  });
});

describe("no-swallowed-error-empty-catch", () => {
  test("silent when the catch logs and rethrows", () => {
    expectSilent(
      "no-swallowed-error-empty-catch",
      `
      async function save(order) {
        try {
          await db.orders.insert(order);
        } catch (err) {
          logger.error(err);
          throw err;
        }
      }
      `,
    );
  });

  test("silent when the catch returns a meaningful fallback", () => {
    expectSilent(
      "no-swallowed-error-empty-catch",
      `
      async function load(id) {
        try {
          return await db.users.findOne(id);
        } catch (err) {
          return cachedUser(id);
        }
      }
      `,
    );
  });

  test("fires on an empty catch", () => {
    expectFires(
      "no-swallowed-error-empty-catch",
      `
      async function save(order) {
        try {
          await db.orders.insert(order);
        } catch (err) {}
      }
      `,
    );
  });

  test("silent when the catch returns null (optional-read idiom, precision-first)", () => {
    expectSilent(
      "no-swallowed-error-empty-catch",
      `
      async function load(id) {
        try {
          return await db.users.findOne(id);
        } catch (err) {
          return null;
        }
      }
      `,
    );
  });
});

describe("no-await-in-loop-over-independent-work", () => {
  test("silent when an iteration reads the previous result (dependent)", () => {
    expectSilent(
      "no-await-in-loop-over-independent-work",
      `
      async function fold(nums) {
        let acc = 0;
        for (const n of nums) {
          acc = await combine(acc, n);
        }
        return acc;
      }
      `,
    );
  });

  test("silent when the body does more than one thing", () => {
    expectSilent(
      "no-await-in-loop-over-independent-work",
      `
      async function process(items) {
        for (const item of items) {
          await save(item);
          audit(item);
        }
      }
      `,
    );
  });

  test("fires on independent per-element awaits", () => {
    expectFires(
      "no-await-in-loop-over-independent-work",
      `
      async function notifyAll(users) {
        for (const user of users) {
          await sendWelcome(user);
        }
      }
      `,
    );
  });
});

describe("no-race-without-timeout", () => {
  test("silent when a timeout branch is present", () => {
    expectSilent(
      "no-race-without-timeout",
      `
      async function first() {
        return Promise.race([
          fetchPrimary(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
        ]);
      }
      `,
    );
  });

  test("silent when the argument is not an array literal", () => {
    expectSilent(
      "no-race-without-timeout",
      `
      async function first(tasks) {
        return Promise.race(tasks);
      }
      `,
    );
  });

  test("fires when the race has no timeout branch", () => {
    expectFires(
      "no-race-without-timeout",
      `
      async function first() {
        return Promise.race([fetchPrimary(), fetchSecondary()]);
      }
      `,
    );
  });
});
