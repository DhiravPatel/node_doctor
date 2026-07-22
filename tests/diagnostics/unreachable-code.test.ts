import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { expectFires, expectSilent, findingsFor } from "../helpers.ts";

const ID = "no-unreachable-code";

describe("no-unreachable-code — fires", () => {
  test("statement after a return in a function body", () => {
    expectFires(
      ID,
      `function f(x) {
         return x + 1;
         console.log("never runs");
       }`,
    );
  });

  test("statement after a throw", () => {
    expectFires(
      ID,
      `function boom() {
         throw new Error("nope");
         cleanup();
       }`,
    );
  });

  test("statement after a break inside a loop block", () => {
    expectFires(
      ID,
      `for (const x of items) {
         break;
         handle(x);
       }`,
    );
  });

  test("statement after a continue inside a loop block", () => {
    expectFires(
      ID,
      `for (const x of items) {
         continue;
         handle(x);
       }`,
    );
  });

  test("statement after a break inside a switch case consequent", () => {
    expectFires(
      ID,
      `switch (kind) {
         case "a":
           doA();
           break;
           doAAgain();
         default:
           doDefault();
       }`,
    );
  });

  test("statement after a return inside a switch case consequent", () => {
    expectFires(
      ID,
      `function pick(kind) {
         switch (kind) {
           case "a":
             return 1;
             log("dead");
           default:
             return 0;
         }
       }`,
    );
  });

  test("let declaration after a return is genuinely dead", () => {
    expectFires(
      ID,
      `function f() {
         return 1;
         let later = compute();
       }`,
    );
  });

  test("const declaration after a return is genuinely dead", () => {
    expectFires(
      ID,
      `function f() {
         return 1;
         const later = compute();
       }`,
    );
  });

  test("skips a stray empty statement and reports the real dead statement", () => {
    expectFires(
      ID,
      `function f() {
         return 1;
         ;
         sideEffect();
       }`,
    );
  });

  test("looks past hoisted declarations to the dead statement behind them", () => {
    expectFires(
      ID,
      `function f() {
         return 1;
         function helper() {}
         var cached;
         sideEffect();
       }`,
    );
  });

  test("module scope: statement after a top-level throw", () => {
    expectFires(
      ID,
      `throw new Error("unsupported platform");
       start();`,
    );
  });

  test("dead statement in a nested block is found independently", () => {
    expectFires(
      ID,
      `function f(x) {
         if (x) {
           return 1;
           log("dead");
         }
         return 2;
       }`,
    );
  });

  test("reports only the first statement of a dead run", () => {
    const found = findingsFor(
      ID,
      `function f() {
         return 1;
         a();
         b();
         c();
       }`,
    );
    assert.equal(found.length, 1);
  });

  test("class body method: dead statement after return", () => {
    expectFires(
      ID,
      `class Service {
         run() {
           return this.value;
           this.log();
         }
       }`,
    );
  });

  test("arrow function body: dead statement after return", () => {
    expectFires(
      ID,
      `const f = () => {
         return 1;
         notify();
       };`,
    );
  });
});

