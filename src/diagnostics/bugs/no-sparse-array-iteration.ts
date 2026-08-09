import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName } from "../../core/ast.ts";

/**
 * §200 — iterating an array that has a length but no elements.
 *
 * `new Array(5)` does not create five `undefined`s. It creates an array of
 * `length` 5 containing **holes** — and every iteration method on
 * `Array.prototype` skips holes rather than visiting them. So the callback never
 * runs, and the result is another array of five holes:
 *
 *   ❌ const ids = new Array(5).map((_, i) => i);   // [ <5 empty items> ]
 *   ❌ new Array(3).forEach(seed);                  // seed runs ZERO times
 *   ✅ const ids = Array.from({ length: 5 }, (_, i) => i);   // [0,1,2,3,4]
 *   ✅ const ids = new Array(5).fill(0).map((_, i) => i);    // fill materialises them
 *
 * It reads as obviously correct, which is why it survives review — "make an
 * array of five and map over it" is a sentence that describes what the author
 * wanted and not what the code does. And it fails quietly: `JSON.stringify`
 * renders the holes as `null`, `console.log` renders them as `<5 empty items>`,
 * and `.length` is the number the author expected all along. The zero-length
 * output usually surfaces somewhere else entirely, as an empty page or a loop
 * that never ran.
 *
 * PRECISION MODEL. The claim is that this array is provably holey:
 *
 *   - The receiver must be `new Array(n)` / `Array(n)` with **exactly one
 *     numeric-literal argument** that is a positive integer. One argument is the
 *     length form; `new Array(1, 2)` is the elements form and has no holes.
 *     `new Array(0)` has nothing to iterate and no bug to report.
 *   - The argument must be a LITERAL. `new Array(n)` might be `new Array(0)`,
 *     and might be the elements form if `n` is not a number at all.
 *   - The method must be one that SKIPS holes. `fill`, `join`, `keys`,
 *     `entries`, `includes` and the spread all visit them, so
 *     `new Array(5).fill(0)` — the standard fix — is silent by construction.
 *   - A local `Array` is somebody else's constructor.
 */

/** `Array.prototype` methods that skip holes, so the callback never runs. */
const HOLE_SKIPPING = new Set([
  "map",
  "forEach",
  "filter",
  "some",
  "every",
  "reduce",
  "reduceRight",
  "flatMap",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
]);

/** Is this `new Array(<positive int literal>)` / `Array(<positive int literal>)`? */
const holeyArrayLength = (node: AstNode | null | undefined): number | null => {
  if (!node || (node.type !== "NewExpression" && node.type !== "CallExpression")) return null;
  const callee = node.callee as AstNode | undefined;
  if (callee?.type !== "Identifier" || callee.name !== "Array") return null;
  const args = (node.arguments as AstNode[] | undefined) ?? [];
  // Exactly one argument is the LENGTH form; more is the elements form.
  if (args.length !== 1) return null;
  const only = args[0];
  if (only?.type !== "Literal" || typeof only.value !== "number") return null;
  const length = only.value as number;
  if (!Number.isInteger(length) || length <= 0) return null;
  return length;
};

export const noSparseArrayIteration = defineDiagnostic({
  id: "no-sparse-array-iteration",
  title: "Iterating a pre-sized array, whose holes are skipped",
  severity: "error",
  category: "Bugs",
  confidence: "high",
  tags: ["correctness", "arrays"],
  recommendation:
    "Use `Array.from({ length: n }, (_, i) => …)`, or materialise the holes first with `new Array(n).fill(0)`. `new Array(n)` produces holes rather than `undefined`s, and every callback-taking method on `Array.prototype` skips holes — so the callback never runs and the result is another array of holes.",
  create: (ctx) => ({
    CallExpression: (node) => {
      const method = getMethodName(node);
      if (method === null || !HOLE_SKIPPING.has(method)) return;

      const callee = node.callee as AstNode | undefined;
      if (callee?.type !== "MemberExpression") return;
      const receiver = callee.object as AstNode | undefined;
      const length = holeyArrayLength(receiver);
      if (length === null || !receiver) return;

      // A local `Array` is somebody else's constructor.
      const constructor = (receiver.callee as AstNode | undefined) as AstNode | undefined;
      if (constructor && ctx.scope.getBinding("Array", constructor) !== null) return;

      ctx.report(
        node,
        `\`new Array(${length})\` creates ${length} **holes**, not ${length} \`undefined\`s, and \`.${method}()\` skips holes — so the callback never runs${
          method === "forEach" ? "" : " and the result is another array of holes"
        }. It fails quietly: \`JSON.stringify\` renders the holes as \`null\` and \`.length\` is still ${length}. Use \`Array.from({ length: ${length} }, …)\`, or \`.fill(…)\` first.`,
      );
    },
  }),
});
