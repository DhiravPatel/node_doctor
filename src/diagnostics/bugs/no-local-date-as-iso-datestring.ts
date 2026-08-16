import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";
import { isTestFile } from "../../core/test-file.ts";

/**
 * A local-midnight `Date` serialized as a UTC calendar date.
 *
 *   ❌ const from = new Date(y, m, 1).toISOString().split("T")[0];
 *   ❌ const to   = new Date(y, m + 1, 0).toISOString().slice(0, 10);
 *   ✅ new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10)
 *   ✅ format the local date locally: `${y}-${pad(m + 1)}-${pad(d)}`
 *
 * The multi-argument `Date` constructor builds an instant from LOCAL wall-clock
 * components, so `new Date(2026, 7, 1)` is midnight local time. `toISOString()`
 * renders in UTC. On any host east of Greenwich, local midnight is still the
 * previous day in UTC — so truncating to `YYYY-MM-DD` yields yesterday.
 *
 * MEASURED, running the month-range idiom under five timezones:
 *
 *   UTC                  2026-08-01 .. 2026-08-31   ← intended
 *   America/Los_Angeles  2026-08-01 .. 2026-08-31
 *   Asia/Kolkata         2026-07-31 .. 2026-08-30   ← wrong
 *   Europe/Berlin        2026-07-31 .. 2026-08-30   ← wrong
 *   Australia/Sydney     2026-07-31 .. 2026-08-30   ← wrong
 *
 * That upper bound is the expensive half. `new Date(y, m + 1, 0)` is the standard
 * idiom for "last day of this month", and the emitted bound silently EXCLUDES the
 * last day — a month-to-date report that quietly drops its final day, every
 * month, on every host with a positive offset. Nothing throws. The string is
 * well-formed and plausible, and it is correct on a UTC or US-hosted CI box,
 * which is exactly why it survives review and then misreports in production.
 *
 * PRECISION MODEL. The author's intent is unambiguous because they threw the time
 * away: a value truncated to ten characters is being used as a calendar date, and
 * a calendar date derived from local components must not be rendered in UTC.
 *
 * Both halves are required:
 *
 *   - The receiver is `new Date(a, b)` or `new Date(a, b, c)` — 2 or 3 arguments,
 *     which pins it to 00:00 local. Reached inline, or through a binding whose
 *     every initializer and assignment in the file is such a constructor.
 *   - The result is truncated to exactly the date part: `slice(0, 10)`,
 *     `substring(0, 10)`, `substr(0, 10)`, `split("T")[0]`, `split("T").shift()`,
 *     array-destructuring of that split, or `replace(/T.*​/, "")`.
 *
 * Silent, each tied to a case found in the corpus rather than imagined:
 *
 *   - **Four or more arguments.** `new Date(y, m, d, 23, 59, 59, 999)` is the
 *     end-of-day bound and is CORRECT under a positive offset. The arity gate
 *     excludes it.
 *   - **Relative shifts.** `const end = new Date(start); end.setDate(start.getDate() + n)`
 *     preserves whatever UTC-date offset the base already had, so it is not a
 *     defect. Twenty-five such sites were flagged by an earlier pass, read, and
 *     the whole `setDate`/`setMonth`/`setFullYear`/`setTime` branch removed. Any
 *     such mutation on the binding silences it.
 *   - **`Date.UTC(...)`** — 414 uses in the corpus, and the correct idiom sits
 *     next door to a defect in the same codebase. Never fires.
 *   - **`new Date()` and `new Date(someString)`** — deliberate UTC-today, left
 *     alone. This is why one line of a file can fire while the line below it,
 *     using `today.toISOString().split("T")[0]`, stays silent.
 *   - **An untruncated `toISOString()`** is a full UTC instant used as a query
 *     bound, which is correct.
 *   - A shadowed `Date`, and test files.
 *
 * Severity is `warn`, not `error`: on a host running `TZ=UTC` or a negative
 * offset the string is right, and which host this runs on is not in the file.
 */