describe("no-unreachable-code — silent", () => {
  test("function declaration after a return is hoisted and reachable", () => {
    expectSilent(
      ID,
      `function outer() {
         helper();
         return 1;
         function helper() { doWork(); }
       }`,
    );
  });

  test("var declaration after a return is hoisted", () => {
    expectSilent(
      ID,
      `function f() {
         return cache;
         var cache = {};
       }`,
    );
  });

  test("several hoisted forms after a return, with nothing live behind them", () => {
    expectSilent(
      ID,
      `function f() {
         return 1;
         var a;
         function g() {}
         var b, c;
       }`,
    );
  });

  test("code after an `if (x) return;` guard is reachable", () => {
    expectSilent(
      ID,
      `function f(x) {
         if (!x) return null;
         return use(x);
       }`,
    );
  });

  test("code after a braced early-return guard is reachable", () => {
    expectSilent(
      ID,
      `function f(x) {
         if (!x) {
           return null;
         }
         return use(x);
       }`,
    );
  });

  test("code after a conditional break in a loop is reachable", () => {
    expectSilent(
      ID,
      `for (const x of items) {
         if (!x) break;
         handle(x);
       }`,
    );
  });

  test("code after a conditional continue in a loop is reachable", () => {
    expectSilent(
      ID,
      `for (const x of items) {
         if (!x) continue;
         handle(x);
       }`,
    );
  });

  test("a conditional break inside a switch case does not kill the rest of the case", () => {
    expectSilent(
      ID,
      `switch (kind) {
         case "a":
           if (skip) break;
           doA();
           break;
         default:
           doDefault();
       }`,
    );
  });

  test("an empty case consequent (fallthrough) is not unreachable", () => {
    expectSilent(
      ID,
      `switch (kind) {
         case "a":
         case "b":
           handle();
           break;
         default:
           other();
       }`,
    );
  });

  test("a return as the last statement of a block", () => {
    expectSilent(
      ID,
      `function f(x) {
         const y = x * 2;
         return y;
       }`,
    );
  });

  test("throw inside a catch, with code after the try statement", () => {
    expectSilent(
      ID,
      `function f() {
         try {
           return risky();
         } catch (err) {
           throw err;
         }
       }`,
    );
  });

  test("a finally block still runs after a return in the try block", () => {
    expectSilent(
      ID,
      `function f() {
         try {
           return risky();
         } finally {
           cleanup();
         }
       }`,
    );
  });

  test("erased TypeScript declarations after a return", () => {
    expectSilent(
      ID,
      `function f() {
         return 1;
         interface Later { a: string }
         type Alias = string;
       }`,
      { filePath: "test.ts" },
    );
  });

  test("a TypeScript overload signature after a return", () => {
    expectSilent(
      ID,
      `function f() {
         return 1;
         declare function later(a: string): void;
       }`,
      { filePath: "test.ts" },
    );
  });

  test("exported function declarations after a top-level throw are hoisted", () => {
    expectSilent(
      ID,
      `throw new Error("unsupported");
       export function later() {}`,
    );
  });

  test("a re-export after a top-level throw is module linkage, not a statement", () => {
    expectSilent(
      ID,
      `import { a } from "./a.ts";
       throw new Error("unsupported");
       export { a };`,
    );
  });

  test("a return in one function does not affect the next function", () => {
    expectSilent(
      ID,
      `function a() { return 1; }
       function b() { return 2; }
       run(a, b);`,
    );
  });

  test("a return in a nested callback does not kill the outer block", () => {
    expectSilent(
      ID,
      `function f(items) {
         items.forEach((x) => {
           return x;
         });
         report();
       }`,
    );
  });

  test("a labeled break out of a loop, with code after the loop", () => {
    expectSilent(
      ID,
      `outer: for (const x of xs) {
         for (const y of ys) {
           if (y) break outer;
         }
       }
       done();`,
    );
  });

  test("a switch whose cases each return, followed by code after the switch", () => {
    expectSilent(
      ID,
      `function f(kind) {
         switch (kind) {
           case "a":
             return 1;
           case "b":
             return 2;
         }
         return 0;
       }`,
    );
  });

  test("an arrow with an expression body", () => {
    expectSilent(ID, `const f = (x) => x + 1; f(1);`);
  });

  test("a do-while whose body continues conditionally", () => {
    expectSilent(
      ID,
      `do {
         if (skip) continue;
         work();
       } while (more());`,
    );
  });

  // --- ambient TypeScript (regression: these were reported before the
  // `declare: true` check existed; they have no runtime form at all).

  test("an ambient `declare const` after a top-level throw", () => {
    expectSilent(
      ID,
      `throw new Error("unsupported");
       declare const registry: number;`,
      { filePath: "test.ts" },
    );
  });

  test("an ambient `declare let` after a top-level throw", () => {
    expectSilent(
      ID,
      `throw new Error("unsupported");
       declare let mutableAmbient: string;`,
      { filePath: "test.ts" },
    );
  });

  test("an ambient `declare class` after a top-level throw", () => {
    expectSilent(
      ID,
      `throw new Error("unsupported");
       declare class Ambient {}`,
      { filePath: "test.ts" },
    );
  });

  test("an exported ambient declaration after a top-level throw", () => {
    expectSilent(
      ID,
      `throw new Error("unsupported");
       export declare const version: number;
       export declare function helper(): void;
       export declare class Ambient {}`,
      { filePath: "test.ts" },
    );
  });

  test("a `declare module` block after a top-level throw", () => {
    expectSilent(
      ID,
      `throw new Error("unsupported");
       declare module "side" { const a: number; }`,
      { filePath: "test.ts" },
    );
  });

  test("a type-only re-export after a top-level throw", () => {
    expectSilent(
      ID,
      `throw new Error("unsupported");
       export type { Opts } from "./opts.ts";`,
      { filePath: "test.ts" },
    );
  });

  test("a type-only import after a top-level throw", () => {
    expectSilent(
      ID,
      `throw new Error("unsupported");
       import type { Opts } from "./opts.ts";`,
      { filePath: "test.ts" },
    );
  });
});

// The ambient-declaration exemption must not swallow real value declarations —
// these prove the `declare`/`exportKind` guards are narrow, not a blanket
// "anything exported is fine".
describe("no-unreachable-code — ambient exemption stays narrow", () => {
  test("a value `export const` after a top-level throw is still dead", () => {
    expectFires(
      ID,
      `throw new Error("unsupported");
       export const version = 1;`,
      { filePath: "test.ts" },
    );
  });

  test("a value `export class` after a top-level throw is still dead", () => {
    expectFires(
      ID,
      `throw new Error("unsupported");
       export class Service {}`,
      { filePath: "test.ts" },
    );
  });

  test("the scan looks past an ambient declaration to a live dead statement", () => {
    expectFires(
      ID,
      `throw new Error("unsupported");
       declare const registry: number;
       start();`,
      { filePath: "test.ts" },
    );
  });
});
