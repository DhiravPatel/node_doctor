/**
 * §14 — `no-untransacted-dependent-writes`.
 *
 * Outside a transaction every statement commits on its own, so if the second of
 * two dependent writes fails, the first is already durable. Demonstrated at the
 * driver level: the same two writes left 1 row behind without `BEGIN` and 0 rows
 * with it.
 *
 * The silence cases below are not hypothetical. Every one under "the refutation"
 * is a real counter-example an adversarial reviewer produced against an earlier
 * version of this rule, which was refuted and rebuilt because of them.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noUntransactedDependentWrites } from "../../src/diagnostics/db/no-untransacted-dependent-writes.ts";

const findings = (
  source: string,
  filePath = "/repo/src/services/orders.ts",
  capabilities = ["node", "esm", "typescript", "prisma"],
) =>
  lintSource({
    filePath,
    sourceText: source,
    diagnostics: [noUntransactedDependentWrites],
    capabilities: new Set(capabilities),
  }).findings.filter((f) => f.diagnostic === "no-untransacted-dependent-writes");

const fires = (source: string, filePath?: string) => {
  const found = findings(source, filePath);
  assert.ok(found.length > 0, `expected a FIRE on:\n${source}`);
  return found;
};
const silent = (source: string, filePath?: string, capabilities?: string[]): void =>
  assert.equal(findings(source, filePath, capabilities).length, 0, `expected SILENCE on:\n${source}`);

describe("no-untransacted-dependent-writes", () => {
  describe("the defect, as found in cal.com", () => {
    test("workflow.create then workflowStep.create using its id", () => {
      fires(`
        async function handler() {
          const workflow = await prisma.workflow.create({ data: { name } });
          await prisma.workflowStep.create({ data: { stepNumber: 1, workflowId: workflow.id } });
        }
      `);
    });

    test("booking.create then a token connected to it", () => {
      fires(`
        async function handler() {
          const newBooking = await prisma.booking.create(createBookingObj);
          const token = await prisma.instantMeetingToken.create({
            data: { token: t, booking: { connect: { id: newBooking.id } } },
          });
        }
      `);
    });

    test("a `ctx.prisma` path proves the client just as well", () => {
      fires(`
        async function handler(ctx) {
          const workflow = await ctx.prisma.workflow.create({ data: {} });
          await ctx.prisma.workflowStep.create({ data: { workflowId: workflow.id } });
        }
      `);
    });

    test("a destructured binding still carries the dependence", () => {
      fires(`
        async function handler() {
          const { id } = await prisma.workflow.create({ data: {} });
          await prisma.workflowStep.create({ data: { workflowId: id } });
        }
      `);
    });

    test("createMany as the dependent write", () => {
      fires(`
        async function handler(options) {
          const attribute = await prisma.attribute.create({ data: {} });
          await prisma.attributeOption.createMany({
            data: options.map((o) => ({ attributeId: attribute.id })),
          });
        }
      `);
    });

    test("the message names the model left half-committed", () => {
      const [finding] = fires(`
        async function handler() {
          const workflow = await prisma.workflow.create({ data: {} });
          await prisma.workflowStep.create({ data: { workflowId: workflow.id } });
        }
      `);
      assert.match(finding!.message, /workflow/);
      assert.match(finding!.message, /\$transaction/);
    });

    test("reports once, not once per enclosing scope", () => {
      const found = fires(`
        async function handler() {
          const workflow = await prisma.workflow.create({ data: {} });
          await prisma.workflowStep.create({ data: { workflowId: workflow.id } });
        }
      `);
      assert.equal(found.length, 1);
    });
  });

  describe("proving the receiver is a database, not an SDK", () => {
    test("a client resolved from `new PrismaClient()`", () => {
      fires(`
        const db = new PrismaClient();
        async function handler() {
          const workflow = await db.workflow.create({ data: {} });
          await db.workflowStep.create({ data: { workflowId: workflow.id } });
        }
      `);
    });

    test("a client imported from a prisma module", () => {
      fires(`
        import { db } from "~/server/prisma";
        async function handler() {
          const workflow = await db.workflow.create({ data: {} });
          await db.workflowStep.create({ data: { workflowId: workflow.id } });
        }
      `);
    });

    test("an unproven receiver is never judged", () => {
      silent(`
        async function handler() {
          const workflow = await repo.workflow.create({ data: {} });
          await repo.workflowStep.create({ data: { workflowId: workflow.id } });
        }
      `);
    });
  });

  describe("the refutation — real counter-examples that must stay silent", () => {
    test("Retell AI: retellRepository.createLLM then createAgent", () => {
      silent(`
        async function handler() {
          const llm = await this.deps.retellRepository.createLLM(llmRequest);
          const agent = await this.deps.retellRepository.createAgent({ llm_id: llm.llm_id });
        }
      `);
    });

    test("jsforce: conn.sobject(Lead).create then update", () => {
      silent(`
        async function handler() {
          const result = await conn.sobject("Lead").create(createBody);
          await conn.sobject("Lead").update({ Id: result.id });
        }
      `);
    });

    test("Stripe: a customer then a subscription referencing it", () => {
      silent(`
        async function handler() {
          const customer = await stripeClient.customers.create(data);
          await stripeClient.subscriptions.create({ customer: customer.id });
        }
      `);
    });

    test("a guarded second write is a refinement, not a dependent write", () => {
      silent(`
        async function handler(user) {
          const schedule = await prisma.schedule.create({ data: {} });
          if (!user.defaultScheduleId) {
            await prisma.user.update({ data: { defaultScheduleId: schedule.id } });
          }
        }
      `);
    });

    test("a destructive second write is a compensating rollback", () => {
      silent(`
        async function handler() {
          const team = await prisma.team.create({ data: {} });
          await prisma.membership.delete({ where: { id: team.id } });
        }
      `);
    });

    test("the same model twice is a status transition", () => {
      silent(`
        async function handler() {
          const review = await prisma.prReview.upsert({ data: {} });
          await prisma.prReview.update({ where: { id: review.id }, data: { done: true } });
        }
      `);
    });

    test("a second write in a try the first is outside of", () => {
      silent(`
        async function handler() {
          const workflow = await prisma.workflow.create({ data: {} });
          try {
            await prisma.workflowStep.create({ data: { workflowId: workflow.id } });
          } catch {}
        }
      `);
    });

    test("ambient transactions disable the rule entirely", () => {
      silent(
        `async function handler() {
          const workflow = await prisma.workflow.create({ data: {} });
          await prisma.workflowStep.create({ data: { workflowId: workflow.id } });
        }`,
        undefined,
        ["node", "esm", "typescript", "prisma", "ambient-transaction"],
      );
    });
  });

  describe("a transaction is already in play", () => {
    test("both writes on a `tx` handle inside $transaction", () => {
      silent(`
        async function handler() {
          await prisma.$transaction(async (tx) => {
            const workflow = await tx.workflow.create({ data: {} });
            await tx.workflowStep.create({ data: { workflowId: workflow.id } });
          });
        }
      `);
    });

    test("an explicit transaction option passed to the driver", () => {
      silent(`
        async function handler(t) {
          const workflow = await prisma.workflow.create({ data: {}, transaction: t });
          await prisma.workflowStep.create({ data: { workflowId: workflow.id }, transaction: t });
        }
      `);
    });
  });

  describe("dependence and scope", () => {
    test("two writes that share no value are not shown to be one unit of work", () => {
      silent(`
        async function handler() {
          const audit = await prisma.audit.create({ data: {} });
          await prisma.user.update({ where: { id: 1 }, data: { seen: true } });
        }
      `);
    });

    test("an unbound first write cannot be depended on", () => {
      silent(`
        async function handler() {
          await prisma.workflow.create({ data: {} });
          await prisma.workflowStep.create({ data: { workflowId: 1 } });
        }
      `);
    });

    test("a nested closure is a different function", () => {
      silent(`
        async function handler(items) {
          const workflow = await prisma.workflow.create({ data: {} });
          items.forEach(async () => {
            await prisma.workflowStep.create({ data: { workflowId: workflow.id } });
          });
        }
      `);
    });

    test("a project without Prisma never runs the rule", () => {
      silent(
        `async function handler() {
          const workflow = await prisma.workflow.create({ data: {} });
          await prisma.workflowStep.create({ data: { workflowId: workflow.id } });
        }`,
        undefined,
        ["node", "esm", "typescript"],
      );
    });
  });

  describe("test, seed and fixture trees", () => {
    test("a .test.ts path is excluded", () => {
      silent(
        `async function handler() {
          const workflow = await prisma.workflow.create({ data: {} });
          await prisma.workflowStep.create({ data: { workflowId: workflow.id } });
        }`,
        "/repo/src/workflows.test.ts",
      );
    });

    test("a seed script is excluded", () => {
      silent(
        `async function handler() {
          const workflow = await prisma.workflow.create({ data: {} });
          await prisma.workflowStep.create({ data: { workflowId: workflow.id } });
        }`,
        "/repo/prisma/seed/main.ts",
      );
    });

    test("a playwright tree is excluded", () => {
      silent(
        `async function handler() {
          const workflow = await prisma.workflow.create({ data: {} });
          await prisma.workflowStep.create({ data: { workflowId: workflow.id } });
        }`,
        "/repo/playwright/fixtures/users.ts",
      );
    });
  });
});