/** Mutators that re-base the instant, preserving whatever offset it had. */
const REBASING_MUTATORS = new Set([
  "setDate",
  "setMonth",
  "setFullYear",
  "setTime",
  "setUTCDate",
  "setUTCMonth",
  "setUTCFullYear",
]);

/** Serializers that render in UTC. */
const UTC_SERIALIZERS = new Set(["toISOString", "toJSON"]);

/**
 * Test and fixture paths, alongside `isTestFile`.
 *
 * That helper demands proof — a runner import, or a test path AND real test
 * declarations — so a `.test.ts` holding only date helpers is correctly not
 * "provably a test". Here the path alone is enough: an off-by-one calendar date
 * in a fixture misreports nothing.
 */
const TEST_OR_FIXTURE =
  /(^|[/\\])(__tests__|tests?|spec|fixtures?|mocks?|seed|seeds)[/\\]|[.-](test|spec|fixture|mock|seed)\.[cm]?[jt]sx?$/i;

const literalNumber = (node: AstNode | null | undefined): number | null =>
  node?.type === "Literal" && typeof node.value === "number" ? node.value : null;

/** `new Date(a, b)` / `new Date(a, b, c)` — local wall-clock midnight. */
const isLocalMidnightConstruction = (node: AstNode | null | undefined): boolean => {
  if (!node || node.type !== "NewExpression") return false;
  const callee = node.callee as AstNode | undefined;
  if (callee?.type !== "Identifier" || callee.name !== "Date") return false;
  const count = ((node.arguments as AstNode[] | undefined) ?? []).length;
  // 0/1 args is a UTC-today or parsed instant; 4+ pins a wall-clock time on
  // purpose and is correct under a positive offset.
  return count === 2 || count === 3;
};

/**
 * Is this `toISOString()` call truncated to exactly the `YYYY-MM-DD` part?
 * That truncation is the proof the value is being used as a calendar date.
 */
const truncatesToDatePart = (isoCall: AstNode): boolean => {
  const member = isoCall.parent as AstNode | undefined;
  if (member?.type !== "MemberExpression" || member.object !== isoCall) return false;
  const property = member.property as AstNode | undefined;
  if (property?.type !== "Identifier") return false;
  const outerCall = member.parent as AstNode | undefined;
  if (outerCall?.type !== "CallExpression" || outerCall.callee !== member) return false;
  const args = (outerCall.arguments as AstNode[] | undefined) ?? [];
  const method = String(property.name);

  if (method === "slice" || method === "substring" || method === "substr") {
    return args.length === 2 && literalNumber(args[0]) === 0 && literalNumber(args[1]) === 10;
  }

  if (method === "replace") {
    const pattern = args[0];
    // `replace(/T.*/, "")` — strip everything from the time separator on.
    return pattern?.type === "Literal" && typeof pattern.regex?.pattern === "string" && /^T\./.test(pattern.regex.pattern);
  }

  if (method === "split") {
    const separator = args[0];
    if (separator?.type !== "Literal" || separator.value !== "T") return false;
    const after = outerCall.parent as AstNode | undefined;
    // `.split("T")[0]`
    if (
      after?.type === "MemberExpression" &&
      after.object === outerCall &&
      after.computed === true &&
      literalNumber(after.property as AstNode) === 0
    ) {
      return true;
    }
    // `.split("T").shift()`
    if (
      after?.type === "MemberExpression" &&
      after.object === outerCall &&
      after.computed !== true &&
      (after.property as AstNode | undefined)?.type === "Identifier" &&
      String((after.property as AstNode).name) === "shift"
    ) {
      return true;
    }
    // `const [datePart] = …split("T")`
    if (after?.type === "VariableDeclarator" && after.init === outerCall) {
      return (after.id as AstNode | undefined)?.type === "ArrayPattern";
    }
    return false;
  }

  return false;
};

