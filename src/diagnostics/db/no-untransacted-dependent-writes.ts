import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { findAncestor, getMethodName, isFunctionLike, staticMemberPath } from "../../core/ast.ts";
import { collectDescendants, findDescendant } from "../../core/walk.ts";
import { isTestFile } from "../../core/test-file.ts";

/**
 * A second write that depends on the first, with no transaction around either.
 *
 *   ❌ const workflow = await prisma.workflow.create({ data });
 *      await prisma.workflowStep.create({ data: { workflowId: workflow.id } });
 *   ✅ await prisma.$transaction(async (tx) => {
 *        const workflow = await tx.workflow.create({ data });
 *        await tx.workflowStep.create({ data: { workflowId: workflow.id } });
 *      });
 *
 * Outside a transaction every statement is its own committed transaction. So if
 * the second write fails, the first is already durable and nothing rolls it
 * back. Demonstrated at the driver level rather than asserted — the same two
 * writes, run with and without `BEGIN`:
 *
 *   write2 threw: CHECK constraint failed
 *   orders rows after failure (NO tx):   1     ← the first write is COMMITTED
 *   orders rows after failure (WITH tx): 0
 *
 * What survives is a row that the rest of the system believes cannot exist: a
 * workflow with no steps, an organization whose owner has no membership, a
 * booking with no meeting token, a credit expense logged against a balance that
 * was never debited. None of it raises an error at the time, and the request that
 * created it has already returned. It surfaces later as a NOT NULL violation, an
 * empty list, or a number that does not add up — arbitrarily far from the cause.
 *
 * PRECISION MODEL. This rule was refuted once before it shipped, and the
 * refutation is what the model is built from. Two earlier framings were rejected
 * outright, both for being defended by naming accident rather than by proof:
 *
 *   - **Receiver name hints do not prove a database.** The repo's own
 *     `DB_RECEIVER_HINTS` matches `client`, `conn`, `repo`, `repository` and so
 *     returns true for all 20 SDK clients tested — Stripe, Twilio, S3,
 *     Elasticsearch — plus a real `retellRepository.createLLM(…)` →
 *     `createAgent(…)` pair and jsforce's `conn.sobject(Lead).create(…)` →
 *     `.update(…)`, both of which are correct code one rename away from firing.
 *     So this rule requires POSITIVE proof of Prisma instead: a `prisma`-prefixed
 *     segment in the receiver path, or a root that resolves to a `PrismaClient`
 *     construction or a Prisma import. No SDK is named `prisma`.
 *   - **`await` does not prove a write happened.** TypeORM's
 *     `repository.create()` builds an entity in memory and writes nothing —
 *     verified, 0 rows — and `await` on a non-promise is legal and simply yields
 *     the value. The write set here is Prisma's, named explicitly, and is not
 *     `QUERY_METHODS`, which contains `findMany`, `count` and `aggregate`.
 *
 * The dependence test is the other half, and it is what makes the pair provably
 * one unit of work rather than two unrelated writes: **W2 must reference the
 * value W1 returned.** Every true positive found in the corpus has this shape —
 * `workflowStep.create({ workflowId: workflow.id })`,
 * `membership.create({ userId: ownerInDb.id })`,
 * `instantMeetingToken.create({ booking: { connect: { id: newBooking.id } } })`.
 * Two writes that share no value are not shown to be one unit of work, and are
 * silent.
 *
 * Then, each from a case the refutation surfaced:
 *
 *   - **Same statement list.** W2 must sit directly alongside W1, not inside an
 *     `if`, `try` or loop that W1 is outside of. A guarded W2 —
 *     `if (!user.defaultScheduleId) await prisma.user.update(…)` — is a
 *     conditional refinement whose failure leaves a usable record, and the
 *     author writing the guard is evidence they considered the branch.
 *   - **A destructive W2 is a compensating rollback**, not a dependent write:
 *     `const team = await …create(…)` then `await …delete(team.id)` in a
 *     failure branch is the correct manual undo.
 *   - **Same model twice is a status transition**, not a multi-entity write.
 *   - **Transaction handles and explicit options.** A `tx`/`trx`/`queryRunner`
 *     segment, or any argument carrying `transaction`/`session`/`trx`, means a
 *     transaction is already in play.
 *   - **Test, seed and fixture files** are the single largest noise class —
 *     half-applied state is irrelevant where the database is thrown away.
 *   - **Ambient transactions.** `cls-hooked`, `typeorm-transactional` and
 *     `nestjs-cls` open a transaction in AsyncLocalStorage, so a write can be
 *     inside one with NO evidence at the call site. Lexical analysis is unsound
 *     on such a project, so the whole rule disables itself via
 *     `disabledWhen: ["ambient-transaction"]`. None appeared in the corpus, but
 *     the unsoundness is real and silence is the only correct response to it.
 */

/**
 * Prisma writes that RETURN the created or updated record — the only ones whose
 * result a later write can depend on. Explicitly enumerated; `QUERY_METHODS` is
 * not usable here because it contains reads.
 */
const PRODUCING_WRITES = new Set(["create", "update", "upsert", "createManyAndReturn"]);

