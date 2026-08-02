"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  payloadIsInvestTab,
  cancelPendingInvestSchedules,
} = require("../src/lib/schedulePayloads");

test("payloadIsInvestTab matches only invest tab objects", () => {
  assert.equal(payloadIsInvestTab({ tab: "invest", amountMinor: 100 }), true);
  assert.equal(payloadIsInvestTab({ tab: "expense", amountMinor: 100 }), false);
  assert.equal(payloadIsInvestTab({ tab: "income" }), false);
  assert.equal(payloadIsInvestTab(null), false);
  assert.equal(payloadIsInvestTab(["invest"]), false);
  assert.equal(payloadIsInvestTab("invest"), false);
});

test("cancelPendingInvestSchedules cancels only invest payloads", async () => {
  const updates = [];
  const tx = {
    pendingTransactionSchedule: {
      findMany: async (args) => {
        assert.deepEqual(args, {
          where: {
            accountId: "account-1",
            status: "PENDING",
            cancelledAt: null,
          },
          select: {
            id: true,
            payload: true,
          },
        });
        return [
          {
            id: "sch-invest",
            payload: {
              tab: "invest",
              amountMinor: 1000,
              categoryId: "cat-inv",
              instrumentId: "inst-1",
              quantity: 1,
            },
          },
          {
            id: "sch-expense",
            payload: { tab: "expense", amountMinor: 500, categoryId: "cat-exp" },
          },
          {
            id: "sch-null",
            payload: null,
          },
        ];
      },
      update: async ({ where, data }) => {
        updates.push({ where, data });
        return { id: where.id };
      },
    },
  };

  const cancelled = await cancelPendingInvestSchedules(tx, "account-1");

  assert.equal(cancelled, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].where.id, "sch-invest");
  assert.equal(updates[0].data.status, "CANCELLED");
  assert.ok(updates[0].data.cancelledAt instanceof Date);
});

test("cancelPendingInvestSchedules is a no-op when none are invest", async () => {
  const updates = [];
  const tx = {
    pendingTransactionSchedule: {
      findMany: async () => [
        { id: "sch-1", payload: { tab: "income", amountMinor: 1, categoryId: "c" } },
      ],
      update: async (args) => {
        updates.push(args);
      },
    },
  };

  const cancelled = await cancelPendingInvestSchedules(tx, "account-2");
  assert.equal(cancelled, 0);
  assert.equal(updates.length, 0);
});
