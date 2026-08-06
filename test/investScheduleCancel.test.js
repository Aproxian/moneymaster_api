"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  payloadIsInvestTab,
  payloadReferencesInstrument,
  cancelPendingInvestSchedulesForInstruments,
} = require("../src/lib/investScheduleCancel");

test("payloadIsInvestTab recognizes invest templates only", () => {
  assert.equal(payloadIsInvestTab({ tab: "invest", instrumentId: "i1" }), true);
  assert.equal(payloadIsInvestTab({ tab: "expense" }), false);
  assert.equal(payloadIsInvestTab(null), false);
  assert.equal(payloadIsInvestTab("invest"), false);
});

test("payloadReferencesInstrument matches invest payload instrumentId", () => {
  assert.equal(
    payloadReferencesInstrument(
      { tab: "invest", instrumentId: "inst-1", amountMinor: 100 },
      "inst-1"
    ),
    true
  );
  assert.equal(
    payloadReferencesInstrument(
      { tab: "invest", instrumentId: "inst-2", amountMinor: 100 },
      "inst-1"
    ),
    false
  );
  assert.equal(
    payloadReferencesInstrument({ tab: "expense", instrumentId: "inst-1" }, "inst-1"),
    false
  );
});

test("cancelPendingInvestSchedulesForInstruments cancels only matching invest rows", async () => {
  const updates = [];
  const db = {
    pendingTransactionSchedule: {
      findMany: async () => [
        {
          id: "sch-match",
          payload: {
            tab: "invest",
            instrumentId: "dead-instrument",
            amountMinor: 500,
            quantity: 1,
            categoryId: "cat-1",
          },
        },
        {
          id: "sch-other-instrument",
          payload: {
            tab: "invest",
            instrumentId: "live-instrument",
            amountMinor: 500,
            quantity: 1,
            categoryId: "cat-1",
          },
        },
        {
          id: "sch-expense",
          payload: {
            tab: "expense",
            amountMinor: 200,
            categoryId: "cat-2",
          },
        },
      ],
      update: async ({ where, data }) => {
        updates.push({ id: where.id, ...data });
        return { id: where.id };
      },
    },
  };

  const cancelled = await cancelPendingInvestSchedulesForInstruments(db, [
    "dead-instrument",
  ]);

  assert.equal(cancelled, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, "sch-match");
  assert.equal(updates[0].status, "CANCELLED");
  assert.ok(updates[0].cancelledAt instanceof Date);
});

test("cancelPendingInvestSchedulesForInstruments is a no-op for empty ids", async () => {
  let findCalled = false;
  const db = {
    pendingTransactionSchedule: {
      findMany: async () => {
        findCalled = true;
        return [];
      },
      update: async () => {
        throw new Error("should not update");
      },
    },
  };

  const cancelled = await cancelPendingInvestSchedulesForInstruments(db, []);
  assert.equal(cancelled, 0);
  assert.equal(findCalled, false);
});
