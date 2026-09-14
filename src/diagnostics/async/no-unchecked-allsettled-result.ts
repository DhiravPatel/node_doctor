import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { findEnclosingFunction, isFunctionLike } from "../../core/ast.ts";
import { collectDescendants, findDescendant } from "../../core/walk.ts";

/**
 * A `Promise.allSettled` result whose `.value` is read without anyone ever
 * looking at `.status`. `allSettled` exists precisely so that a rejection does
 * not reject the whole batch — so a rejected entry has no `value` at all, and
 * reading it gives `undefined` with nothing thrown anywhere.
 *
 *   ❌ const [user, orders] = await Promise.allSettled([getUser(), getOrders()]);
 *      return { user: user.value, orders: orders.value };      // undefined on failure
 *   ❌ const rows = (await Promise.allSettled(jobs)).map((r) => r.value);
 *   ✅ if (user.status === "rejected") throw user.reason;
 *   ✅ const rows = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
 *
 * MEASURED on Node 22, one fulfilled and one rejected:
 *
 *   raw                        [{"status":"fulfilled","value":{"id":1}},{"status":"rejected","reason":{}}]
 *   b.value                    undefined
 *   b.value?.id                undefined
 *   results.map(r => r.value)  [{"id":1}, undefined]
 *   Promise.allSettled itself  never rejects — nothing throws, at all
 *
 * And measured on the response shape this actually produces, with `getOrders()`
 * rejecting:
 *
 *   return { user: user.value, orders: orders.value }   →   {"user":{"id":"u1"}}
 *
 * The `orders` key is not `null`. It is **absent**, because `JSON.stringify`
 * drops an `undefined` property — so the client cannot even tell the field was
 * meant to be there.
 *
 * **Choosing `allSettled` over `all` IS the decision to handle failures
 * individually**, and reading only `.value` walks that decision back without
 * saying so. `Promise.all` would at least have rejected loudly. Here the batch
 * resolves, the handler returns 200, and the failed half of the response is
 * `undefined` — so the caller stores a null, or renders an empty section, or
 * writes the missing field back as a deletion. The cost lands downstream, at a
 * point where nothing in the logs connects it to a failed upstream call.
 *
 * PRECISION MODEL. The claim is not "you read `.value`" — that is the normal use
 * — it is "you read `.value` and NOTHING in this function ever looks at whether
 * the entry succeeded". Every one of these silences it:
 *
 *   - Any read of `.status` or `.reason` on the binding, anywhere in the enclosing
 *     function, however it is spelled: a comparison, a `filter`, a `switch`, a
 *     destructure (`const { status, value } = r`), a helper's parameter.
 *   - Any `"fulfilled"` or `"rejected"` string literal in the function, which is
 *     how every hand-rolled narrowing helper is written.
 *   - A result passed onward unread, or returned whole; the caller's business.
 *
 * The binding must come from an `await Promise.allSettled(…)` (or its `.then`),
 * because only then is the shape known. `Promise.all` results have no `.value`
 * wrapper and are never matched. A binding that is re-declared, re-assigned, or
 * shadowed by a nested function's own parameter is dropped entirely — the scope
 * resolver does not model nested blocks, so that is a whole-body name check
 * rather than a resolution.
 *
 * Both spellings of the read are covered: a destructured element
 * (`const [a, b] = await Promise.allSettled(…)`, then `a.value`) and the array
 * form (`results.map((r) => r.value)`), where the callback's own parameter is
 * followed into the callback body.
 */

/** Reading either of these is proof the author thought about the rejected case. */
const SETTLEMENT_MEMBERS = new Set(["status", "reason"]);

/** Array methods whose callback receives one settlement result per element. */
const ELEMENT_CALLBACKS = new Set(["map", "forEach", "filter", "find", "flatMap", "some", "every", "reduce"]);