/**
 * Writes that may DEPEND on an earlier one. `delete`/`deleteMany` are absent on
 * purpose: a destructive second write is a compensating rollback.
 */
const DEPENDENT_WRITES = new Set(["create", "createMany", "createManyAndReturn", "update", "updateMany", "upsert"]);

/** A receiver segment proving a transaction is already open. */
const TRANSACTION_HANDLES = new Set(["tx", "trx", "transaction", "queryRunner", "session"]);

/** Option keys that pass an explicit transaction to the driver. */
const TRANSACTION_OPTION_KEYS = new Set(["transaction", "session", "trx", "tx", "queryRunner"]);

/**
 * Files where half-applied state does not matter, by path convention.
 *
 * This runs ALONGSIDE the repo's `isTestFile`, not instead of it. That helper
 * demands proof — a runner import, or a test path AND real test declarations —
 * so a `.test.ts` holding only helper code is correctly not "provably a test".
 * For this rule the path alone is enough: nothing in a test, seed or fixture
 * tree has production data to leave half-applied. The refutation measured this
 * as the single largest noise class, at ~246 hits.
 */
const SEED_OR_FIXTURE =
  /(^|[/\\])(seed|seeds|fixtures?|factories|playwright|e2e|examples?|scripts|__tests__|tests?|spec)[/\\]|[.-](seed|fixture|factory|test|spec|e2e)\.[cm]?[jt]sx?$/i;

/** Path segments naming a Prisma client, e.g. `prisma`, `prismaClient`, `prismaWrite`. */
const isPrismaSegment = (segment: string): boolean => /^prisma/i.test(segment);

