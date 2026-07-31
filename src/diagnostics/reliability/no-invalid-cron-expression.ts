import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, getStaticStringValue, getObjectProperty, getCalleeName } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";

/**
 * §30 — a cron expression that can never fire.
 *
 * THE BUG. A scheduled job is registered with a malformed cron expression:
 * `"0 25 * * *"` (hour 25), `"*​/0 * * * *"` (a zero step), `"0 0 30 2 *"`-style
 * out-of-range fields, or the wrong number of fields entirely. Most schedulers
 * either throw at startup — taking the process down on deploy — or silently
 * never run the job. Either way the nightly billing rollup, the cleanup sweep,
 * the retry drain simply does not happen, and nothing in the code review or the
 * type checker catches it: it is a string.
 *
 *   ❌ cron.schedule("0 25 * * *", rollup);        // hour 25 does not exist
 *   ❌ new CronJob("0 0 * *", cleanup);            // 4 fields, not 5 or 6
 *   ✅ cron.schedule("0 23 * * *", rollup);
 *
 * PRECISION MODEL — only a PROVABLY invalid expression fires. The expression
 * must be a static string at a recognized scheduler call site (so a cron-shaped
 * string used for anything else is never touched), and we report only what a
 * parse can prove:
 *
 *   - a field count that is neither 5 nor 6 (6 = the seconds-first form);
 *   - a numeric value outside its field's range (minute 75, hour 25, month 13,
 *     day-of-month 32, day-of-week 8);
 *   - a range whose start exceeds its end (`10-5`);
 *   - a step of zero or a non-numeric step (`*​/0`, `*​/x`).
 *
 * Anything we do not fully model stays SILENT: `@daily`-style macros, the Quartz
 * extensions (`L`, `W`, `#`, `?`), month/day NAMES (`JAN`, `MON`), and any field
 * containing a character outside the modelled grammar. A dynamic expression (a
 * variable, a template with holes, a value from config) is likewise untouched —
 * we never guess at a string we cannot read.
 */

/** Field ranges for the 6-field (seconds-first) form; the 5-field form drops seconds. */
const SIX_FIELD_RANGES: Array<{ name: string; min: number; max: number }> = [
  { name: "second", min: 0, max: 59 },
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  // The `cron` package before v3 used ZERO-based months, so `0` is valid there.
  // Accepting it costs a sliver of recall and removes a version-dependent claim.
  { name: "month", min: 0, max: 12 },
  { name: "day-of-week", min: 0, max: 7 },
];

/** A field we fully model: digits, `*`, `,`, `-`, `/` and nothing else. */
const MODELLED_FIELD = /^[0-9*,\-/]+$/;

/** The whole expression is made only of modelled characters and whitespace. */
const MODELLED_EXPRESSION = /^[0-9*,\-/\s]+$/;

interface CronProblem {
  reason: string;
}

/** Validate one comma-separated term of a field. Returns a problem, or null. */
const checkTerm = (term: string, range: { name: string; min: number; max: number }): CronProblem | null => {
  // Split an optional step: `<base>/<step>`.
  const slash = term.indexOf("/");
  let base = term;
  if (slash >= 0) {
    base = term.slice(0, slash);
    const stepText = term.slice(slash + 1);
    if (!/^[0-9]+$/.test(stepText)) {
      return { reason: `the step in \`${term}\` is not a number` };
    }
    if (Number(stepText) === 0) {
      return { reason: `\`${term}\` steps by zero, which can never advance` };
    }
  }
  if (base === "*" || base === "") return null;

  if (base.includes("-")) {
    const parts = base.split("-");
    if (parts.length !== 2 || !/^[0-9]+$/.test(parts[0]!) || !/^[0-9]+$/.test(parts[1]!)) {
      return { reason: `\`${base}\` is not a valid ${range.name} range` };
    }
    const start = Number(parts[0]);
    const end = Number(parts[1]);
    if (start < range.min || start > range.max || end < range.min || end > range.max) {
      return {
        reason: `\`${base}\` is outside the ${range.name} range ${range.min}-${range.max}`,
      };
    }
    if (start > end) {
      return { reason: `the ${range.name} range \`${base}\` starts after it ends` };
    }
    return null;
  }

  if (!/^[0-9]+$/.test(base)) return null; // not something we model
  const value = Number(base);
  if (value < range.min || value > range.max) {
    return { reason: `${range.name} \`${base}\` is outside the valid range ${range.min}-${range.max}` };
  }
  return null;
};

