import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, getReceiverName, REQUEST_ROOTS } from "../../core/ast.ts";

/**
 * §6 — the whole request body written straight into a record.
 *
 * Handing an ORM the entire body lets the caller set **every column the model
 * has**, not just the ones the form showed them. The fields that matter are
 * exactly the ones no UI exposes:
 *
 *   ❌ await prisma.user.create({ data: req.body });
 *      // POST { "email": "…", "role": "ADMIN", "credits": 999999 }
 *   ❌ await User.update({ ...req.body }, { where: { id } });
 *   ❌ Object.assign(user, req.body); await user.save();
 *   ✅ const { email, name } = req.body;
 *      await prisma.user.create({ data: { email, name } });
 *   ✅ await prisma.user.create({ data: schema.parse(req.body) });
 *
 * It is privilege escalation with no exploit required — the attacker adds a key
 * to a JSON object. And it is invisible in review precisely because the code is
 * short and reads as tidy: the bug is in what the line does NOT say.
 *
 * The failure survives tests for the same reason. A test posts the fields the
 * form posts, and every one of them is legitimate; nothing exercises the field
 * the attacker will add. It survives type-checking too, because `req.body` is
 * `any` in Express and the ORM's `data` accepts a partial of the model.
 *
 * PRECISION MODEL. This rule asks only ONE question, and it is syntactic: does
 * the WHOLE caller-controlled object reach a write, un-narrowed?
 *
 *   - It never asks what a FIELD MEANS. "This handler trusts `req.body.isAdmin`"
 *     would need to know that `isAdmin` is privileged, which is a claim about a
 *     name, and the house rejects those.
 *   - Narrowing anywhere in the expression is a silence. A destructure, a
 *     `pick`, a `schema.parse(req.body)`, an explicit object literal listing
 *     fields — each produces a DIFFERENT value, so the body no longer reaches
 *     the write and there is nothing to report.
 *   - The receiver must be a proven WRITE: a create/update/save-family method on
 *     an ORM-shaped receiver, or `Object.assign` onto a non-literal target.
 *     A `find({ where: req.body })` is a query, not a write — a different bug
 *     with a different rule (`no-nosql-object-injection`).
 *   - The value must be the request body OBJECT — `req.body` written out, or a
 *     binding whose initializer is exactly that. **Not** merely a value derived
 *     from the request.
 *
 * That last point is the whole rule, and getting it wrong the first time made
 * this fire 743 times across 106,000 files. Treating any request-DERIVED
 * binding as the body reported `mongoHelper.create(session)` where `session` was
 * built field by field from `request.input(…)` — which is the CORRECT pattern
 * this rule exists to recommend. A rule that punishes its own fix is worse than
 * no rule, so the body must be the body, syntactically.
 */

/** ORM methods that WRITE. A read taking the body is a different rule's business. */
const WRITE_METHODS = new Set([
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "insert",
  "save",
  "bulkCreate",
  "findOneAndUpdate",
  "findByIdAndUpdate",
  "updateOne",
  "updateMany",
  "insertOne",
  "insertMany",
  "replaceOne",
]);

/** Option keys whose value is the record being written. */
const DATA_KEYS = new Set(["data", "values", "set", "$set", "create", "update"]);

/** Calls that NARROW, so their result is no longer the whole body. */
const NARROWING_CALLS = new Set([
  "parse",
  "safeParse",
  "validate",
  "validateAsync",
  "validateSync",
  "pick",
  "omit",
  "cast",
  "sanitize",
  "strip",
  "clean",
]);

/**
 * Wrappers TypeScript ERASES. `req.body as UserDto` compiles to `req.body` —
 * the assertion performs no runtime check and produces the identical value, so
 * it is not a narrowing and must not read as one.
 *
 * This mattered: the structural match below is deliberately exact (it is what
 * fixed 743 false positives), and being exact meant every TypeScript spelling
 * slipped past — `as T`, `as any`, `satisfies T`, `!`, `<T>x`, and each of them
 * wrapped in parentheses. In a TypeScript codebase `create({ data: req.body as
 * UserDto })` is the IDIOMATIC form, so the rule was close to blind exactly
 * where the assertion makes the developer most confident it was validated.
 */
const TYPE_WRAPPERS = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
  "ParenthesizedExpression",
]);

/** Strip every erased wrapper to reach the value that actually exists at runtime. */
const unwrapErased = (node: AstNode | null | undefined): AstNode | null | undefined => {
  let current = node;
  for (let depth = 0; current && depth < 8; depth++) {
    if (!TYPE_WRAPPERS.has(current.type as string)) return current;
    current = (current.expression ?? current.argument) as AstNode | undefined;
  }
  return current;
};