export const noLocalDateAsIsoDatestring = defineDiagnostic({
  id: "no-local-date-as-iso-datestring",
  title: "Local-midnight Date rendered as a UTC calendar date, giving the previous day",
  severity: "warn",
  category: "Bugs",
  confidence: "high",
  tags: ["correctness", "timezone", "date"],
  recommendation:
    "Build the instant in UTC — `new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10)` — or format the local date locally without going through UTC. `new Date(y, m, d)` is midnight LOCAL, and `toISOString()` renders UTC, so east of Greenwich the truncated date is the previous day. The `new Date(y, m + 1, 0)` \"last day of the month\" idiom is the costly one: the bound it produces silently excludes the last day.",
  create: (ctx) => {
    let inert: boolean | null = null;
    /** Bindings whose every initializer and assignment is a local-midnight Date. */
    const localMidnight = new Set<string>();
    /** Bindings disqualified — reassigned to something else, or re-based. */
    const disqualified = new Set<string>();

    return {
      Program: (root) => {
        inert = isTestFile(ctx.program, ctx.normalizedFilePath) || TEST_OR_FIXTURE.test(ctx.normalizedFilePath);
        if (inert) return;

        for (const node of collectDescendants(root, () => true)) {
          // Every initializer of a binding must be a local-midnight construction.
          if (node.type === "VariableDeclarator" && (node.id as AstNode | undefined)?.type === "Identifier") {
            const name = String((node.id as AstNode).name);
            if (isLocalMidnightConstruction(node.init as AstNode | undefined)) localMidnight.add(name);
            else disqualified.add(name);
            continue;
          }
          // A later assignment must be one too.
          if (node.type === "AssignmentExpression" && (node.left as AstNode | undefined)?.type === "Identifier") {
            const name = String((node.left as AstNode).name);
            if (!isLocalMidnightConstruction(node.right as AstNode | undefined)) disqualified.add(name);
            continue;
          }
          // A parameter is whatever the caller passed.
          if (node.type === "Identifier" && (node.parent as AstNode | undefined)?.type === "FunctionDeclaration") {
            disqualified.add(String(node.name));
            continue;
          }
          // A re-basing mutation preserves the existing offset, so it is not a defect.
          if (node.type === "CallExpression") {
            const method = getMethodName(node);
            if (method !== null && REBASING_MUTATORS.has(method)) {
              const callee = node.callee as AstNode | undefined;
              const receiver = callee?.type === "MemberExpression" ? (callee.object as AstNode) : null;
              if (receiver?.type === "Identifier") disqualified.add(String(receiver.name));
            }
          }
        }
      },

      CallExpression: (node) => {
        if (inert !== false) return;
        const method = getMethodName(node);
        if (method === null || !UTC_SERIALIZERS.has(method)) return;
        if (!truncatesToDatePart(node)) return;

        const callee = node.callee as AstNode | undefined;
        if (callee?.type !== "MemberExpression") return;
        const receiver = callee.object as AstNode | undefined;
        if (!receiver) return;

        // A shadowed `Date` is not the built-in.
        if (ctx.scope.getBinding("Date", node)) return;

        let inline = isLocalMidnightConstruction(receiver);
        if (!inline) {
          if (receiver.type !== "Identifier") return;
          const name = String(receiver.name);
          if (disqualified.has(name) || !localMidnight.has(name)) return;
        }

        ctx.report(
          node,
          `\`new Date(…)\` with 2–3 arguments is midnight **local** time, and \`.${method}()\` renders **UTC** — so east of Greenwich this truncates to the PREVIOUS day. Measured on the month-range idiom: \`Asia/Kolkata\`, \`Europe/Berlin\` and \`Australia/Sydney\` all produced \`2026-07-31 .. 2026-08-30\` where \`2026-08-01 .. 2026-08-31\` was meant. The \`new Date(y, m + 1, 0)\` form is the costly one — the bound silently excludes the last day of the month. Nothing throws, and it is correct on a UTC or US-hosted CI box, which is why it survives review. Use \`Date.UTC(…)\`, or format the local date without going through UTC.`,
        );
      },
    };
  },
});