/** Is this expression an `await Promise.allSettled(…)`? */
const isAwaitedAllSettled = (node: AstNode | null | undefined): boolean => {
  if (!node) return false;
  const inner = node.type === "AwaitExpression" ? (node.argument as AstNode | undefined) : node;
  if (!inner || inner.type !== "CallExpression") return false;
  const callee = inner.callee as AstNode | undefined;
  if (callee?.type !== "MemberExpression" || callee.computed) return false;
  const object = callee.object as AstNode | undefined;
  const property = callee.property as AstNode | undefined;
  return (
    object?.type === "Identifier" &&
    String(object.name) === "Promise" &&
    property?.type === "Identifier" &&
    String(property.name) === "allSettled"
  );
};

/** Every identifier reference to `name` inside `root` that is a real read. */
const referencesTo = (root: AstNode, name: string): AstNode[] =>
  collectDescendants(root, (n) => {
    if (n.type !== "Identifier" || String(n.name) !== name) return false;
    const parent = n.parent as AstNode | undefined;
    if (parent?.type === "MemberExpression" && parent.property === n && !parent.computed) return false;
    if (parent?.type === "Property" && parent.key === n && !parent.computed) return false;
    return true;
  });

/**
 * Is the name re-declared, written to, or taken as a nested function's own
 * parameter anywhere in the scope? Any of those and the rule stops reasoning.
 *
 * `own` is the declarator that introduced the binding, which lives inside the
 * scope being searched and must not count as a redeclaration of itself.
 */
const isRebound = (scope: AstNode, name: string, own: AstNode | null = null): boolean =>
  findDescendant(scope, (n) => {
    if (n === own) return false;
    if (n.type === "VariableDeclarator" || n.type === "FunctionDeclaration" || n.type === "ClassDeclaration") {
      const id = n.id as AstNode | undefined;
      if (id?.type === "Identifier" && String(id.name) === name) return true;
    }
    if (n.type === "AssignmentExpression") {
      const left = n.left as AstNode | undefined;
      return left?.type === "Identifier" && String(left.name) === name;
    }
    if (isFunctionLike(n)) {
      return ((n.params as AstNode[] | undefined) ?? []).some((p) => {
        const id = p.type === "AssignmentPattern" ? (p.left as AstNode | undefined) : p;
        return id?.type === "Identifier" && String(id.name) === name;
      });
    }
    return false;
  }) !== null;

/**
 * What does this scope do with the settlement bound to `name` — read its
 * `.value`, or check whether it settled? Returns the `.value` reads, or null as
 * soon as anything proves the rejected case was considered.
 */
const valueReadsWithoutCheck = (scope: AstNode, name: string): AstNode[] | null => {
  const reads: AstNode[] = [];
  for (const reference of referencesTo(scope, name)) {
    const parent = reference.parent as AstNode | undefined;

    // `const { status, value } = r` — a destructure that names either half.
    if (parent?.type === "VariableDeclarator" && parent.init === reference) {
      const id = parent.id as AstNode | undefined;
      if (id?.type !== "ObjectPattern") continue;
      let sawValue: AstNode | null = null;
      for (const property of ((id.properties as AstNode[] | undefined) ?? [])) {
        if (property.type !== "Property" || property.computed) return null;
        const key = property.key as AstNode | undefined;
        if (key?.type !== "Identifier") return null;
        if (SETTLEMENT_MEMBERS.has(String(key.name))) return null;
        if (String(key.name) === "value") sawValue = property;
      }
      if (sawValue) reads.push(sawValue);
      continue;
    }

    if (parent?.type !== "MemberExpression" || parent.object !== reference) continue;
    // `r[k]` — unreadable, so the rule cannot claim the check is absent.
    if (parent.computed) return null;
    const property = parent.property as AstNode | undefined;
    if (property?.type !== "Identifier") return null;
    const member = String(property.name);
    if (SETTLEMENT_MEMBERS.has(member)) return null;
    if (member === "value") reads.push(parent);
  }
  return reads;
};