/** The request members that are the caller's own object, whole. */
const BODY_MEMBERS = new Set(["body", "query", "params"]);

/** Is this literally `<requestRoot>.body` / `.query` / `.params`? */
const isBodyMember = (raw: AstNode | null | undefined): boolean => {
  const node = unwrapErased(raw);
  if (!node || node.type !== "MemberExpression" || node.computed) return false;
  const object = node.object as AstNode | undefined;
  const property = (node.property as AstNode | undefined)?.name;
  return (
    object?.type === "Identifier" &&
    REQUEST_ROOTS.has(object.name as string) &&
    typeof property === "string" &&
    BODY_MEMBERS.has(property)
  );
};

export const noMassAssignment = defineDiagnostic({
  id: "no-mass-assignment",
  title: "Whole request body written into a record (mass assignment)",
  severity: "error",
  category: "Security",
  confidence: "high",
  tags: ["security", "authz", "injection"],
  recommendation:
    "Pick the fields explicitly — `const { email, name } = req.body` — or validate into a known shape (`schema.parse(req.body)`) before the write. Passing the whole body lets the caller set every column the model has, including the ones no form shows: `role`, `credits`, `emailVerified`, `tenantId`.",
  create: (ctx) => {
    /**
     * Is this expression the request body OBJECT, un-narrowed?
     *
     * Deliberately syntactic. A binding counts only when its initializer IS the
     * body member — a direct alias, `const body = req.body`. A value the author
     * assembled from request FIELDS is a different object with the keys they
     * chose, which is the fix, not the bug.
     */
    const isWholeBody = (raw: AstNode | null | undefined, depth = 0): boolean => {
      const node = unwrapErased(raw);
      if (!node || depth > 4) return false;
      if (isBodyMember(node)) return true;
      if (node.type === "ObjectExpression") {
        // `{ ...req.body, id }` still carries every attacker-settable key.
        return ((node.properties as AstNode[] | undefined) ?? []).some(
          (p) => p.type === "SpreadElement" && isWholeBody(p.argument as AstNode, depth + 1),
        );
      }
      if (node.type !== "Identifier") return false;
      const binding = ctx.scope.getBinding(node.name as string, node);
      return isWholeBody(binding?.initNode as AstNode | undefined, depth + 1);
    };

    const report = (node: AstNode, how: string): void => {
      ctx.report(
        node,
        `${how} reaches this write un-narrowed, so the caller sets **every column the model has** — not just the ones the form showed them. Adding \`"role": "ADMIN"\` to the JSON is the whole exploit. Tests miss it because they post the fields the form posts, and the type checker misses it because \`req.body\` is \`any\`. Destructure the fields you mean, or validate into a known shape first.`,
      );
    };

    return {
      CallExpression: (node) => {
        const method = getMethodName(node);
        const args = (node.arguments as AstNode[] | undefined) ?? [];

        // `Object.assign(record, req.body)` — every source key lands on the target.
        if (method === "assign" && getReceiverName(node) === "Object") {
          const target = args[0];
          // Assigning ONTO a fresh literal builds a new object; it writes nothing.
          if (!target || target.type === "ObjectExpression") return;
          for (const source of args.slice(1)) {
            if (isWholeBody(source)) {
              report(source, "The whole request body");
              return;
            }
          }
          return;
        }

        if (method === null || !WRITE_METHODS.has(method)) return;
        // A narrowing call in the chain means this is no longer the raw body.
        if (NARROWING_CALLS.has(method)) return;

        for (const arg of args) {
          // `save(req.body)` / `insert(req.body)` — the record, positionally.
          if (isWholeBody(arg)) {
            report(arg, "The whole request body");
            return;
          }
          if (arg.type !== "ObjectExpression") continue;
          for (const prop of (arg.properties as AstNode[] | undefined) ?? []) {
            if (prop.type !== "Property" || prop.computed) continue;
            const key = prop.key as AstNode | undefined;
            const keyName = key?.type === "Identifier" ? (key.name as string) : (key?.value as string | undefined);
            if (typeof keyName !== "string" || !DATA_KEYS.has(keyName)) continue;
            const value = prop.value as AstNode | undefined;
            if (value && isWholeBody(value)) {
              report(value, `The whole request body, as \`${keyName}\`,`);
              return;
            }
          }
        }
      },
    };
  },
});