export const noUntransactedDependentWrites = defineDiagnostic({
  id: "no-untransacted-dependent-writes",
  title: "Dependent writes with no transaction, so a failure leaves half of it committed",
  severity: "warn",
  category: "Reliability",
  confidence: "high",
  tags: ["database", "transaction", "data-integrity", "prisma"],
  requires: ["prisma"],
  disabledWhen: ["ambient-transaction"],
  recommendation:
    "Wrap both writes in `prisma.$transaction(async (tx) => { … })` and issue them on `tx`. Outside a transaction each statement commits on its own, so if the second write fails the first is already durable and nothing undoes it — leaving a record the rest of the system believes cannot exist (a parent with no child, a balance moved with no ledger row). Nothing errors at the time; it surfaces later, far from the cause.",
  create: (ctx) => {
    let inert: boolean | null = null;

    /**
     * The receiver path of a call, as segments, or `null` if it is not a static
     * member path. `prisma.workflow.create(…)` → `["prisma", "workflow"]`.
     */
    const receiverSegments = (call: AstNode): string[] | null => {
      const callee = call.callee as AstNode | undefined;
      if (callee?.type !== "MemberExpression") return null;
      const path = staticMemberPath(callee.object as AstNode);
      if (path === null) return null;
      return path.split(".");
    };

    /**
     * Does this receiver PROVE a Prisma client? Either a `prisma`-prefixed
     * segment, or a root identifier that resolves to `new PrismaClient()` or to
     * an import from a Prisma module. Name hints alone are never enough.
     */
    const provesPrisma = (segments: string[], atNode: AstNode): boolean => {
      if (segments.some(isPrismaSegment)) return true;
      const root = segments[0];
      if (root === undefined || root === "this") return false;
      const binding = ctx.scope.getBinding(root, atNode);
      if (!binding) return false;

      const init = binding.initNode as AstNode | undefined;
      // `const db = new PrismaClient()`
      if (
        init?.type === "NewExpression" &&
        (init.callee as AstNode | undefined)?.type === "Identifier" &&
        /^PrismaClient$/.test(String((init.callee as AstNode).name))
      ) {
        return true;
      }
      // `import { db } from "~/server/prisma"` — the specifier's source.
      const declaration = (binding.declNode as AstNode | undefined)?.parent as AstNode | undefined;
      if (declaration?.type === "ImportDeclaration") {
        const source = (declaration.source as AstNode | undefined)?.value;
        if (typeof source === "string" && /(^|[/@])prisma($|[/.-])/i.test(source)) return true;
      }
      return false;
    };

    /** The statement directly inside a block, plus that block — for adjacency. */
    const statementInBlock = (node: AstNode): { statement: AstNode; block: AstNode } | null => {
      let current: AstNode | null | undefined = node;
      for (let depth = 0; current && depth < 256; depth++) {
        const parent = current.parent as AstNode | null | undefined;
        if (!parent) return null;
        if (parent.type === "BlockStatement" || parent.type === "Program") {
          return { statement: current, block: parent };
        }
        current = parent;
      }
      return null;
    };

    /** Is this call inside a `$transaction` / `transaction` callback? */
    const insideTransactionCallback = (node: AstNode): boolean =>
      findAncestor(node, (n) => {
        if (n.type !== "CallExpression") return false;
        const method = getMethodName(n);
        return method === "$transaction" || method === "transaction";
      }) !== null;

    /** Does any argument carry an explicit transaction/session option? */
    const passesTransactionOption = (call: AstNode): boolean => {
      for (const arg of (call.arguments as AstNode[] | undefined) ?? []) {
        const found = findDescendant(
          arg,
          (n) => {
            if (n.type !== "Property") return false;
            const key = n.key as AstNode | undefined;
            const name = key?.type === "Identifier" ? String(key.name) : null;
            return name !== null && TRANSACTION_OPTION_KEYS.has(name);
          },
          () => false,
        );
        if (found) return true;
      }
      return false;
    };

    /** Names bound by `const x = …` or `const { a, b } = …`. */
    const boundNames = (id: AstNode): string[] => {
      if (id.type === "Identifier") return [String(id.name)];
      if (id.type === "ObjectPattern") {
        const names: string[] = [];
        for (const property of (id.properties as AstNode[] | undefined) ?? []) {
          const value = (property.value ?? property.argument) as AstNode | undefined;
          if (value?.type === "Identifier") names.push(String(value.name));
        }
        return names;
      }
      return [];
    };

    return {
      Program: (root) => {
        inert = isTestFile(ctx.program, ctx.normalizedFilePath) || SEED_OR_FIXTURE.test(ctx.normalizedFilePath);
        if (inert) return;

        for (const fn of [root, ...collectDescendants(root, isFunctionLike)]) {
          const body = (fn.type === "Program" ? fn : (fn.body as AstNode | undefined)) as AstNode | undefined;
          if (!body) continue;

          // Every producing write in THIS function (not nested ones).
          const producers: Array<{ call: AstNode; names: string[]; model: string; block: AstNode; statement: AstNode }> = [];

          for (const call of collectDescendants(body, (n) => n.type === "CallExpression")) {
            // Only writes belonging to THIS function body. At Program level that
            // means top-level code only — without this, every call inside a
            // function is judged twice, once here and once by its own function.
            const owner = findAncestor(call, isFunctionLike);
            if (fn.type === "Program" ? owner !== null : owner !== fn) continue;

            const method = getMethodName(call);
            if (method === null || !PRODUCING_WRITES.has(method)) continue;
            if (insideTransactionCallback(call)) continue;
            if (passesTransactionOption(call)) continue;

            const segments = receiverSegments(call);
            if (!segments || segments.some((s) => TRANSACTION_HANDLES.has(s))) continue;
            if (!provesPrisma(segments, call)) continue;

            // `const x = await prisma.model.create(…)` — the binding is required:
            // without it nothing downstream can depend on the result.
            const awaited = call.parent as AstNode | undefined;
            if (awaited?.type !== "AwaitExpression") continue;
            const declarator = awaited.parent as AstNode | undefined;
            if (declarator?.type !== "VariableDeclarator") continue;
            const names = boundNames(declarator.id as AstNode);
            if (names.length === 0) continue;

            const placed = statementInBlock(call);
            if (!placed) continue;
            producers.push({
              call,
              names,
              model: segments[segments.length - 1] ?? "",
              block: placed.block,
              statement: placed.statement,
            });
          }

          if (producers.length === 0) continue;

          for (const call of collectDescendants(body, (n) => n.type === "CallExpression")) {
            const owner = findAncestor(call, isFunctionLike);
            if (fn.type === "Program" ? owner !== null : owner !== fn) continue;

            const method = getMethodName(call);
            if (method === null || !DEPENDENT_WRITES.has(method)) continue;
            if (insideTransactionCallback(call)) continue;
            if (passesTransactionOption(call)) continue;

            const segments = receiverSegments(call);
            if (!segments || segments.some((s) => TRANSACTION_HANDLES.has(s))) continue;
            if (!provesPrisma(segments, call)) continue;

            const model = segments[segments.length - 1] ?? "";
            const placed = statementInBlock(call);
            if (!placed) continue;

            for (const producer of producers) {
              if (producer.call === call) continue;
              // A status transition on the same model is not a multi-entity write.
              if (producer.model === model) continue;
              // W2 must sit directly alongside W1 — not inside a guard, try or loop.
              if (producer.block !== placed.block) continue;
              if ((producer.call.start as number) >= (call.start as number)) continue;

              // The dependence proof: W2 must use what W1 returned.
              const uses = ((call.arguments as AstNode[] | undefined) ?? []).some((arg) =>
                findDescendant(
                  arg,
                  (n) => n.type === "Identifier" && producer.names.includes(String(n.name)),
                  () => false,
                ) !== null,
              );
              if (!uses) continue;

              ctx.report(
                call,
                `This write depends on the \`${producer.model}\` written just above — it uses the record that write returned — but neither is in a transaction, so each commits on its own. If this one fails, the \`${producer.model}\` is already durable and nothing rolls it back, leaving a row the rest of the system believes cannot exist: a parent with no child, a balance moved with no ledger entry. Nothing errors at the time and the request has already returned, so it surfaces later as a NOT NULL violation or a number that does not add up, far from the cause. Wrap both in \`prisma.$transaction(async (tx) => { … })\` and issue them on \`tx\`.`,
              );
              break;
            }
          }
        }
      },
    };
  },
});
