"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");
const path = require("node:path");

const PROCESS_PATH = path.resolve(__dirname, "../src/services/processPendingSchedules.js");
const MATERIALIZE_REQ = "./materializeScheduledPayload";
const PRISMA_REQ = "../prisma";

/**
 * Load processPendingSchedulesForUser with stubbed prisma + materialize.
 * @param {{ materialize: Function, schedules: object[], fresh?: object }} opts
 */
function loadProcessor(opts) {
  const originalLoad = Module._load;
  const scheduleUpdates = [];
  const counters = { materializeCalls: 0 };

  const fresh = opts.fresh ?? opts.schedules[0];

  const prisma = {
    pendingTransactionSchedule: {
      findMany: async () => opts.schedules,
    },
    $transaction: async (fn) =>
      fn({
        pendingTransactionSchedule: {
          findFirst: async () => fresh,
          update: async (args) => {
            scheduleUpdates.push(args);
            return {};
          },
        },
      }),
  };

  Module._load = function loadWithStubs(request, parent, isMain) {
    const fromProcessor = parent?.filename?.endsWith("processPendingSchedules.js");
    if (fromProcessor && request === PRISMA_REQ) return { prisma };
    if (fromProcessor && request === MATERIALIZE_REQ) {
      return {
        materializeScheduledPayload: async (...args) => {
          counters.materializeCalls += 1;
          return opts.materialize(...args);
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const materializePath = require.resolve("../src/services/materializeScheduledPayload.js");
  delete require.cache[materializePath];
  delete require.cache[PROCESS_PATH];
  try {
    const { processPendingSchedulesForUser } = require(PROCESS_PATH);
    return {
      processPendingSchedulesForUser,
      counters,
      scheduleUpdates,
    };
  } finally {
    Module._load = originalLoad;
  }
}

function cashError() {
  const err = new Error("This account is set to prevent cash balance from going below zero");
  err.code = "NEGATIVE_CASH_BALANCE";
  return err;
}

test("recurring catch-up commits partial posts when later slot hits NEGATIVE_CASH_BALANCE", async () => {
  const realNow = Date.now();
  const start = new Date(realNow - 3 * 24 * 60 * 60 * 1000);
  const schedule = {
    id: "sch-1",
    accountId: "acc-1",
    createdByUserId: "user-1",
    kind: "RECURRING",
    status: "PENDING",
    cancelledAt: null,
    recurrenceUnit: "DAY",
    intervalCount: 1,
    hourOfDay: null,
    nextRunAt: start,
    payload: { tab: "expense", amountMinor: 10000, categoryId: "cat-1" },
  };

  let attempts = 0;
  const { processPendingSchedulesForUser, counters, scheduleUpdates } = loadProcessor({
    schedules: [schedule],
    fresh: schedule,
    materialize: async () => {
      attempts += 1;
      // Cash covers the first two daily slots only.
      if (attempts > 2) throw cashError();
      return { kind: "TRANSACTION", id: `tx-${attempts}` };
    },
  });

  await processPendingSchedulesForUser("user-1");

  assert.equal(counters.materializeCalls, 3, "tries third slot then stops on cash guard");
  assert.equal(attempts, 3);
  assert.equal(scheduleUpdates.length, 1, "advances nextRunAt after partial success");
  const updated = scheduleUpdates[0].data.nextRunAt;
  // After 2 successes, nextRunAt is the failing slot (still due).
  assert.ok(updated instanceof Date);
  assert.equal(updated.getTime(), start.getTime() + 2 * 24 * 60 * 60 * 1000);
});

test("recurring catch-up leaves nextRunAt unchanged when the first slot hits NEGATIVE_CASH_BALANCE", async () => {
  const realNow = Date.now();
  const schedule = {
    id: "sch-2",
    accountId: "acc-1",
    createdByUserId: "user-1",
    kind: "RECURRING",
    status: "PENDING",
    cancelledAt: null,
    recurrenceUnit: "DAY",
    intervalCount: 1,
    hourOfDay: null,
    nextRunAt: new Date(realNow - 24 * 60 * 60 * 1000),
    payload: { tab: "expense", amountMinor: 10000, categoryId: "cat-1" },
  };

  const { processPendingSchedulesForUser, counters, scheduleUpdates } = loadProcessor({
    schedules: [schedule],
    fresh: schedule,
    materialize: async () => {
      throw cashError();
    },
  });

  await processPendingSchedulesForUser("user-1");

  assert.equal(counters.materializeCalls, 1);
  assert.equal(scheduleUpdates.length, 0, "no advance when nothing posted");
});