/**
 * Validate a whole cron expression. Returns the first PROVABLE problem, or null
 * when the expression is valid or uses anything we do not model.
 */
export const checkCronExpression = (raw: string): CronProblem | null => {
  const expression = raw.trim();
  if (expression.length === 0) return null;
  if (expression.startsWith("@")) return null; // @daily / @reboot macros — valid
  if (!MODELLED_EXPRESSION.test(expression)) return null; // names, L/W/#/? — unmodelled

  const fields = expression.split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) {
    return {
      reason: `it has ${fields.length} field(s); a cron expression needs 5 (or 6 with seconds)`,
    };
  }
  const ranges = fields.length === 6 ? SIX_FIELD_RANGES : SIX_FIELD_RANGES.slice(1);
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    const range = ranges[i]!;
    if (!MODELLED_FIELD.test(field)) continue; // unmodelled → skip this field
    for (const term of field.split(",")) {
      const problem = checkTerm(term, range);
      if (problem) return problem;
    }
  }
  return null;
};

/** Packages whose presence proves this file schedules cron work. */
const CRON_SOURCES = new Set(["node-cron", "cron", "node-schedule", "croner", "bullmq", "bull"]);

export const noInvalidCronExpression = defineDiagnostic({
  id: "no-invalid-cron-expression",
  title: "Cron expression is malformed and the job will never run",
  severity: "error",
  category: "Bugs",
  confidence: "high",
  tags: ["bugs", "reliability", "cron"],
  defaultEnabled: false,
  recommendation:
    "Fix the cron expression so every field is inside its range (minute 0-59, hour 0-23, day-of-month 1-31, month 1-12, day-of-week 0-7) and the expression has 5 fields (or 6 with a leading seconds field). Most schedulers throw on a malformed expression at startup; the ones that do not simply never run the job.",
  create: (ctx) => {
    // BINDING GATE. A method name alone proves nothing — `.validate()` belongs to
    // Joi/zod/ajv far more often than to a scheduler, and `.schedule()` to any
    // domain object. So we resolve the RECEIVER to a local binding that a cron
    // package was imported into, and only those call sites are inspected.
    const cronBindings = new Set<string>();
    const queueBindings = new Set<string>();
    const cronCtors = new Set<string>();

    const noteSpecifier = (source: string, local: string, imported: string | null): void => {
      if (CRON_SOURCES.has(source)) {
        if (source === "bullmq" || source === "bull") {
          // `new Queue(...)` bindings are tracked separately below; the class
          // itself is what we record here.
          if (imported === "Queue" || imported === null) queueBindings.add(local);
          return;
        }
        if (imported === "CronJob" || imported === "Cron" || local === "CronJob" || local === "Cron") {
          cronCtors.add(local);
        }
        cronBindings.add(local);
      }
    };

    for (const stmt of (ctx.program.body as AstNode[] | undefined) ?? []) {
      if (stmt.type !== "ImportDeclaration" || typeof stmt.source?.value !== "string") continue;
      const source = stmt.source.value;
      for (const spec of (stmt.specifiers as AstNode[] | undefined) ?? []) {
        const local = (spec.local as AstNode | undefined)?.name as string | undefined;
        if (!local) continue;
        const imported =
          spec.type === "ImportSpecifier"
            ? (((spec.imported as AstNode | undefined)?.name as string | undefined) ?? null)
            : null;
        noteSpecifier(source, local, imported);
      }
    }
    // const cron = require("node-cron") / const { CronJob } = require("cron")
    for (const decl of collectDescendants(ctx.program, (n) => n.type === "VariableDeclarator", undefined, true)) {
      const init = decl.init as AstNode | undefined;
      if (
        init?.type !== "CallExpression" ||
        getCalleeName(init.callee as AstNode) !== "require"
      ) {
        continue;
      }
      const source = getStaticStringValue(((init.arguments as AstNode[] | undefined) ?? [])[0]);
      if (source === null || !CRON_SOURCES.has(source)) continue;
      const id = decl.id as AstNode | undefined;
      if (id?.type === "Identifier") {
        noteSpecifier(source, id.name as string, null);
      } else if (id?.type === "ObjectPattern") {
        for (const prop of (id.properties as AstNode[] | undefined) ?? []) {
          if (prop.type !== "Property" || prop.computed) continue;
          const key = (prop.key as AstNode | undefined)?.name as string | undefined;
          const local =
            (prop.value as AstNode | undefined)?.type === "Identifier"
              ? ((prop.value as AstNode).name as string)
              : null;
          if (key && local) noteSpecifier(source, local, key);
        }
      }
    }
    // `const q = new Queue("billing")` — a queue instance, for the BullMQ shape.
    for (const decl of collectDescendants(ctx.program, (n) => n.type === "VariableDeclarator", undefined, true)) {
      const init = decl.init as AstNode | undefined;
      const id = decl.id as AstNode | undefined;
      if (init?.type !== "NewExpression" || id?.type !== "Identifier") continue;
      const ctor = getCalleeName(init.callee as AstNode);
      if (ctor && queueBindings.has(ctor)) queueBindings.add(id.name as string);
    }

    /** The receiver identifier of `<receiver>.<method>()`, or null. */
    const receiverName = (call: AstNode): string | null => {
      const callee = call.callee as AstNode | undefined;
      if (callee?.type !== "MemberExpression") return null;
      const object = callee.object as AstNode | undefined;
      if (object?.type === "Identifier") return object.name as string;
      // `this.cron.schedule(...)` — use the trailing segment.
      if (object?.type === "MemberExpression" && (object.property as AstNode | undefined)?.type === "Identifier") {
        return (object.property as AstNode).name as string;
      }
      return null;
    };

    const report = (node: AstNode, expression: string, problem: CronProblem): void => {
      ctx.report(
        node,
        `The cron expression \`${expression}\` is invalid — ${problem.reason}. The scheduler will throw at startup or the job will never run.`,
      );
    };

    /** Check one node if it is a static string holding a cron expression. */
    const checkArgument = (node: AstNode | undefined): void => {
      if (!node) return;
      const expression = getStaticStringValue(node);
      if (expression === null) return;
      const problem = checkCronExpression(expression);
      if (problem) report(node, expression, problem);
    };

    /** BullMQ job-adding methods that accept a `{ repeat: … }` options object. */
    const QUEUE_METHODS = new Set(["add", "addBulk", "upsertJobScheduler", "createJobScheduler"]);

    return {
      CallExpression: (node) => {
        const args = (node.arguments as AstNode[] | undefined) ?? [];
        const method = getMethodName(node);
        const receiver = receiverName(node);

        // A scheduler call — the receiver must be a cron-module binding.
        if (method && receiver && cronBindings.has(receiver)) {
          if (method === "schedule" || method === "validate") {
            checkArgument(args[0]);
            return;
          }
          if (method === "scheduleJob") {
            // node-schedule: scheduleJob([name], spec, method). With 3+ args and a
            // readable spec in position 1, args[0] is the NAME — never a cron
            // expression — so only args[1] is checked.
            if (args.length >= 3 && getStaticStringValue(args[1]) !== null) checkArgument(args[1]);
            else checkArgument(args[0]);
            return;
          }
        }

        // croner: `Cron("expr", fn)` called as a bare imported function.
        const bareCallee = getCalleeName(node.callee as AstNode);
        if (bareCallee && cronCtors.has(bareCallee) && (node.callee as AstNode)?.type === "Identifier") {
          checkArgument(args[0]);
          return;
        }

        // BullMQ / Bull: <queue>.add(name, data, { repeat: { pattern | cron } }).
        if (!method || !QUEUE_METHODS.has(method)) return;
        if (!receiver || !queueBindings.has(receiver)) return;
        for (const arg of args) {
          if (arg?.type !== "ObjectExpression") continue;
          const repeat = getObjectProperty(arg, "repeat");
          const repeatValue = repeat?.value as AstNode | undefined;
          if (repeatValue?.type !== "ObjectExpression") continue;
          for (const key of ["pattern", "cron"]) {
            const prop = getObjectProperty(repeatValue, key);
            if (prop) checkArgument(prop.value as AstNode);
          }
        }
      },

      // cron package: new CronJob("expr", fn) / new CronJob({ cronTime: "expr" })
      NewExpression: (node) => {
        const ctor = getCalleeName(node.callee as AstNode);
        if (!ctor || !cronCtors.has(ctor)) return;
        const args = (node.arguments as AstNode[] | undefined) ?? [];
        const first = args[0];
        if (first?.type === "ObjectExpression") {
          const cronTime = getObjectProperty(first, "cronTime");
          if (cronTime) checkArgument(cronTime.value as AstNode);
          return;
        }
        checkArgument(first);
      },
    };
  },
});
