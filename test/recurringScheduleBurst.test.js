const assert = require("node:assert/strict");
const test = require("node:test");

const { materializeRecurringUntilBlocked } = require("../src/services/recurringScheduleBurst");

function negativeCashError() {
  const err = new Error("This account is set to prevent cash balance from going below zero");
  err.code = "NEGATIVE_CASH_BALANCE";
  return err;
}

test("recurring catch-up keeps slots that fit and stops on the one that would go negative", async () => {
  const posted = [];
  const start = new Date("2026-01-01T00:00:00.000Z");
  const now = new Date("2026-01-03T00:00:00.000Z");

  const result = await materializeRecurringUntilBlocked({
    startSlot: start,
    now,
    recurrenceUnit: "DAY",
    intervalCount: 1,
    hourOfDay: null,
    maxBurst: 500,
    materialize: async (occurredAt) => {
      if (occurredAt.getTime() >= new Date("2026-01-02T00:00:00.000Z").getTime()) {
        throw negativeCashError();
      }
      posted.push(occurredAt.toISOString());
    },
  });

  assert.deepEqual(posted, ["2026-01-01T00:00:00.000Z"]);
  assert.equal(result.runs, 1);
  assert.equal(result.stoppedForNegativeCash, true);
  assert.equal(result.nextRunAt.toISOString(), "2026-01-02T00:00:00.000Z");
});

test("recurring catch-up posts nothing when the first due slot would go negative", async () => {
  const result = await materializeRecurringUntilBlocked({
    startSlot: new Date("2026-01-01T00:00:00.000Z"),
    now: new Date("2026-01-03T00:00:00.000Z"),
    recurrenceUnit: "DAY",
    intervalCount: 1,
    hourOfDay: null,
    maxBurst: 500,
    materialize: async () => {
      throw negativeCashError();
    },
  });

  assert.equal(result.runs, 0);
  assert.equal(result.stoppedForNegativeCash, true);
  assert.equal(result.nextRunAt.toISOString(), "2026-01-01T00:00:00.000Z");
});

test("recurring catch-up advances past every due slot when cash rules allow them", async () => {
  const posted = [];
  const result = await materializeRecurringUntilBlocked({
    startSlot: new Date("2026-01-01T08:30:00.000Z"),
    now: new Date("2026-01-03T08:30:00.000Z"),
    recurrenceUnit: "DAY",
    intervalCount: 1,
    hourOfDay: null,
    maxBurst: 500,
    materialize: async (occurredAt) => {
      posted.push(occurredAt.toISOString());
    },
  });

  assert.deepEqual(posted, [
    "2026-01-01T08:30:00.000Z",
    "2026-01-02T08:30:00.000Z",
    "2026-01-03T08:30:00.000Z",
  ]);
  assert.equal(result.runs, 3);
  assert.equal(result.stoppedForNegativeCash, false);
  assert.equal(result.nextRunAt.toISOString(), "2026-01-04T08:30:00.000Z");
});

test("recurring catch-up still fails the transaction on errors other than negative cash", async () => {
  await assert.rejects(
    () =>
      materializeRecurringUntilBlocked({
        startSlot: new Date("2026-01-01T00:00:00.000Z"),
        now: new Date("2026-01-02T00:00:00.000Z"),
        recurrenceUnit: "DAY",
        intervalCount: 1,
        hourOfDay: null,
        maxBurst: 500,
        materialize: async () => {
          throw new Error("BAD_CATEGORY");
        },
      }),
    (err) => err instanceof Error && err.message === "BAD_CATEGORY"
  );
});

test("recurring catch-up respects the burst cap", async () => {
  const result = await materializeRecurringUntilBlocked({
    startSlot: new Date("2026-01-01T00:00:00.000Z"),
    now: new Date("2026-04-01T00:00:00.000Z"),
    recurrenceUnit: "DAY",
    intervalCount: 1,
    hourOfDay: null,
    maxBurst: 2,
    materialize: async () => {},
  });

  assert.equal(result.runs, 2);
  assert.equal(result.stoppedForNegativeCash, false);
  assert.equal(result.nextRunAt.toISOString(), "2026-01-03T00:00:00.000Z");
});