export const noUncheckedAllsettledResult = defineDiagnostic({
  id: "no-unchecked-allsettled-result",
  title: "Promise.allSettled result read for .value with nothing ever checking .status",
  severity: "error",
  category: "Bugs",
  confidence: "high",
  tags: ["async", "correctness", "error-handling"],
  recommendation:
    'Check how the entry settled before reading it: `if (r.status === "rejected") throw r.reason`, or `results.filter((r) => r.status === "fulfilled").map((r) => r.value)`. A rejected settlement has NO `value` — measured on Node 22 it is `undefined`, and `Promise.allSettled` never rejects, so nothing throws. Choosing `allSettled` over `Promise.all` is the decision to handle failures one by one; reading only `.value` gives up that decision and turns a failed call into a silent `undefined`.',
  create: (ctx) => ({
    VariableDeclarator: (node) => {
      if (!isAwaitedAllSettled(node.init as AstNode)) return;
      // The enclosing function is the whole world the rule reasons about: a check
      // outside it cannot be seen, so anything beyond is treated as unknown.
      const search = findEnclosingFunction(node) ?? ctx.program;
      const id = node.id as AstNode | undefined;

      const report = (target: AstNode, label: string): void =>
        ctx.report(
          target,
          `This reads \`.value\` off a \`Promise.allSettled\` settlement, and nothing in ${label} ever checks \`.status\` or \`.reason\`. A REJECTED settlement has no \`value\`: measured on Node 22 it is \`undefined\`, and \`allSettled\` never rejects, so nothing throws and nothing is logged. Choosing \`allSettled\` over \`Promise.all\` is the decision to handle failures individually — \`Promise.all\` would at least have rejected loudly — so reading only \`.value\` turns a failed call into a silent \`undefined\`. Measured on the response this produces: \`return { user: user.value, orders: orders.value }\` with the orders call rejecting answers \`{"user":{"id":"u1"}}\` — the \`orders\` key is not null, it is ABSENT, because \`JSON.stringify\` drops an \`undefined\` property. Filter on \`r.status === "fulfilled"\` first, or throw \`r.reason\`.`,
        );

      // `const [user, orders] = await Promise.allSettled([...])`
      if (id?.type === "ArrayPattern") {
        for (const element of ((id.elements as (AstNode | null)[] | undefined) ?? [])) {
          if (!element || element.type !== "Identifier") continue;
          const name = String(element.name);
          if (isRebound(search, name, node)) continue;
          const reads = valueReadsWithoutCheck(search, name);
          if (reads === null) continue;
          for (const read of reads) report(read, `this function`);
        }
        return;
      }
      if (id?.type !== "Identifier") return;

      const name = String(id.name);
      if (isRebound(search, name, node)) return;
      // Any `"fulfilled"`/`"rejected"` literal is how narrowing helpers are written.
      if (findDescendant(search, (n) => n.type === "Literal" && (n.value === "fulfilled" || n.value === "rejected"))) {
        return;
      }

      // Direct reads: `results[0].value` is a member off an element, not the array.
      const direct = valueReadsWithoutCheck(search, name);
      if (direct === null) return;
      for (const read of direct) report(read, `this function`);

      // `results.map((r) => r.value)` — follow the callback's own parameter.
      for (const reference of referencesTo(search, name)) {
        const member = reference.parent as AstNode | undefined;
        if (member?.type !== "MemberExpression" || member.object !== reference || member.computed) continue;
        const method = member.property as AstNode | undefined;
        if (method?.type !== "Identifier" || !ELEMENT_CALLBACKS.has(String(method.name))) continue;
        const call = member.parent as AstNode | undefined;
        if (call?.type !== "CallExpression" || call.callee !== member) continue;

        const callback = ((call.arguments as AstNode[] | undefined) ?? [])[0];
        if (!isFunctionLike(callback)) continue;
        const params = (callback!.params as AstNode[] | undefined) ?? [];
        // `reduce` hands the element second; everything else hands it first.
        const element = String(method.name) === "reduce" ? params[1] : params[0];
        if (element?.type !== "Identifier") continue;

        const body = callback!.body as AstNode | undefined;
        if (!body) continue;
        const elementName = String(element.name);
        if (isRebound(body, elementName)) continue;
        const reads = valueReadsWithoutCheck(body, elementName);
        if (reads === null) continue;
        for (const read of reads) report(read, `this \`${String(method.name)}\` callback`);
      }
    },
  }),
});
